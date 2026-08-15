import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

export interface ResolvedWorkspaceImage {
  path: string;
  mediaType: string;
}

export class AgentImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentImageError';
  }
}

export async function resolveWorkspaceImage(
  workspacePath: string,
  imagePath: string,
  maxBytes: number,
): Promise<ResolvedWorkspaceImage> {
  if (!imagePath || isAbsolute(imagePath)) {
    throw new AgentImageError('AGENT_IMAGE_INVALID', 'Image paths must be workspace-relative');
  }
  const workspaceRoot = await realpath(workspacePath);
  const candidate = await realpath(resolve(workspaceRoot, imagePath)).catch(() => null);
  if (!candidate) {
    throw new AgentImageError(
      'AGENT_IMAGE_NOT_FOUND',
      `Attached image was not found: ${imagePath}`,
    );
  }
  const relativePath = relative(workspaceRoot, candidate);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new AgentImageError(
      'AGENT_IMAGE_FORBIDDEN',
      'Attached image escapes the session workspace',
    );
  }
  const mediaType = IMAGE_MEDIA_TYPES.get(extname(candidate).toLowerCase());
  if (!mediaType) {
    throw new AgentImageError('AGENT_IMAGE_INVALID', `Unsupported image type: ${imagePath}`);
  }
  const file = await stat(candidate);
  if (!file.isFile() || file.size <= 0 || file.size > maxBytes) {
    throw new AgentImageError(
      'AGENT_IMAGE_INVALID',
      `Attached image must be a non-empty file no larger than ${maxBytes} bytes`,
    );
  }
  return { path: candidate, mediaType };
}
