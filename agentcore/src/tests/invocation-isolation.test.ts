import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyScopedEnvironment,
  invocationCodexHome,
  SerializedInvocationGate,
} from '../invocation-isolation.js';

test('serializes access to the shared AgentCore workspace', async () => {
  const gate = new SerializedInvocationGate();
  const releaseFirst = await gate.acquire();
  let secondEntered = false;

  const second = (async () => {
    const releaseSecond = await gate.acquire();
    secondEntered = true;
    releaseSecond();
  })();

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(secondEntered, false);
  releaseFirst();
  await second;
  assert.equal(secondEntered, true);
});

test('isolates Codex homes by organization, scope, and chat session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  try {
    const first = invocationCodexHome({
      prompt: 'a',
      org_id: 'org-a',
      scope_id: 'scope',
      chat_session_id: 'session',
    }, root);
    const same = invocationCodexHome({
      prompt: 'b',
      org_id: 'org-a',
      scope_id: 'scope',
      chat_session_id: 'session',
    }, root);
    const otherTenant = invocationCodexHome({
      prompt: 'c',
      org_id: 'org-b',
      scope_id: 'scope',
      chat_session_id: 'session',
    }, root);

    assert.equal(first, same);
    assert.notEqual(first, otherTenant);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restores invocation-scoped environment values after completion', () => {
  const original = process.env.AGENTCORE_TEST_SECRET;
  process.env.AGENTCORE_TEST_SECRET = 'before';
  const restore = applyScopedEnvironment({
    AGENTCORE_TEST_SECRET: 'during',
    AGENTCORE_TEST_EMPTY: undefined,
  });

  assert.equal(process.env.AGENTCORE_TEST_SECRET, 'during');
  assert.equal(process.env.AGENTCORE_TEST_EMPTY, undefined);
  restore();
  assert.equal(process.env.AGENTCORE_TEST_SECRET, 'before');

  if (original === undefined) delete process.env.AGENTCORE_TEST_SECRET;
  else process.env.AGENTCORE_TEST_SECRET = original;
});
