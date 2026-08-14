#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SuperAgentStack } from '../lib/super-agent-stack';
import { SuperAgentEcsStack } from '../lib/super-agent-ecs-stack';

const app = new cdk.App();

// Context values (pass via -c or cdk.json context):
//   stackName:    Stack name (default: SuperAgent)
//   deployTarget: "ec2" (default) | "ecs" — selects compute backend
//   enableCdn:    "true" to deploy CloudFront + S3 frontend + ACM + Route53
//   domainName:   Custom domain (required when enableCdn=true)
//   hostedZoneId: Route53 hosted zone ID (required when enableCdn=true)
//   authMode:     "cognito" | "local" (default: local)

const stackName = app.node.tryGetContext('stackName') || 'SuperAgent';
const deployTarget = app.node.tryGetContext('deployTarget') || 'ec2';

const stackProps: cdk.StackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
  description: `Super Agent Platform - ${stackName} (${deployTarget})`,
};

if (deployTarget === 'ecs') {
  new SuperAgentEcsStack(app, stackName, stackProps);
} else {
  new SuperAgentStack(app, stackName, stackProps);
}
