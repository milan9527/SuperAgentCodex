/**
 * Project Triage Actions Service
 *
 * Executes actions based on triage report recommendations or user natural language input.
 * Parses intent → maps to issue CRUD operations → executes.
 *
 * Supported actions:
 * - merge_issues: Combine multiple issues into one
 * - reorder: Change issue sort order / priority
 * - update_description: Enrich an issue's description
 * - change_priority: Set priority for an issue
 * - split_issue: Break one issue into sub-tasks
 * - custom: Free-form natural language → AI decides what to do
 */

import { prisma } from '../config/database.js';
import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';

// ============================================================================
// Types
// ============================================================================

export interface TriageAction {
  type: 'merge_issues' | 'reorder' | 'update_description' | 'change_priority' | 'split_issue' | 'custom';
  label: string;
  description: string;
  params: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  message: string;
  changes: Array<{ issue_number: number; action: string; detail: string }>;
}

// ============================================================================
// Service
// ============================================================================

export class ProjectTriageActionsService {
  /**
   * Generate suggested actions from a triage report.
   * Returns a list of actionable buttons the user can click.
   */
  generateSuggestedActions(report: {
    recommended_order?: Array<{ issue_number: number; reason: string }>;
    merge_suggestions?: Array<{ issue_numbers: number[]; reason: string; suggested_title: string }>;
    missing_info?: Array<{ issue_number: number; what_is_missing: string }>;
    risk_flags?: Array<{ issue_number: number; risk: string }>;
  }): TriageAction[] {
    const actions: TriageAction[] = [];

    // Merge suggestions → merge action
    if (report.merge_suggestions?.length) {
      for (const merge of report.merge_suggestions) {
        actions.push({
          type: 'merge_issues',
          label: `合并 ${merge.issue_numbers.map(n => `#${n}`).join(' + ')}`,
          description: `合并为: "${merge.suggested_title}"`,
          params: { issue_numbers: merge.issue_numbers, title: merge.suggested_title, reason: merge.reason },
        });
      }
    }

    // Recommended order → reorder action
    if (report.recommended_order?.length && report.recommended_order.length > 1) {
      actions.push({
        type: 'reorder',
        label: '按推荐顺序重排 Backlog',
        description: `将 ${report.recommended_order.length} 个 issue 按 AI 建议的优先级重新排序`,
        params: { order: report.recommended_order.map(r => r.issue_number) },
      });
    }

    // Missing info → update description action
    if (report.missing_info?.length) {
      for (const info of report.missing_info.slice(0, 2)) {
        actions.push({
          type: 'update_description',
          label: `补充 #${info.issue_number} 的描述`,
          description: info.what_is_missing,
          params: { issue_number: info.issue_number, missing: info.what_is_missing },
        });
      }
    }

    // Risk flags → change priority
    if (report.risk_flags?.length) {
      for (const risk of report.risk_flags.slice(0, 1)) {
        actions.push({
          type: 'change_priority',
          label: `提升 #${risk.issue_number} 优先级`,
          description: `风险: ${risk.risk}`,
          params: { issue_number: risk.issue_number, priority: 'high' },
        });
      }
    }

    return actions;
  }

  /**
   * Execute a structured triage action.
   */
  async executeAction(orgId: string, projectId: string, action: TriageAction, userId?: string): Promise<ActionResult> {
    // Resolve a valid created_by UUID
    const project = await prisma.projects.findFirst({ where: { id: projectId, organization_id: orgId }, select: { created_by: true } });
    const createdBy = userId || project?.created_by || orgId;

    switch (action.type) {
      case 'merge_issues':
        return this.executeMerge(orgId, projectId, action.params, createdBy);
      case 'reorder':
        return this.executeReorder(orgId, projectId, action.params);
      case 'update_description':
        return this.executeUpdateDescription(orgId, projectId, action.params);
      case 'change_priority':
        return this.executeChangePriority(orgId, projectId, action.params);
      case 'split_issue':
        return this.executeSplit(orgId, projectId, action.params);
      case 'custom':
        return this.executeCustom(orgId, projectId, action.params);
      default:
        return { success: false, message: `Unknown action type: ${action.type}`, changes: [] };
    }
  }

  /**
   * Execute a free-form natural language action.
   * AI parses the intent and maps to issue operations.
   */
  async executeNaturalLanguage(orgId: string, projectId: string, instruction: string, userId?: string): Promise<ActionResult> {
    const project = await prisma.projects.findFirst({ where: { id: projectId, organization_id: orgId } });
    if (!project) throw AppError.notFound('Project not found');
    const createdBy = userId || project.created_by;

    // Get current issues for context
    const issues = await prisma.project_issues.findMany({
      where: { project_id: projectId, status: { not: 'cancelled' } },
      select: { id: true, issue_number: true, title: true, status: true, priority: true, labels: true, description: true },
      orderBy: { sort_order: 'asc' },
    });

    const issueContext = issues.map(i =>
      `#${i.issue_number} [${i.status}] (${i.priority}) "${i.title}"`
    ).join('\n');

    const prompt = `You are a project management assistant. Execute the user's instruction on the project's issues.

## Current Issues
${issueContext}

## User Instruction
"${instruction}"

## Available Operations
- merge: Combine issues into one (close originals, create new)
- reorder: Change sort_order of issues
- update: Modify title, description, priority, labels, or status of an issue
- split: Split one issue into multiple sub-issues (provide issue_number and sub_tasks array)
- create: Create a new issue
- cancel: Cancel/close an issue

Return ONLY valid JSON describing the operations to perform:
{
  "operations": [
    { "op": "update", "issue_number": 4, "fields": { "priority": "high" } },
    { "op": "create", "fields": { "title": "New task", "description": "...", "status": "backlog", "priority": "medium" } },
    { "op": "merge", "issue_numbers": [4, 5], "new_title": "Combined task", "new_description": "..." },
    { "op": "split", "issue_number": 6, "sub_tasks": [{ "title": "Sub task 1", "description": "..." }, { "title": "Sub task 2", "description": "..." }] },
    { "op": "reorder", "order": [5, 4, 3] },
    { "op": "cancel", "issue_number": 3 }
  ],
  "summary": "Brief description of what was done"
}

Rules:
- Only perform operations that match the user's intent
- Be conservative — don't change things the user didn't ask about
- For merge: close the original issues and create a new one combining their content`;

    try {
      const { aiService } = await import('./ai.service.js');
      const response = await aiService.chatCompletion({
        system_prompt: 'You are a project management assistant. Return only valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
      });

      const parsed = this.parseJson(response);
      if (!parsed?.operations) {
        return { success: false, message: 'AI 无法解析指令，请尝试更具体的描述', changes: [] };
      }

      console.log('[TriageActions] AI operations:', JSON.stringify(parsed.operations, null, 2));

      const changes: Array<{ issue_number: number; action: string; detail: string }> = [];

      for (const op of parsed.operations as Array<Record<string, unknown>>) {
        try {
          switch (op.op) {
            case 'update': {
              const issueNum = op.issue_number as number;
              const issue = issues.find(i => i.issue_number === issueNum);
              if (!issue) break;
              const fields = op.fields as Record<string, unknown>;
              const updateData: Record<string, unknown> = {};
              if (fields.title) updateData.title = fields.title as string;
              if (fields.description) updateData.description = fields.description as string;
              if (fields.priority) updateData.priority = fields.priority as string;
              if (fields.status) updateData.status = fields.status as string;
              if (fields.labels) updateData.labels = fields.labels as Prisma.InputJsonValue;
              await prisma.project_issues.update({
                where: { id: issue.id },
                data: updateData,
              });
              changes.push({ issue_number: issueNum, action: 'update', detail: Object.keys(fields).join(', ') });
              break;
            }
            case 'create': {
              const fields = op.fields as Record<string, unknown>;
              // Re-query max each time to avoid race between multiple creates
              const maxNumResult = await prisma.project_issues.findFirst({
                where: { project_id: projectId },
                orderBy: { issue_number: 'desc' },
                select: { issue_number: true },
              });
              const newNum = (maxNumResult?.issue_number ?? 0) + 1;
              await prisma.project_issues.create({
                data: {
                  project_id: projectId,
                  organization_id: orgId,
                  issue_number: newNum,
                  title: (fields.title as string) || 'New Issue',
                  description: (fields.description as string) || null,
                  status: (fields.status as string) || 'backlog',
                  priority: (fields.priority as string) || 'medium',
                  labels: (fields.labels ?? []) as Prisma.InputJsonValue,
                  sort_order: newNum,
                  created_by: createdBy,
                },
              });
              changes.push({ issue_number: newNum, action: 'create', detail: (fields.title as string) || 'New Issue' });
              break;
            }
            case 'merge': {
              const nums = op.issue_numbers as number[];
              const toMerge = issues.filter(i => nums.includes(i.issue_number));
              if (toMerge.length < 2) break;
              // Create merged issue
              const maxNum = await prisma.project_issues.findFirst({
                where: { project_id: projectId },
                orderBy: { issue_number: 'desc' },
                select: { issue_number: true },
              });
              const newNum = (maxNum?.issue_number ?? 0) + 1;
              const mergedDesc = toMerge.map(i => `## 原 #${i.issue_number}: ${i.title}\n${i.description || ''}`).join('\n\n');
              await prisma.project_issues.create({
                data: {
                  project_id: projectId,
                  organization_id: orgId,
                  issue_number: newNum,
                  title: (op.new_title as string) || toMerge.map(i => i.title).join(' + '),
                  description: (op.new_description as string) || mergedDesc,
                  status: 'backlog',
                  priority: toMerge[0]!.priority,
                  labels: [] as Prisma.InputJsonValue,
                  sort_order: newNum,
                  created_by: createdBy,
                },
              });
              // Cancel originals
              for (const i of toMerge) {
                await prisma.project_issues.update({
                  where: { id: i.id },
                  data: { status: 'cancelled' },
                });
              }
              changes.push({ issue_number: newNum, action: 'merge', detail: `合并 ${nums.map(n => `#${n}`).join(', ')} → #${newNum}` });
              break;
            }
            case 'reorder': {
              const order = op.order as number[];
              for (let idx = 0; idx < order.length; idx++) {
                const issue = issues.find(i => i.issue_number === order[idx]);
                if (issue) {
                  await prisma.project_issues.update({
                    where: { id: issue.id },
                    data: { sort_order: idx + 1 },
                  });
                }
              }
              changes.push({ issue_number: 0, action: 'reorder', detail: `重排 ${order.length} 个 issue` });
              break;
            }
            case 'split': {
              // Split: create N sub-issues from a parent, then cancel the parent
              const parentNum = op.issue_number as number;
              const parentIssue = issues.find(i => i.issue_number === parentNum);
              const subTasks = op.sub_tasks as Array<{ title: string; description?: string }> | undefined
                ?? op.tasks as Array<{ title: string; description?: string }> | undefined
                ?? op.children as Array<{ title: string; description?: string }> | undefined
                ?? [];
              if (!parentIssue || subTasks.length === 0) {
                console.warn('[TriageActions] Split: no parent or no sub-tasks', op);
                break;
              }
              for (const sub of subTasks) {
                const maxNumResult = await prisma.project_issues.findFirst({
                  where: { project_id: projectId },
                  orderBy: { issue_number: 'desc' },
                  select: { issue_number: true },
                });
                const newNum = (maxNumResult?.issue_number ?? 0) + 1;
                await prisma.project_issues.create({
                  data: {
                    project_id: projectId,
                    organization_id: orgId,
                    issue_number: newNum,
                    title: sub.title,
                    description: sub.description || null,
                    status: parentIssue.status === 'cancelled' ? 'backlog' : parentIssue.status,
                    priority: parentIssue.priority,
                    labels: (parentIssue.labels ?? []) as Prisma.InputJsonValue,
                    sort_order: newNum,
                    parent_issue_id: parentIssue.id,
                    created_by: createdBy,
                  },
                });
                changes.push({ issue_number: newNum, action: 'create', detail: sub.title });
              }
              // Cancel the original
              await prisma.project_issues.update({
                where: { id: parentIssue.id },
                data: { status: 'cancelled' },
              });
              changes.push({ issue_number: parentNum, action: 'cancel', detail: '已拆分为子任务' });
              break;
            }
            case 'cancel':
            case 'close':
            case 'delete': {
              const issueNum = op.issue_number as number;
              const issue = issues.find(i => i.issue_number === issueNum);
              if (issue) {
                await prisma.project_issues.update({
                  where: { id: issue.id },
                  data: { status: 'cancelled' },
                });
                changes.push({ issue_number: issueNum, action: 'cancel', detail: '已取消' });
              }
              break;
            }
            default: {
              console.warn(`[TriageActions] Unhandled operation type: ${op.op}`, JSON.stringify(op));
              break;
            }
          }
        } catch (err) {
          console.error(`[TriageActions] Operation failed:`, JSON.stringify(op), err instanceof Error ? err.message : err);
        }
      }

      return {
        success: changes.length > 0,
        message: (parsed.summary as string) || `执行了 ${changes.length} 个操作`,
        changes,
      };
    } catch (err) {
      console.error('[TriageActions] Natural language execution failed:', err);
      return { success: false, message: '执行失败，请重试', changes: [] };
    }
  }

  // ── Structured action executors ─────────────────────────────────────────

  private async executeMerge(orgId: string, projectId: string, params: Record<string, unknown>, createdBy: string): Promise<ActionResult> {
    const issueNumbers = params.issue_numbers as number[];
    const title = params.title as string;

    const issues = await prisma.project_issues.findMany({
      where: { project_id: projectId, organization_id: orgId, issue_number: { in: issueNumbers } },
    });

    if (issues.length < 2) {
      return { success: false, message: '找不到足够的 issue 来合并', changes: [] };
    }

    const maxNum = await prisma.project_issues.findFirst({
      where: { project_id: projectId },
      orderBy: { issue_number: 'desc' },
      select: { issue_number: true },
    });
    const newNum = (maxNum?.issue_number ?? 0) + 1;

    const mergedDesc = issues.map(i => `## 原 #${i.issue_number}: ${i.title}\n${i.description || '(无描述)'}`).join('\n\n');

    await prisma.project_issues.create({
      data: {
        project_id: projectId,
        organization_id: orgId,
        issue_number: newNum,
        title,
        description: mergedDesc,
        status: 'backlog',
        priority: issues[0]!.priority,
        labels: [] as Prisma.InputJsonValue,
        sort_order: newNum,
        created_by: createdBy,
      },
    });

    for (const issue of issues) {
      await prisma.project_issues.update({
        where: { id: issue.id },
        data: { status: 'cancelled' },
      });
    }

    return {
      success: true,
      message: `已合并 ${issueNumbers.map(n => `#${n}`).join(', ')} 为新 issue #${newNum}`,
      changes: [{ issue_number: newNum, action: 'merge', detail: title }],
    };
  }

  private async executeReorder(orgId: string, projectId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const order = params.order as number[];

    const issues = await prisma.project_issues.findMany({
      where: { project_id: projectId, organization_id: orgId, issue_number: { in: order } },
    });

    const issueMap = new Map(issues.map(i => [i.issue_number, i]));

    for (let idx = 0; idx < order.length; idx++) {
      const issue = issueMap.get(order[idx]!);
      if (issue) {
        await prisma.project_issues.update({
          where: { id: issue.id },
          data: { sort_order: idx + 1 },
        });
      }
    }

    return {
      success: true,
      message: `已按推荐顺序重排 ${order.length} 个 issue`,
      changes: [{ issue_number: 0, action: 'reorder', detail: `${order.length} issues reordered` }],
    };
  }

  private async executeUpdateDescription(orgId: string, projectId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const issueNumber = params.issue_number as number;
    const missing = params.missing as string;

    const issue = await prisma.project_issues.findFirst({
      where: { project_id: projectId, organization_id: orgId, issue_number: issueNumber },
    });
    if (!issue) return { success: false, message: `Issue #${issueNumber} not found`, changes: [] };

    // Use AI to generate the missing content
    const { aiService } = await import('./ai.service.js');
    const improved = await aiService.chatCompletion({
      system_prompt: 'You are a technical writer. Improve the issue description by adding the missing information. Return only the improved description in Markdown.',
      messages: [{ role: 'user', content: `Issue: ${issue.title}\nCurrent description: ${issue.description || '(empty)'}\n\nMissing information that needs to be added: ${missing}\n\nWrite an improved description that includes this missing information.` }],
      max_tokens: 1024,
    });

    await prisma.project_issues.update({
      where: { id: issue.id },
      data: { description: improved, ai_analysis_status: 'stale' },
    });

    return {
      success: true,
      message: `已补充 #${issueNumber} 的描述`,
      changes: [{ issue_number: issueNumber, action: 'update_description', detail: missing }],
    };
  }

  private async executeChangePriority(orgId: string, projectId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const issueNumber = params.issue_number as number;
    const priority = params.priority as string;

    const issue = await prisma.project_issues.findFirst({
      where: { project_id: projectId, organization_id: orgId, issue_number: issueNumber },
    });
    if (!issue) return { success: false, message: `Issue #${issueNumber} not found`, changes: [] };

    await prisma.project_issues.update({
      where: { id: issue.id },
      data: { priority },
    });

    return {
      success: true,
      message: `已将 #${issueNumber} 优先级设为 ${priority}`,
      changes: [{ issue_number: issueNumber, action: 'change_priority', detail: priority }],
    };
  }

  private async executeSplit(_orgId: string, _projectId: string, _params: Record<string, unknown>): Promise<ActionResult> {
    // Delegate to natural language handler for complex splits
    return { success: false, message: 'Split action should use natural language input', changes: [] };
  }

  private async executeCustom(orgId: string, projectId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const instruction = params.instruction as string;
    if (!instruction) return { success: false, message: 'No instruction provided', changes: [] };
    return this.executeNaturalLanguage(orgId, projectId, instruction);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private parseJson(text: string): Record<string, unknown> | null {
    try { return JSON.parse(text); } catch { /* continue */ }
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match?.[1]) { try { return JSON.parse(match[1]); } catch { /* continue */ } }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) { try { return JSON.parse(text.substring(start, end + 1)); } catch { /* continue */ } }
    return null;
  }
}

export const triageActionsService = new ProjectTriageActionsService();
