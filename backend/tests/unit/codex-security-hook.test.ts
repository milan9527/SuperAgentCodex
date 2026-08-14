import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCodexSecurityHookScript } from '../../src/services/codex/codex-security-hook.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Codex security hook', () => {
  it('blocks destructive commands and allows workspace-local commands', async () => {
    const workspacePath = await createHookWorkspace();

    const blocked = await runHook(workspacePath, {
      cwd: workspacePath,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    expect(blocked).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });

    const allowed = await runHook(workspacePath, {
      cwd: workspacePath,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(allowed).toEqual({});
  });

  it('blocks path and symlink escapes', async () => {
    const workspacePath = await createHookWorkspace();

    const escaped = await runHook(workspacePath, {
      cwd: workspacePath,
      tool_name: 'apply_patch',
      tool_input: { path: '../outside.txt' },
    });
    expect(escaped).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });
});

async function createHookWorkspace(): Promise<string> {
  const workspacePath = join(tmpdir(), `codex-hook-test-${randomUUID()}`);
  tempPaths.push(workspacePath);
  await mkdir(join(workspacePath, '.codex', 'hooks'), { recursive: true });
  await writeFile(
    join(workspacePath, '.codex', 'hooks', 'security-policy.mjs'),
    buildCodexSecurityHookScript(),
    'utf-8',
  );
  return workspacePath;
}

async function runHook(
  workspacePath: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const child = spawn('node', [join(workspacePath, '.codex', 'hooks', 'security-policy.mjs')], {
    cwd: workspacePath,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdin.end(JSON.stringify(input));
  const exitCode = await new Promise<number | null>(resolve => child.once('close', resolve));
  if (exitCode !== 0) throw new Error(stderr || `Hook exited with ${String(exitCode)}`);
  return JSON.parse(stdout || '{}') as Record<string, unknown>;
}
