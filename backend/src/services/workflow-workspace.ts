/**
 * Workflow Workspace Provisioning
 *
 * Shared utility for loading scope data, agents, skills, and provisioning
 * a workspace for workflow execution. Used by WorkflowExecutorV2.
 *
 * Also provides workspace snapshot/restore for checkpoint pause/resume:
 *   - snapshotWorkspaceToS3: saves workspace state when pausing at a checkpoint
 *   - restoreWorkspaceFromSnapshot: restores workspace state when resuming
 */

import { workspaceManager, type ScopeForWorkspace, type SkillForWorkspace } from './workspace-manager.js';
import { businessScopeService } from './businessScope.service.js';
import { skillService } from './skill.service.js';
import { agentRepository } from '../repositories/agent.repository.js';
import { skillRepository } from '../repositories/skill.repository.js';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, statSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { pipeline } from 'stream/promises';
import { config } from '../config/index.js';

export interface WorkflowWorkspaceResult {
  workspacePath: string;
  /** The session ID used for workspace provisioning (for S3 sync and later retrieval) */
  sessionId: string;
  /** The scope ID used for workspace path construction */
  scopeId: string;
  agents: Array<{ id: string; name: string; displayName: string; role: string | null }>;
  skills: SkillForWorkspace[];
  scopeSkillNames: string[];
}

/**
 * Provision a workspace for workflow execution.
 *
 * Loads scope data, agents with their skills, scope-level skills,
 * and creates a session workspace with all resources available.
 *
 * @param organizationId - Organization ID
 * @param scopeId - Business scope ID
 * @param sessionId - Optional session ID for workspace. If provided, the workspace
 *   can be retrieved later (e.g. using executionId). Defaults to a random UUID.
 */
export async function provisionWorkflowWorkspace(
  organizationId: string,
  scopeId: string,
  sessionId?: string,
): Promise<WorkflowWorkspaceResult> {
  // Load scope
  const scope = await businessScopeService.getBusinessScopeById(scopeId, organizationId);
  if (!scope) throw new Error('Business scope not found');

  // Load agents with skills
  const agents = await agentRepository.findByBusinessScope(organizationId, scopeId);
  const agentSkillsMap = new Map<string, string[]>();
  for (const agent of agents) {
    const agentSkills = await skillRepository.findByAgentId(organizationId, agent.id);
    agentSkillsMap.set(agent.id, agentSkills.map(s => s.name));
  }

  // Load scope-level skills
  const scopeLevelSkills = await skillService.getScopeLevelSkills(organizationId, scopeId);

  // Build combined skills list
  const skillMap = new Map<string, SkillForWorkspace>();
  for (const agent of agents) {
    const agentSkills = await skillRepository.findByAgentId(organizationId, agent.id);
    for (const s of agentSkills) {
      if (!skillMap.has(s.id)) {
        const meta = s.metadata as Record<string, unknown> | null;
        skillMap.set(s.id, {
          id: s.id, name: s.name, hashId: s.hash_id,
          s3Bucket: s.s3_bucket, s3Prefix: s.s3_prefix,
          localPath: meta?.localPath as string | undefined,
          description: s.description ?? (meta?.description as string | undefined),
          body: meta?.body as string | undefined,
        });
      }
    }
  }
  for (const s of scopeLevelSkills) {
    if (!skillMap.has(s.id)) {
      const meta = s.metadata as Record<string, unknown> | null;
      skillMap.set(s.id, {
        id: s.id, name: s.name, hashId: s.hash_id,
        s3Bucket: s.s3_bucket, s3Prefix: s.s3_prefix,
        localPath: meta?.localPath as string | undefined,
        description: s.description ?? (meta?.description as string | undefined),
        body: meta?.body as string | undefined,
      });
    }
  }

  // Provision workspace — use provided sessionId or generate a random one
  const effectiveSessionId = sessionId ?? crypto.randomUUID();
  const scopeForWorkspace: ScopeForWorkspace = {
    id: scope.id,
    name: scope.name,
    description: scope.description,
    systemPrompt: scope.system_prompt ?? null,
    configVersion: scope.config_version ?? 1,
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      displayName: a.display_name,
      role: a.role,
      systemPrompt: a.system_prompt,
      skillNames: agentSkillsMap.get(a.id) || [],
    })),
    skills: Array.from(skillMap.values()),
    mcpServers: [],
    plugins: [],
  };

  const { workspacePath } = await workspaceManager.ensureSessionWorkspace(
    organizationId, effectiveSessionId, scopeForWorkspace, null,
  );

  return {
    workspacePath,
    sessionId: effectiveSessionId,
    scopeId: scope.id,
    agents: agents.map(a => ({ id: a.id, name: a.name, displayName: a.display_name, role: a.role })),
    skills: Array.from(skillMap.values()),
    scopeSkillNames: Array.from(skillMap.values()).map(s => s.name),
  };
}


// ---------------------------------------------------------------------------
// Workspace Snapshot — S3 backup/restore for checkpoint pause/resume
// ---------------------------------------------------------------------------

const S3_REGION = process.env.WORKSPACE_S3_REGION ?? 'us-east-1';
const WORKSPACE_S3_BUCKET = process.env.WORKSPACE_S3_BUCKET ?? config?.agentcore?.workspaceS3Bucket ?? '';

const s3 = new S3Client({ region: S3_REGION });

/** Directories to skip during snapshot (large, auto-generated) */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__',
  '.venv', 'venv', 'env', '.env',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  'bower_components', '.gradle', 'target', '.cargo',
]);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Snapshot the current workspace to S3 for later restoration.
 * Called when a workflow pauses at a checkpoint node.
 *
 * S3 layout: s3://{bucket}/workflow-snapshots/{executionId}/{relativePath}
 *
 * @returns Number of files uploaded
 */
export async function snapshotWorkspaceToS3(
  workspacePath: string,
  executionId: string,
): Promise<number> {
  if (!WORKSPACE_S3_BUCKET) {
    console.warn('[workflow-workspace] No S3 bucket configured, skipping snapshot');
    return 0;
  }

  const prefix = `workflow-snapshots/${executionId}/`;
  let uploaded = 0;

  const files = walkDir(workspacePath);
  console.log(`[workflow-workspace] Snapshotting ${files.length} files to s3://${WORKSPACE_S3_BUCKET}/${prefix}`);

  // Upload in parallel batches (concurrency = 10)
  const CONCURRENCY = 10;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (filePath) => {
      const relativePath = relative(workspacePath, filePath);
      const key = `${prefix}${relativePath}`;
      const fileStat = statSync(filePath);
      await s3.send(new PutObjectCommand({
        Bucket: WORKSPACE_S3_BUCKET,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: fileStat.size,
      }));
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') uploaded++;
    }
  }

  console.log(`[workflow-workspace] Snapshot complete: ${uploaded} files → s3://${WORKSPACE_S3_BUCKET}/${prefix}`);
  return uploaded;
}

/**
 * Restore a workspace snapshot from S3.
 * Called when a workflow resumes after a checkpoint is resolved.
 *
 * Downloads all files from s3://{bucket}/workflow-snapshots/{executionId}/
 * into the provided workspacePath, preserving directory structure.
 *
 * @returns Number of files restored
 */
export async function restoreWorkspaceFromSnapshot(
  workspacePath: string,
  executionId: string,
): Promise<number> {
  if (!WORKSPACE_S3_BUCKET) {
    console.warn('[workflow-workspace] No S3 bucket configured, skipping restore');
    return 0;
  }

  const prefix = `workflow-snapshots/${executionId}/`;

  // List all objects under the snapshot prefix
  const allKeys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: WORKSPACE_S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of result.Contents ?? []) {
      if (obj.Key) allKeys.push(obj.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  if (allKeys.length === 0) {
    console.log(`[workflow-workspace] No snapshot found at s3://${WORKSPACE_S3_BUCKET}/${prefix}`);
    return 0;
  }

  console.log(`[workflow-workspace] Restoring ${allKeys.length} files from snapshot...`);

  let restored = 0;
  // Download in parallel batches
  const CONCURRENCY = 10;
  for (let i = 0; i < allKeys.length; i += CONCURRENCY) {
    const batch = allKeys.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (key) => {
      const relativePath = key.slice(prefix.length);
      if (!relativePath || relativePath.endsWith('/')) return;

      const localPath = join(workspacePath, relativePath);
      mkdirSync(join(localPath, '..'), { recursive: true });

      const response = await s3.send(new GetObjectCommand({
        Bucket: WORKSPACE_S3_BUCKET,
        Key: key,
      }));
      if (response.Body) {
        await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(localPath));
      }
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') restored++;
    }
  }

  console.log(`[workflow-workspace] Restored ${restored}/${allKeys.length} files from snapshot`);
  return restored;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      try {
        const stat = statSync(fullPath);
        if (stat.size <= MAX_FILE_SIZE) {
          results.push(fullPath);
        }
      } catch { /* skip unreadable files */ }
    }
  }
  return results;
}
