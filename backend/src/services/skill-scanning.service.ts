/**
 * Skill Scanning Service
 *
 * Agent-based security, compliance, compatibility, and license analysis
 * for skills installed from external sources (marketplace, GitHub, zip upload).
 *
 * Uses the same workspace + agent pattern as scope-generator:
 *   1. Create temp workspace with skill files
 *   2. Run agent conversation (claude or agentcore mode)
 *   3. Agent explores files with Read/Bash/Grep tools
 *   4. Agent writes structured scan results to scan-results.json
 *   5. Parse results and persist to DB
 *
 * Scans run asynchronously (fire-and-forget) so they never block installation.
 */

import { mkdtemp, writeFile, readFile, cp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { prisma } from '../config/database.js';
import { agentRuntime } from './agent-runtime-factory.js';
import { config } from '../config/index.js';
import type { AgentConfig } from './agent-runtime.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScanType = 'security' | 'compliance' | 'compatibility' | 'license';
export type ScanStatus = 'pending' | 'running' | 'passed' | 'warning' | 'failed';

export interface ScanFinding {
  check: string;
  passed: boolean;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  detail: string;
}

export interface ScanResult {
  id: string;
  skill_id: string;
  scan_type: ScanType;
  status: ScanStatus;
  score: number;
  findings: ScanFinding[];
  summary: string | null;
  scanned_at: Date;
}

export const ALL_SCAN_TYPES: ScanType[] = ['security', 'compliance', 'compatibility', 'license'];

// ─── System Prompt ───────────────────────────────────────────────────────────

function buildScanSystemPrompt(scanTypes: ScanType[]): string {
  const typeDescriptions: Record<ScanType, string> = {
    security: `**Security**: Input validation, authentication, encryption, hardcoded secrets, injection risks (SQL/command/XSS), unsafe patterns (eval, exec, subprocess with shell=True, pickle.loads), dependency vulnerabilities, error handling that leaks info.`,
    compliance: `**Compliance**: GDPR data handling and consent, SOC2 audit logging, HIPAA PHI safeguards, PCI-DSS payment data controls, data retention/cleanup, privacy practices, role-based access control.`,
    compatibility: `**Compatibility**: Protocol version currency (MCP/A2A), schema validation, API version specs, runtime requirements (Python/Node versions), dependency conflicts, platform/OS requirements.`,
    license: `**License**: License type identification, enterprise/commercial compatibility, copyleft risk (GPL), attribution requirements, dependency license conflicts, export control concerns.`,
  };

  const dimensions = scanTypes.map(t => typeDescriptions[t]).join('\n\n');

  return `You are an enterprise security scanner for AI agent skills, MCP servers, and A2A agents.

Your task is to thoroughly analyze the skill files in your working directory and produce a structured security assessment.

## Instructions

1. First, explore the working directory to understand the skill structure. List all files, read key files (SKILL.md, README.md, package.json, requirements.txt, source code files, configuration files, etc.).
2. For each scan dimension below, analyze the ACTUAL file contents — not hypothetical issues. Be thorough but fair.
3. Use your tools actively:
   - \`Read\` to examine file contents
   - \`Bash\` to run checks like \`grep -r "eval\\|exec\\|subprocess" .\`, \`cat package.json\`, \`find . -name "*.py" -o -name "*.ts" -o -name "*.js"\`, etc.
   - \`Grep\` to search for patterns like hardcoded secrets, API keys, unsafe imports
4. After your analysis, write the results to "scan-results.json" in the working directory.

## Scan Dimensions

${dimensions}

## Output Format

Write a JSON file "scan-results.json" with this exact structure:

\`\`\`json
{
  "scans": {
${scanTypes.map(t => `    "${t}": {
      "score": 0-100,
      "summary": "one line summary of findings",
      "checks": [
        {"check": "check name", "passed": true/false, "severity": "info|low|medium|high|critical", "detail": "specific explanation referencing actual file content"}
      ]
    }`).join(',\n')}
  }
}
\`\`\`

## Scoring Guide
- 80-100: No significant issues found
- 60-79: Minor issues, generally safe
- 40-59: Notable concerns that should be reviewed
- 0-39: Serious issues found

Be specific in your findings. Reference actual file names, line numbers, and code snippets when possible. Do NOT fabricate issues — only report what you actually find in the files.`;
}

// ─── Result Parsing ──────────────────────────────────────────────────────────

interface RawScanOutput {
  scans: Record<string, {
    score: number;
    summary: string;
    checks: Array<{
      check: string;
      passed: boolean;
      severity: string;
      detail: string;
    }>;
  }>;
}

function parseAndValidateScanResults(raw: string): RawScanOutput | null {
  try {
    let jsonStr = raw.trim();

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    // Find JSON object boundaries
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);
    if (!parsed.scans || typeof parsed.scans !== 'object') {
      console.warn('[skill-scanning] Invalid scan results: missing "scans" key');
      return null;
    }

    return parsed as RawScanOutput;
  } catch (err) {
    console.warn('[skill-scanning] Failed to parse scan results JSON:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Extract scan results JSON from conversation text blocks (fallback when
 * the agent doesn't write the file or S3 sync hasn't completed).
 */
function extractResultsFromText(textBlocks: string[]): RawScanOutput | null {
  const fullText = textBlocks.join('');

  // Look for JSON with "scans" key
  const patterns = [
    /```json\s*([\s\S]*?)```/g,
    /\{[\s\S]*"scans"\s*:\s*\{[\s\S]*\}/g,
  ];

  for (const pattern of patterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      const candidate = match[1] || match[0];
      const result = parseAndValidateScanResults(candidate);
      if (result) return result;
    }
  }

  return null;
}

// ─── Core Scan Logic ─────────────────────────────────────────────────────────

/**
 * Run agent-based scan on a skill. Creates a workspace, copies skill files,
 * runs an agent conversation, and parses the results.
 */
export async function scanSkill(
  skillId: string,
  scanTypes: ScanType[] = ALL_SCAN_TYPES,
): Promise<ScanResult[]> {
  // Load skill metadata
  const skill = await prisma.skills.findUnique({
    where: { id: skillId },
    select: {
      id: true,
      name: true,
      description: true,
      version: true,
      skill_type: true,
      metadata: true,
    },
  });

  if (!skill) {
    console.warn(`[skill-scanning] Skill ${skillId} not found`);
    return [];
  }

  const metadata = (skill.metadata as Record<string, unknown>) || {};
  const localPath = metadata.localPath as string | undefined;

  // Create temp workspace and copy skill files into it
  const tempWorkspace = await mkdtemp(join(tmpdir(), 'skill-scan-'));
  const skillDir = join(tempWorkspace, 'skill');

  try {
    if (localPath && existsSync(localPath)) {
      // Copy the entire skill directory
      await cp(localPath, skillDir, { recursive: true });
    } else {
      // No local files — create a minimal context file for the agent
      const { mkdir } = await import('fs/promises');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL_INFO.md'), [
        `# ${skill.name}`,
        '',
        `**Type:** ${skill.skill_type}`,
        `**Version:** ${skill.version}`,
        '',
        skill.description || 'No description available.',
        '',
        '## Metadata',
        '```json',
        JSON.stringify(metadata, null, 2),
        '```',
      ].join('\n'), 'utf-8');
    }

    // Build agent config
    const agentConfig: AgentConfig = {
      id: 'skill-scanner',
      name: 'skill-scanner',
      displayName: 'Skill Security Scanner',
      organizationId: 'system',
      systemPrompt: buildScanSystemPrompt(scanTypes),
      skillIds: [],
      mcpServerIds: [],
    };

    const sessionId = `skill-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const message = [
      `Scan the skill files in the "skill" subdirectory of your working directory.`,
      ``,
      `Skill name: ${skill.name}`,
      `Skill type: ${skill.skill_type}`,
      `Version: ${skill.version}`,
      skill.description ? `Description: ${skill.description}` : '',
      ``,
      `Explore all files in the "skill" directory, analyze them thoroughly, then write your findings to "scan-results.json" in the working directory root (NOT inside the skill subdirectory).`,
    ].filter(Boolean).join('\n');

    // Run agent conversation and collect text output
    const allTextBlocks: string[] = [];

    console.log(`[skill-scanning] Starting agent scan for "${skill.name}" (session: ${sessionId})`);

    for await (const event of agentRuntime.runConversation(
      {
        agentId: 'skill-scanner',
        sessionId,
        message,
        organizationId: 'system',
        userId: 'system',
        workspacePath: tempWorkspace,
        scopeId: 'system',
      },
      agentConfig,
      [], // no skills needed for scanning
    )) {
      // Collect text blocks for fallback extraction
      if ((event.type === 'assistant' || event.type === 'result') && event.content) {
        for (const block of event.content) {
          if (block.type === 'text' && 'text' in block) {
            allTextBlocks.push((block as { type: 'text'; text: string }).text);
          }
          if (block.type === 'tool_use' && 'input' in block) {
            const input = (block as { type: 'tool_use'; input: Record<string, unknown> }).input;
            if (typeof input.content === 'string') {
              allTextBlocks.push(input.content);
            }
          }
        }
      }
    }

    console.log(`[skill-scanning] Agent finished for "${skill.name}", extracting results...`);

    // Strategy 1: Read scan-results.json from workspace
    let scanOutput: RawScanOutput | null = null;
    const resultsFilePath = join(tempWorkspace, 'scan-results.json');

    if (existsSync(resultsFilePath)) {
      const fileContent = await readFile(resultsFilePath, 'utf-8');
      scanOutput = parseAndValidateScanResults(fileContent);
      if (scanOutput) {
        console.log('[skill-scanning] Parsed scan-results.json from file');
      }
    }

    // Strategy 1b: Try S3 for agentcore mode
    if (!scanOutput && config.agentRuntime === 'agentcore') {
      try {
        const s3Prefix = `system/system/${sessionId}/`;
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: config.aws.region });
        const resp = await s3.send(new GetObjectCommand({
          Bucket: config.agentcore.workspaceS3Bucket,
          Key: `${s3Prefix}scan-results.json`,
        }));
        const body = await resp.Body?.transformToString();
        if (body) {
          scanOutput = parseAndValidateScanResults(body);
          if (scanOutput) {
            console.log('[skill-scanning] Parsed scan-results.json from S3');
          }
        }
      } catch {
        // S3 file not found — fall through to text extraction
      }
    }

    // Strategy 2: Extract from conversation text
    if (!scanOutput) {
      console.log('[skill-scanning] scan-results.json not found, extracting from conversation text...');
      scanOutput = extractResultsFromText(allTextBlocks);
      if (scanOutput) {
        console.log('[skill-scanning] Extracted scan results from conversation text');
      }
    }

    if (!scanOutput) {
      console.error(`[skill-scanning] Failed to extract scan results for "${skill.name}"`);
      return [];
    }

    // Persist results to DB
    const results: ScanResult[] = [];

    for (const scanType of scanTypes) {
      const scanData = scanOutput.scans[scanType];
      if (!scanData) continue;

      const score = Math.max(0, Math.min(100, Math.round((scanData.score || 0) * 10) / 10));
      let status: ScanStatus;
      if (score >= 70) status = 'passed';
      else if (score >= 50) status = 'warning';
      else status = 'failed';

      const findings: ScanFinding[] = (scanData.checks || []).map(c => ({
        check: String(c.check || ''),
        passed: Boolean(c.passed),
        severity: (['info', 'low', 'medium', 'high', 'critical'].includes(c.severity) ? c.severity : 'info') as ScanFinding['severity'],
        detail: String(c.detail || ''),
      }));

      const record = await prisma.skill_scan_results.create({
        data: {
          skill_id: skillId,
          scan_type: scanType,
          status,
          score,
          findings: findings as unknown as object[],
          summary: scanData.summary || null,
        },
      });

      results.push({
        id: record.id,
        skill_id: record.skill_id,
        scan_type: record.scan_type as ScanType,
        status: record.status as ScanStatus,
        score: record.score,
        findings,
        summary: record.summary,
        scanned_at: record.scanned_at,
      });
    }

    console.log(
      `[skill-scanning] Completed scan for "${skill.name}": ` +
      results.map(r => `${r.scan_type}=${r.score}`).join(', '),
    );

    // Update skill status based on weighted scan results
    // Weights: security 40%, license 25%, compatibility 20%, compliance 15%
    const SCAN_WEIGHTS: Record<string, number> = {
      security: 0.40,
      license: 0.25,
      compatibility: 0.20,
      compliance: 0.15,
    };

    let weightedSum = 0;
    let totalWeight = 0;
    for (const r of results) {
      const weight = SCAN_WEIGHTS[r.scan_type] ?? 0.25;
      weightedSum += r.score * weight;
      totalWeight += weight;
    }
    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Quarantine threshold: 40 (not 50) — quarantine is a heavy action
    let newStatus: string;
    if (overallScore >= 40) {
      newStatus = 'active';  // passed or warning — allow usage
    } else {
      newStatus = 'quarantined';  // serious issues — block usage, needs admin review
    }

    try {
      await prisma.skills.update({
        where: { id: skillId },
        data: { status: newStatus },
      });
      console.log(`[skill-scanning] Skill "${skill.name}" status → ${newStatus} (score: ${Math.round(overallScore)})`);
    } catch (err) {
      console.error(`[skill-scanning] Failed to update skill status:`, err);
    }

    return results;
  } finally {
    // Clean up temp workspace
    rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fire-and-forget scan trigger. Logs errors but never throws.
 * Use this from install endpoints to avoid blocking the response.
 * On failure or timeout, marks the skill as 'scan_failed'.
 */
export function triggerAsyncScan(skillId: string, scanTypes?: ScanType[]): void {
  // 10-minute timeout for the entire scan
  const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

  const timeoutPromise = new Promise<ScanResult[]>((_, reject) => {
    setTimeout(() => reject(new Error('Scan timed out after 10 minutes')), SCAN_TIMEOUT_MS);
  });

  Promise.race([scanSkill(skillId, scanTypes), timeoutPromise]).catch(async (err) => {
    console.error(`[skill-scanning] Async scan failed for skill ${skillId}:`, err);
    // Mark skill as scan_failed so the user can retry
    try {
      await prisma.skills.update({
        where: { id: skillId },
        data: { status: 'scan_failed' },
      });
      console.log(`[skill-scanning] Skill ${skillId} marked as scan_failed`);
    } catch (updateErr) {
      console.error(`[skill-scanning] Failed to mark skill as scan_failed:`, updateErr);
    }
  });
}

/**
 * Get scan results for a skill.
 */
export async function getSkillScanResults(skillId: string): Promise<ScanResult[]> {
  const rows = await prisma.skill_scan_results.findMany({
    where: { skill_id: skillId },
    orderBy: { scanned_at: 'desc' },
  });

  return rows.map(r => ({
    id: r.id,
    skill_id: r.skill_id,
    scan_type: r.scan_type as ScanType,
    status: r.status as ScanStatus,
    score: r.score,
    findings: r.findings as unknown as ScanFinding[],
    summary: r.summary,
    scanned_at: r.scanned_at,
  }));
}

/**
 * Get the latest scan summary (one result per scan type) for a skill.
 */
export async function getSkillScanSummary(skillId: string): Promise<{
  scanned: boolean;
  overall_score: number;
  scan_types: Record<string, ScanResult>;
}> {
  const results = await getSkillScanResults(skillId);
  if (results.length === 0) {
    return { scanned: false, overall_score: 0, scan_types: {} };
  }

  const latest: Record<string, ScanResult> = {};
  for (const r of results) {
    if (!latest[r.scan_type]) {
      latest[r.scan_type] = r;
    }
  }

  // Weighted scoring: security 40%, license 25%, compatibility 20%, compliance 15%
  const SCAN_WEIGHTS: Record<string, number> = {
    security: 0.40,
    license: 0.25,
    compatibility: 0.20,
    compliance: 0.15,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of Object.values(latest)) {
    const weight = SCAN_WEIGHTS[r.scan_type] ?? 0.25;
    weightedSum += r.score * weight;
    totalWeight += weight;
  }
  const overall = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 10) / 10
    : 0;

  return { scanned: true, overall_score: overall, scan_types: latest };
}
