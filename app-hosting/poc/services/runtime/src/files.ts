import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const BUCKET = process.env.S3_BUCKET || 'local-bucket'
const PREFIX = process.env.S3_PREFIX || 'test/'

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
})

export async function listFiles(): Promise<string[]> {
  const resp = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: `${PREFIX}uploads/`,
    MaxKeys: 100,
  }))
  return (resp.Contents || []).map(c => c.Key!.replace(`${PREFIX}uploads/`, ''))
}

export async function getPresignedUploadUrl(fileName: string): Promise<string> {
  const key = `${PREFIX}uploads/${fileName}`
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 300 })
}

export async function getPresignedDownloadUrl(fileName: string): Promise<string> {
  const key = `${PREFIX}uploads/${fileName}`
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 900 })
}
