import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * SuperAgentEcsStack — ECS Fargate deployment with ALB + CloudFront CDN.
 *
 * Core resources (always created):
 *   VPC (default), Security Groups, ECS Fargate cluster + service + ALB,
 *   RDS PostgreSQL, ElastiCache Redis, S3 buckets, IAM roles.
 *
 * Optional Cognito (authMode=cognito):
 *   User Pool + App Client + initial admin user.
 *
 * Optional CDN layer (enableCdn=true):
 *   S3 frontend bucket, CloudFront distribution, ACM certificate,
 *   Route53 ALIAS record, OAC.
 *
 * Context parameters:
 *   enableCdn     - "true" to deploy CloudFront (default: "false")
 *   domainName    - custom domain, e.g. "app.example.com" (required if enableCdn)
 *   hostedZoneId  - Route53 hosted zone ID (required if enableCdn)
 *   authMode      - "cognito" | "local" (default: "local")
 *   deployTarget  - "ecs" to use this stack (checked in bin/app.ts)
 */
export class SuperAgentEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const enableCdn = this.node.tryGetContext('enableCdn') === 'true';
    const domainName = this.node.tryGetContext('domainName') as string | undefined;
    const hostedZoneId = this.node.tryGetContext('hostedZoneId') as string | undefined;
    const authMode = (this.node.tryGetContext('authMode') as string) || 'local';

    // A custom domain requires both a domainName and a Route53 hostedZoneId.
    // Without them, CloudFront still deploys and serves on its default
    // *.cloudfront.net domain (no ACM certificate / Route53 record needed).
    const useCustomDomain = !!domainName && !!hostedZoneId;
    if ((domainName && !hostedZoneId) || (!domainName && hostedZoneId)) {
      throw new Error('A custom domain requires BOTH domainName and hostedZoneId (or neither, to use the default CloudFront domain)');
    }

    // =========================================================================
    // Parameters
    // =========================================================================
    const allowedCidr = new cdk.CfnParameter(this, 'AllowedCidr', {
      type: 'String',
      default: '0.0.0.0/0',
      description: 'CIDR allowed to access ALB HTTP/HTTPS',
    });

    // =========================================================================
    // VPC
    // =========================================================================
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // =========================================================================
    // Security Groups
    // =========================================================================
    const albSg = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc,
      description: 'Super Agent ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr.valueAsString),
      ec2.Port.tcp(80), 'HTTP',
    );
    albSg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr.valueAsString),
      ec2.Port.tcp(443), 'HTTPS',
    );

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc,
      description: 'Super Agent ECS tasks',
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'Backend from ALB');

    const dbSg = new ec2.SecurityGroup(this, 'DBSG', {
      vpc,
      description: 'RDS PostgreSQL',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), 'PostgreSQL from ECS');

    const redisSg = new ec2.SecurityGroup(this, 'RedisSG', {
      vpc,
      description: 'ElastiCache Redis',
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(ecsSg, ec2.Port.tcp(6379), 'Redis from ECS');

    // =========================================================================
    // RDS PostgreSQL
    // =========================================================================
    // Engine versions are resolved at deploy time from what RDS/ElastiCache
    // actually offer in the target region (the deploy script discovers them and
    // passes them via context). A specific version isn't available in every
    // region, so we never hardcode one. Fallbacks are used for bare `cdk deploy`.
    const dbEngineVersion = (this.node.tryGetContext('dbEngineVersion') as string) || '16.9';
    const redisEngineVersion = (this.node.tryGetContext('redisEngineVersion') as string) || '7.1';

    const dbInstance = new rds.DatabaseInstance(this, 'SuperAgentDB', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of(dbEngineVersion, dbEngineVersion.split('.')[0]!),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSg],
      databaseName: 'super_agent',
      credentials: rds.Credentials.fromGeneratedSecret('superagent', {
        secretName: `${id}/db-credentials`,
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // =========================================================================
    // ElastiCache Redis
    // =========================================================================
    const redisSubnetGroup = new cdk.aws_elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnets for ElastiCache Redis',
      subnetIds: vpc.publicSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: `${id}-redis-subnets`.toLowerCase(),
    });

    const redisMajorVersion = Number.parseInt(redisEngineVersion.split('.')[0]!, 10);
    const redisParameterGroupFamily = redisMajorVersion >= 7
      ? `redis${redisMajorVersion}`
      : `redis${redisMajorVersion}.x`;
    const redisParameterGroup = new cdk.aws_elasticache.CfnParameterGroup(
      this,
      'RedisParameterGroup',
      {
        cacheParameterGroupFamily: redisParameterGroupFamily,
        description: 'Super Agent Redis parameters for durable BullMQ queues',
        properties: {
          'maxmemory-policy': 'noeviction',
        },
      },
    );

    const redisCluster = new cdk.aws_elasticache.CfnCacheCluster(this, 'RedisCluster', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      clusterName: `${id}-redis`.toLowerCase(),
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      cacheParameterGroupName: redisParameterGroup.ref,
      engineVersion: redisEngineVersion,
      port: 6379,
    });
    redisCluster.addResourceDependency(redisSubnetGroup);
    redisCluster.addResourceDependency(redisParameterGroup);

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    const bucketPrefix = id.toLowerCase();

    const avatarBucket = new s3.Bucket(this, 'AvatarBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const skillsBucket = new s3.Bucket(this, 'SkillsBucket', {
      bucketName: `${bucketPrefix}-skills-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const workspaceBucket = new s3.Bucket(this, 'WorkspaceBucket', {
      bucketName: `${bucketPrefix}-workspace-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    // =========================================================================
    // IAM Roles for ECS
    // =========================================================================

    // Task Execution Role (used by ECS agent to pull images, push logs)
    const taskExecRole = new iam.Role(this, 'EcsTaskExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Allow pulling from ECR and creating log groups
    taskExecRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/super-agent/*`],
    }));

    // Task Role (used by the application container at runtime)
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Bedrock model invocation + discovery. ListInferenceProfiles/
    // ListFoundationModels back the Settings → Models "add Bedrock provider"
    // picker; without them the model list silently comes back empty.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:ListInferenceProfiles',
        'bedrock:ListFoundationModels',
        'bedrock-mantle:CreateInference',
      ],
      resources: ['*'],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // Secrets Manager (for DB credentials)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [dbInstance.secret!.secretArn, `${dbInstance.secret!.secretArn}*`],
    }));

    // CloudWatch Logs
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/super-agent/*`],
    }));

    // AgentCore invoke permission.
    // InvokeAgentRuntime      — run the agent conversation.
    // InvokeAgentRuntimeCommand — run shell commands (find/cat) inside the live
    //   microVM; used by agentCoreCommandService to list/read the workspace file
    //   tree. Without it, the workspace file panel can't read files from an
    //   active session's container (it errors and falls back to the S3 snapshot).
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:InvokeAgentRuntimeCommand',
      ],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
    }));

    // S3 bucket access
    avatarBucket.grantReadWrite(taskRole);
    skillsBucket.grantReadWrite(taskRole);
    workspaceBucket.grantReadWrite(taskRole);

    // =========================================================================
    // ECS Cluster + Fargate Service + ALB
    // =========================================================================
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: `${id}-cluster`.toLowerCase(),
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // CloudWatch log group for backend container
    const backendLogGroup = new logs.LogGroup(this, 'BackendLogGroup', {
      logGroupName: `/super-agent/${id.toLowerCase()}/ecs-backend`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task definition (placeholder image — deploy script updates this)
    const taskFamily = `${id}-backend`.toLowerCase();
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BackendTaskDef', {
      family: taskFamily,
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole: taskExecRole,
      taskRole,
    });

    taskDefinition.addContainer('backend', {
      // Placeholder image — replaced by deploy script on first deploy
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:20-alpine'),
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: backendLogGroup,
        streamPrefix: 'backend',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        PORT: '3000',
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
      },
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      loadBalancerName: `${id}-alb`.toLowerCase().substring(0, 32),
    });

    // Target group for backend
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'BackendTG', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Enable stickiness for WebSocket connections
      stickinessCookieDuration: cdk.Duration.hours(1),
    });

    // HTTP listener (port 80) — used by CloudFront as origin
    alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ECS Fargate Service
    // desiredCount=0 on initial deploy (placeholder image has no /health endpoint).
    // The deploy script registers the real task definition and scales to 1.
    const service = new ecs.FargateService(this, 'BackendService', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      securityGroups: [ecsSg],
      assignPublicIp: true, // Required for public subnets (default VPC)
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      serviceName: `${id}-backend-svc`.toLowerCase(),
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true, // Allows `aws ecs execute-command` for debugging
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    service.attachToApplicationTargetGroup(targetGroup);

    // =========================================================================
    // Optional: Cognito (authMode=cognito)
    // =========================================================================
    let userPool: cognito.UserPool | undefined;
    let appClient: cognito.UserPoolClient | undefined;
    let cognitoDomainFull: string | undefined;

    if (authMode === 'cognito') {
      const adminEmail = new cdk.CfnParameter(this, 'AdminEmail', {
        type: 'String',
        default: 'admin@example.com',
        description: 'Initial admin email',
      });
      const cognitoDomainPrefix = new cdk.CfnParameter(this, 'CognitoDomainPrefix', {
        type: 'String',
        default: `${id.toLowerCase()}-auth`,
        description: 'Cognito hosted UI domain prefix',
      });
      userPool = new cognito.UserPool(this, 'SuperAgentUserPool', {
        userPoolName: 'super-agent-users',
        selfSignUpEnabled: false,
        signInAliases: { email: true },
        autoVerify: { email: true },
        standardAttributes: {
          email: { required: true, mutable: true },
          fullname: { required: false, mutable: true },
        },
        customAttributes: {
          orgId: new cognito.StringAttribute({ mutable: true }),
          role: new cognito.StringAttribute({ mutable: true }),
        },
        passwordPolicy: {
          minLength: 8, requireLowercase: true, requireUppercase: true,
          requireDigits: true, requireSymbols: false,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      userPool.addDomain('CognitoDomain', {
        cognitoDomain: { domainPrefix: cognitoDomainPrefix.valueAsString },
      });

      appClient = userPool.addClient('SuperAgentAppClient', {
        userPoolClientName: 'super-agent-web',
        generateSecret: false,
        authFlows: { userSrp: true },
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls: ['http://localhost:5173/auth/callback'],
          logoutUrls: ['http://localhost:5173/login'],
        },
        preventUserExistenceErrors: true,
      });

      new cognito.CfnUserPoolUser(this, 'AdminUser', {
        userPoolId: userPool.userPoolId,
        username: adminEmail.valueAsString,
        userAttributes: [
          { name: 'email', value: adminEmail.valueAsString },
          { name: 'email_verified', value: 'true' },
        ],
        desiredDeliveryMediums: ['EMAIL'],
      });

      cognitoDomainFull = `${cognitoDomainPrefix.valueAsString}.auth.${this.region}.amazoncognito.com`;

      taskRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:UpdateUserPoolClient', 'cognito-idp:DescribeUserPoolClient'],
        resources: [userPool.userPoolArn],
      }));
    }

    // =========================================================================
    // Optional: CloudFront CDN (enableCdn=true)
    // =========================================================================
    let frontendBucket: s3.Bucket | undefined;
    let distribution: cloudfront.Distribution | undefined;

    if (enableCdn) {
      // S3 bucket for frontend static files
      frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
      });
      frontendBucket.grantReadWrite(taskRole);

      // Custom domain (optional): ACM certificate + Route53 hosted zone.
      // When no custom domain is provided, CloudFront serves on its default
      // *.cloudfront.net domain and neither ACM nor Route53 is used.
      let hostedZone: route53.IHostedZone | undefined;
      let certificate: acm.ICertificate | undefined;
      if (useCustomDomain) {
        hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: hostedZoneId!,
          zoneName: domainName!.split('.').slice(1).join('.'),
        });

        certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
          domainName: domainName!,
          hostedZone,
          region: 'us-east-1', // CloudFront requires us-east-1
        });
      }

      // OAC for S3
      new cloudfront.CfnOriginAccessControl(this, 'OAC', {
        originAccessControlConfig: {
          name: `${id}-oac`,
          originAccessControlOriginType: 's3',
          signingBehavior: 'always',
          signingProtocol: 'sigv4',
        },
      });

      // CloudFront distribution — S3 for static, ALB for API/WS
      // Use ALB DNS as the API origin (deploy script updates placeholder if needed)
      const albOrigin = new origins.HttpOrigin(alb.loadBalancerDnsName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        httpPort: 80,
      });

      distribution = new cloudfront.Distribution(this, 'CDN', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        // Only bind a custom domain + ACM cert when one was provided; otherwise
        // CloudFront uses its default *.cloudfront.net domain and cert.
        ...(useCustomDomain ? { domainNames: [domainName!], certificate } : {}),
        defaultRootObject: 'index.html',
        errorResponses: [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        ],
      });

      // /api/* → ALB (no caching, pass all headers)
      distribution.addBehavior('/api/*', albOrigin, {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      });

      // /ws/* → ALB (WebSocket upgrade needs all headers forwarded)
      distribution.addBehavior('/ws/*', albOrigin, {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      });

      // /v1/* → ALB (OpenAI/Anthropic-compatible LLM proxy; the AgentCore
      // container calls /v1/messages here to run non-Anthropic Bedrock models).
      distribution.addBehavior('/v1/*', albOrigin, {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      });

      // Route53 ALIAS → CloudFront (only for a custom domain)
      if (useCustomDomain) {
        new route53.ARecord(this, 'DnsAlias', {
          zone: hostedZone!,
          recordName: domainName!,
          target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
        });
      }
    }

    // =========================================================================
    // Outputs — Core
    // =========================================================================
    new cdk.CfnOutput(this, 'DBEndpoint', { value: dbInstance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DBSecretArn', { value: dbInstance.secret!.secretArn });
    new cdk.CfnOutput(this, 'AvatarBucketName', { value: avatarBucket.bucketName });
    new cdk.CfnOutput(this, 'SkillsBucketName', { value: skillsBucket.bucketName });
    new cdk.CfnOutput(this, 'WorkspaceBucketName', { value: workspaceBucket.bucketName });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: redisCluster.attrRedisEndpointAddress });
    new cdk.CfnOutput(this, 'RedisPort', { value: redisCluster.attrRedisEndpointPort });
    new cdk.CfnOutput(this, 'AuthMode', { value: authMode });
    new cdk.CfnOutput(this, 'EnableCdn', { value: enableCdn ? 'true' : 'false' });

    // Outputs — ECS
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'EcsServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'EcsTaskFamily', { value: taskFamily });
    new cdk.CfnOutput(this, 'EcsTaskExecRoleArn', { value: taskExecRole.roleArn });
    new cdk.CfnOutput(this, 'EcsTaskRoleArn', { value: taskRole.roleArn });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbArn', { value: alb.loadBalancerArn });
    new cdk.CfnOutput(this, 'EcsSubnets', {
      value: vpc.publicSubnets.map(s => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'EcsSecurityGroup', { value: ecsSg.securityGroupId });

    // Outputs — Cognito (only when authMode=cognito)
    if (userPool && appClient && cognitoDomainFull) {
      new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
      new cdk.CfnOutput(this, 'CognitoClientId', { value: appClient.userPoolClientId });
      new cdk.CfnOutput(this, 'CognitoDomainUrl', { value: cognitoDomainFull });
    }

    // Outputs — CDN (only when enableCdn=true)
    if (frontendBucket) {
      new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
    }
    if (distribution) {
      new cdk.CfnOutput(this, 'CloudFrontDistributionId', { value: distribution.distributionId });
      new cdk.CfnOutput(this, 'CloudFrontDomainName', { value: distribution.distributionDomainName });
    }
    if (domainName) {
      new cdk.CfnOutput(this, 'DomainName', { value: domainName });
    }
  }
}
