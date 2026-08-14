import { FastifyInstance } from 'fastify';
import { avatarService } from '../services/avatarService.js';
import { authenticate } from '../middleware/auth.js';
import sharp from 'sharp';

export async function avatarRoutes(fastify: FastifyInstance) {
  // multipart is registered globally in app.ts

  // Upload avatar photo (user-provided image)
  fastify.post('/avatars/upload', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(data.mimetype)) {
      return reply.code(400).send({ error: 'Invalid file type. Allowed: PNG, JPEG, WebP, GIF' });
    }

    const buffer = await data.toBuffer();

    // Compress: resize to 128x128 and convert to WebP
    const compressedBuffer = await sharp(buffer)
      .resize(128, 128, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();

    const filename = `avatars/${Date.now()}-${Math.random().toString(36).substring(2)}.webp`;

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const bucket = process.env.S3_AVATARS_BUCKET || process.env.S3_BUCKET_NAME || 'super-agent-avatars';

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: filename,
      Body: compressedBuffer,
      ContentType: 'image/webp',
    }));

    return reply.send({ avatarKey: filename });
  });

  // Generate avatar image
  fastify.post('/avatars/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['role'],
        properties: {
          role: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { role, description } = request.body as { role: string; description?: string };
    
    fastify.log.info({ role, description }, 'Avatar generation request');
    
    // Check if avatar generation is enabled
    const enableAvatarGeneration = process.env.ENABLE_AVATAR_GENERATION === 'true';
    
    if (!enableAvatarGeneration) {
      fastify.log.warn('Avatar generation is disabled');
      return reply.code(400).send({ error: 'Avatar generation is disabled' });
    }

    try {
      const prompt = avatarService.generateAvatarPrompt(role, description);
      fastify.log.info({ prompt }, 'Generated avatar prompt');
      
      const avatarKey = await avatarService.generateAvatar(prompt);
      
      fastify.log.info({ avatarKey }, 'Avatar generation successful');
      return { avatarKey };
    } catch (err) {
      const error = err as Error & { code?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
      fastify.log.error({
        error: error.message,
        code: error.code,
        statusCode: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        role,
        description
      }, 'Avatar generation failed');
      return reply.code(500).send({ error: 'Avatar generation failed' });
    }
  });

  // Generate multiple avatars in parallel (batch)
  fastify.post('/avatars/generate-batch', {
    schema: {
      body: {
        type: 'object',
        required: ['roles'],
        properties: {
          roles: { 
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 10
          }
        }
      }
    }
  }, async (request, reply) => {
    const { roles } = request.body as { roles: string[] };
    
    fastify.log.info({ roleCount: roles.length, roles }, 'Batch avatar generation request');
    
    // Check if avatar generation is enabled
    const enableAvatarGeneration = process.env.ENABLE_AVATAR_GENERATION === 'true';
    
    if (!enableAvatarGeneration) {
      fastify.log.warn('Avatar generation is disabled');
      return reply.code(400).send({ error: 'Avatar generation is disabled' });
    }

    try {
      // Generate all avatars in parallel
      const results = await avatarService.generateAvatarsBatch(roles);
      
      const successCount = results.filter(r => r.avatarKey !== null).length;
      fastify.log.info({
        successCount, 
        totalCount: roles.length 
      }, 'Batch avatar generation complete');
      
      return { results };
    } catch (err) {
      const error = err as Error;
      fastify.log.error({ error: error.message }, 'Batch avatar generation failed');
      return reply.code(500).send({ error: 'Batch avatar generation failed' });
    }
  });

  // Get presigned URL for an avatar (preferred over proxy)
  fastify.get('/avatars/presign/:key', {
    preHandler: [authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const s3Key = key.startsWith('avatars/') ? key : `avatars/${key}`;

    try {
      const presignedUrl = await avatarService.getAvatarUrl(s3Key);
      reply.header('Cache-Control', 'private, max-age=3000'); // cache ~50 min (URL valid 1h)
      return reply.send({ url: presignedUrl });
    } catch (err) {
      const error = err as Error;
      return reply.code(404).send({ error: 'Avatar not found', details: error.message });
    }
  });

  // Get avatar image via backend proxy (deprecated — use /avatars/presign/:key instead)
  // Supports both /avatars/:key and /avatars/avatars/:key patterns
  fastify.get('/avatars/*', {
    schema: {
      params: {
        type: 'object',
        required: ['*'],
        properties: {
          '*': { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const params = request.params as { '*': string };
    let key = params['*'];
    
    fastify.log.info({ rawKey: key }, 'Avatar retrieval - raw key from URL');
    
    // Normalize the key - remove any leading 'avatars/' prefixes, then add exactly one
    // This handles /avatars/123.png, /avatars/avatars/123.png, etc.
    while (key.startsWith('avatars/')) {
      key = key.substring('avatars/'.length);
    }
    key = `avatars/${key}`;
    
    fastify.log.info({ key }, 'Avatar retrieval - final S3 key');
    
    try {
      // Get the image data directly from S3 and stream it
      const imageData = await avatarService.getAvatarData(key);
      
      // Detect content type from file extension
      const contentType = key.endsWith('.webp') ? 'image/webp' : 'image/png';
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      return reply.send(imageData);
    } catch (err) {
      const error = err as Error;
      fastify.log.error({ key, error: error.message }, 'Avatar retrieval failed');
      return reply.code(404).send({ error: 'Avatar not found', details: error.message });
    }
  });
}
