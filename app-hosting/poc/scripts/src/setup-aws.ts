/**
 * Create S3 buckets and IAM roles in Floci for each tenant.
 * Each tenant gets one S3 bucket; each app gets a prefix within that bucket.
 */

import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  GetRoleCommand,
} from '@aws-sdk/client-iam'

const ENDPOINT = process.env.AWS_ENDPOINT_URL || 'http://localhost:4566'
const REGION = 'us-east-1'
const CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' }

const s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: CREDENTIALS, forcePathStyle: true })
const iam = new IAMClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDENTIALS })

interface Tenant {
  name: string
  orgShortId: string
  bucketName: string
  apps: Array<{ appId: string; shortId: string }>
}

const TENANTS: Tenant[] = [
  {
    name: 'alpha',
    orgShortId: 'a1b2c3d4e5f6',
    bucketName: 'app-host-alpha-a1b2c3d4e5f6',
    apps: [{ appId: '550e8400-e29b-41d4-a716-446655440000', shortId: '550e8400e29b' }],
  },
  {
    name: 'beta',
    orgShortId: '7a8b9c0d1e2f',
    bucketName: 'app-host-beta-7a8b9c0d1e2f',
    apps: [{ appId: '4d5e6f7a-8b9c-0d1e-2f3a-4b5c6d7e8f90', shortId: '4d5e6f7a8b9c' }],
  },
  {
    name: 'gamma',
    orgShortId: '3a4b5c6d7e8f',
    bucketName: 'app-host-gamma-3a4b5c6d7e8f',
    apps: [{ appId: '9a0b1c2d-3e4f-5a6b-7c8d-333333333333', shortId: '9a0b1c2d3e4f' }],
  },
]

async function ensureBucket(bucketName: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }))
    console.log(`  Bucket ${bucketName} already exists`)
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucketName }))
    console.log(`  Created bucket: ${bucketName}`)
  }
}

async function ensureRole(tenant: Tenant) {
  const roleName = `app-runtime-${tenant.name}`

  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }))
    console.log(`  Role ${roleName} already exists`)
  } catch {
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'pods.eks.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      }),
    }))
    console.log(`  Created role: ${roleName}`)
  }

  // Grant access to the tenant's bucket only
  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: `S3Access-${tenant.name}`,
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          Resource: [`arn:aws:s3:::${tenant.bucketName}/*`],
        },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [`arn:aws:s3:::${tenant.bucketName}`],
        },
      ],
    }),
  }))
  console.log(`  Policy attached to ${roleName}`)
}

async function main() {
  console.log('=== Setting up Floci AWS resources ===\n')

  for (const tenant of TENANTS) {
    console.log(`[${tenant.name}]`)
    await ensureBucket(tenant.bucketName)
    await ensureRole(tenant)
    console.log()
  }

  console.log('Done. AWS resources ready.')
  console.log('\nBuckets:')
  for (const t of TENANTS) {
    console.log(`  ${t.bucketName}`)
  }
  console.log('\nIAM Roles:')
  for (const t of TENANTS) {
    console.log(`  app-runtime-${t.name}`)
  }
}

main().catch(err => {
  console.error('Setup failed:', err)
  process.exit(1)
})
