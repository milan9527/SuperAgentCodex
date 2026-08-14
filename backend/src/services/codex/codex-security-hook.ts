import {
  BINARY_EXTENSIONS,
  DANGEROUS_PATTERNS,
  PATH_ESCAPE_PATTERNS,
} from '../claude-hooks.js';

export function buildCodexSecurityHookScript(): string {
  const dangerous = serializePatterns(DANGEROUS_PATTERNS);
  const pathEscape = serializePatterns(PATH_ESCAPE_PATTERNS);
  const binaryExtensions = JSON.stringify([...BINARY_EXTENSIONS]);

  return `import fs from 'node:fs';
import path from 'node:path';

const dangerousPatterns = ${dangerous};
const pathEscapePatterns = ${pathEscape};
const binaryExtensions = new Set(${binaryExtensions});

const raw = fs.readFileSync(0, 'utf-8');

let input;
try {
  input = JSON.parse(raw);
} catch {
  deny('Security hook received invalid JSON.');
}

const toolInput = input?.tool_input && typeof input.tool_input === 'object'
  ? input.tool_input
  : {};
const command = typeof toolInput.command === 'string' ? toolInput.command : '';

for (const entry of dangerousPatterns) {
  if (new RegExp(entry.source, entry.flags).test(command)) deny(entry.reason);
}
for (const entry of pathEscapePatterns) {
  if (new RegExp(entry.source, entry.flags).test(command)) deny(entry.reason);
}

const cwd = fs.realpathSync(input.cwd);
for (const key of ['file_path', 'path']) {
  const value = toolInput[key];
  if (typeof value !== 'string' || !value) continue;
  const target = path.resolve(cwd, value);
  const rel = path.relative(cwd, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) deny('Path outside workspace is not allowed.');
  const existing = nearestExisting(target);
  const real = fs.realpathSync(existing);
  const realRel = path.relative(cwd, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) deny('Symlink escape outside workspace is not allowed.');

  const ext = path.extname(value).slice(1).toLowerCase();
  if (/read/i.test(input.tool_name ?? '') && binaryExtensions.has(ext)) {
    deny('Binary files cannot be read through a text tool.');
  }
}

if (/skill/i.test(input.tool_name ?? '')) {
  const skillName = typeof toolInput.skill_name === 'string'
    ? toolInput.skill_name
    : typeof toolInput.name === 'string'
      ? toolInput.name
      : null;
  if (skillName) {
    const skillPath = path.resolve(cwd, '.agents', 'skills', skillName);
    const rel = path.relative(path.resolve(cwd, '.agents', 'skills'), skillPath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(skillPath)) {
      deny("Skill '" + skillName + "' is not installed in this workspace.");
    }
  }
}

process.stdout.write('{}');

function nearestExisting(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return input.cwd;
    current = parent;
  }
  return current;
}

function deny(reason) {
  fs.writeFileSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}
`;
}

function serializePatterns(
  patterns: Array<{ pattern: RegExp; reason: string }>,
): string {
  return JSON.stringify(patterns.map(({ pattern, reason }) => ({
    source: pattern.source,
    flags: pattern.flags,
    reason,
  })));
}
