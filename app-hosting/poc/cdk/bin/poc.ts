#!/usr/bin/env npx ts-node
import * as cdk from 'aws-cdk-lib'
import { AppHostPocStack } from '../lib/poc-stack'

const app = new cdk.App()

new AppHostPocStack(app, 'AppHostPocStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  tenants: [
    { id: 'a1b2c3d4e5f6', name: 'alpha', displayName: 'Tenant A' },
    { id: '7a8b9c0d1e2f', name: 'beta', displayName: 'Tenant B' },
    { id: '3a4b5c6d7e8f', name: 'gamma', displayName: 'Tenant C' },
  ],
})

app.synth()
