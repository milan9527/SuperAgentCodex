import * as cdk from 'aws-cdk-lib'
import * as eks from 'aws-cdk-lib/aws-eks'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as kms from 'aws-cdk-lib/aws-kms'
import { Construct } from 'constructs'

export interface TenantConfig {
  id: string
  name: string
  displayName: string
}

export interface AppHostPocStackProps extends cdk.StackProps {
  tenants: TenantConfig[]
}

export class AppHostPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppHostPocStackProps) {
    super(scope, id, props)

    // === VPC ===
    const vpc = new ec2.Vpc(this, 'AppHostVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    })

    // === EKS Cluster ===
    const cluster = new eks.Cluster(this, 'AppHostCluster', {
      vpc,
      version: eks.KubernetesVersion.V1_30,
      clusterName: 'app-host-poc',
      defaultCapacity: 2,
      defaultCapacityInstance: new ec2.InstanceType('t3.medium'),
      albController: { enabled: true },
    })

    // === KMS Key for tenant data encryption ===
    const encryptionKey = new kms.Key(this, 'TenantDataKey', {
      alias: 'app-host-tenant-data',
      description: 'Encryption key for tenant data at rest',
    })

    // === Per-tenant S3 buckets + IAM ===
    for (const tenant of props.tenants) {
      this.createTenantInfrastructure(cluster, encryptionKey, tenant)
    }

    // === Outputs ===
    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'EKS cluster name',
    })

    new cdk.CfnOutput(this, 'KubeConfigCommand', {
      value: `aws eks update-kubeconfig --name ${cluster.clusterName} --region ${this.region}`,
      description: 'Command to get kubeconfig',
    })
  }

  private createTenantInfrastructure(
    cluster: eks.Cluster,
    encryptionKey: kms.Key,
    tenant: TenantConfig,
  ) {
    const { id, name } = tenant

    // S3 bucket per tenant
    const bucket = new s3.Bucket(this, `Bucket-${name}`, {
      bucketName: `app-host-${name}-${id}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    })

    // IAM policy scoped to tenant's bucket only
    const tenantPolicy = new iam.Policy(this, `Policy-${name}`, {
      policyName: `app-host-tenant-${name}`,
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [`${bucket.bucketArn}/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:ListBucket'],
          resources: [bucket.bucketArn],
          conditions: {
            StringLike: { 's3:prefix': ['*'] },
          },
        }),
      ],
    })

    // IAM role for tenant's app runtime pods (IRSA)
    const runtimeRole = new iam.Role(this, `RuntimeRole-${name}`, {
      roleName: `app-host-runtime-${name}`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('pods.eks.amazonaws.com'),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
      ],
    })
    runtimeRole.attachInlinePolicy(
      new iam.Policy(this, `RuntimeS3Policy-${name}`, {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            resources: [`${bucket.bucketArn}/*`],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:ListBucket'],
            resources: [bucket.bucketArn],
          }),
        ],
      })
    )

    // Enable IRSA on the cluster for this tenant
    cluster.addManifest(`namespace-${name}`, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name },
    })

    // ServiceAccount for tenant's app runtime
    const serviceAccount = cluster.addServiceAccount(`runtime-sa-${name}`, {
      name: 'app-runtime',
      namespace: name,
      role: runtimeRole,
    })

    new cdk.CfnOutput(this, `Bucket-${name}`, {
      value: bucket.bucketName,
      description: `S3 bucket for ${tenant.displayName}`,
    })

    new cdk.CfnOutput(this, `RuntimeRole-${name}`, {
      value: runtimeRole.roleArn,
      description: `IAM role ARN for ${tenant.displayName} runtime pods`,
    })
  }
}
