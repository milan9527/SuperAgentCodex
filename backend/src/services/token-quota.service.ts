/**
 * Token Quota Service
 *
 * Enforces per-user monthly token caps based on organization plan type.
 * Supports custom per-user overrides set by admins.
 *
 * Design decisions:
 * - Quota is checked BEFORE execution starts (pre-flight check)
 * - Uses the existing token_usage_monthly table for current consumption
 * - Plan-level defaults are defined in code; per-user overrides stored in org settings
 * - Returns a structured result so callers can show meaningful error messages
 */

import { prisma } from '../config/database.js';
import { redisService } from './redis.service.js';

// ---------------------------------------------------------------------------
// Plan-level default quotas (total tokens = input + output per month)
// ---------------------------------------------------------------------------

export interface PlanQuota {
  /** Maximum total tokens (input + output) per user per month. 0 = unlimited. */
  maxTokensPerMonth: number;
  /** Maximum cost in USD per user per month. 0 = unlimited. */
  maxCostPerMonth: number;
}

/**
 * Default quota limits by plan type.
 * These serve as high defaults; actual per-user limits are set via the admin UI
 * and stored in the organization settings JSON.
 */
export const PLAN_QUOTAS: Record<string, PlanQuota> = {
  free: {
    maxTokensPerMonth: 10_000_000,    // 10M tokens/month
    maxCostPerMonth: 100,             // $100/month
  },
  pro: {
    maxTokensPerMonth: 50_000_000,    // 50M tokens/month
    maxCostPerMonth: 500,             // $500/month
  },
  enterprise: {
    maxTokensPerMonth: 0,             // unlimited (controlled by contract)
    maxCostPerMonth: 0,               // unlimited
  },
};

// ---------------------------------------------------------------------------
// Quota check result
// ---------------------------------------------------------------------------

export interface QuotaCheckResult {
  allowed: boolean;
  /** Current total tokens used this month */
  currentTokens: number;
  /** Current cost this month */
  currentCostUsd: number;
  /** The effective limit (0 = unlimited) */
  tokenLimit: number;
  /** The effective cost limit (0 = unlimited) */
  costLimit: number;
  /** Percentage of token quota used (0-100+) */
  usagePercent: number;
  /** Human-readable reason if denied */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Redis cache key helpers
// ---------------------------------------------------------------------------

const QUOTA_CACHE_PREFIX = 'token_quota:';
const QUOTA_CACHE_TTL = 60; // 60 seconds — balance between freshness and DB load

function usageCacheKey(orgId: string, userId: string, month: string): string {
  return `${QUOTA_CACHE_PREFIX}${orgId}:${userId}:${month}`;
}

// ---------------------------------------------------------------------------
// Core quota check
// ---------------------------------------------------------------------------

/**
 * Check whether a user is within their monthly token quota.
 *
 * Performance: uses Redis cache (60s TTL) to avoid hitting the DB on every request.
 * The cache is invalidated naturally by TTL expiry; slight over-quota is acceptable
 * since the actual enforcement is best-effort (tokens are consumed asynchronously).
 */
export async function checkTokenQuota(
  organizationId: string,
  userId: string,
): Promise<QuotaCheckResult> {
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  // 1. Get the effective quota for this user
  const quota = await getEffectiveQuota(organizationId, userId);

  // If both limits are 0 (unlimited), skip the DB lookup entirely
  if (quota.maxTokensPerMonth === 0 && quota.maxCostPerMonth === 0) {
    return {
      allowed: true,
      currentTokens: 0,
      currentCostUsd: 0,
      tokenLimit: 0,
      costLimit: 0,
      usagePercent: 0,
    };
  }

  // 2. Get current usage (with Redis cache)
  const { totalTokens, totalCostUsd } = await getCurrentUsage(organizationId, userId, currentMonth);

  // 3. Check against limits
  const tokenExceeded = quota.maxTokensPerMonth > 0 && totalTokens >= quota.maxTokensPerMonth;
  const costExceeded = quota.maxCostPerMonth > 0 && totalCostUsd >= quota.maxCostPerMonth;

  const usagePercent = quota.maxTokensPerMonth > 0
    ? Math.round((totalTokens / quota.maxTokensPerMonth) * 100)
    : 0;

  if (tokenExceeded) {
    return {
      allowed: false,
      currentTokens: totalTokens,
      currentCostUsd: totalCostUsd,
      tokenLimit: quota.maxTokensPerMonth,
      costLimit: quota.maxCostPerMonth,
      usagePercent,
      reason: `Monthly token quota exceeded: ${totalTokens.toLocaleString()} / ${quota.maxTokensPerMonth.toLocaleString()} tokens used`,
    };
  }

  if (costExceeded) {
    return {
      allowed: false,
      currentTokens: totalTokens,
      currentCostUsd: totalCostUsd,
      tokenLimit: quota.maxTokensPerMonth,
      costLimit: quota.maxCostPerMonth,
      usagePercent,
      reason: `Monthly cost quota exceeded: $${totalCostUsd.toFixed(2)} / $${quota.maxCostPerMonth.toFixed(2)} used`,
    };
  }

  return {
    allowed: true,
    currentTokens: totalTokens,
    currentCostUsd: totalCostUsd,
    tokenLimit: quota.maxTokensPerMonth,
    costLimit: quota.maxCostPerMonth,
    usagePercent,
  };
}

// ---------------------------------------------------------------------------
// Get effective quota (plan default + per-user override)
// ---------------------------------------------------------------------------

/**
 * Determine the effective quota for a user:
 * 1. Check for per-user override in organization settings
 * 2. Fall back to plan-level default
 */
export async function getEffectiveQuota(
  organizationId: string,
  userId: string,
): Promise<PlanQuota> {
  // Load organization to get plan_type and settings
  const org = await prisma.organizations.findUnique({
    where: { id: organizationId },
    select: { plan_type: true, settings: true },
  });

  if (!org) {
    // Org not found — use most restrictive defaults
    return PLAN_QUOTAS.free!;
  }

  const planDefault = PLAN_QUOTAS[org.plan_type] ?? PLAN_QUOTAS.free!;

  // Check for per-user override in org settings
  // Settings shape: { tokenQuotas: { [userId]: { maxTokensPerMonth, maxCostPerMonth } } }
  const settings = org.settings as Record<string, unknown> | null;
  const tokenQuotas = settings?.tokenQuotas as Record<string, Partial<PlanQuota>> | undefined;

  if (tokenQuotas && tokenQuotas[userId]) {
    const override = tokenQuotas[userId]!;
    return {
      maxTokensPerMonth: override.maxTokensPerMonth ?? planDefault!.maxTokensPerMonth,
      maxCostPerMonth: override.maxCostPerMonth ?? planDefault!.maxCostPerMonth,
    };
  }

  return planDefault!;
}

// ---------------------------------------------------------------------------
// Get current usage (cached)
// ---------------------------------------------------------------------------

async function getCurrentUsage(
  organizationId: string,
  userId: string,
  month: string,
): Promise<{ totalTokens: number; totalCostUsd: number }> {
  const cacheKey = usageCacheKey(organizationId, userId, month);

  // Try Redis cache first
  try {
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Redis unavailable — fall through to DB
  }

  // Query the monthly rollup table
  const row = await prisma.token_usage_monthly.findUnique({
    where: {
      organization_id_user_id_month: {
        organization_id: organizationId,
        user_id: userId,
        month,
      },
    },
    select: {
      input_tokens: true,
      output_tokens: true,
      total_cost_usd: true,
    },
  });

  const result = {
    totalTokens: row ? Number(row.input_tokens) + Number(row.output_tokens) : 0,
    totalCostUsd: row ? Number(row.total_cost_usd) : 0,
  };

  // Cache the result
  try {
    await redisService.setex(cacheKey, QUOTA_CACHE_TTL, JSON.stringify(result));
  } catch {
    // Non-critical — next request will just hit DB again
  }

  return result;
}

// ---------------------------------------------------------------------------
// Admin: set per-user quota override
// ---------------------------------------------------------------------------

/**
 * Set a custom token quota for a specific user (admin action).
 * Pass null/undefined values to remove the override and revert to plan default.
 */
export async function setUserQuotaOverride(
  organizationId: string,
  userId: string,
  override: Partial<PlanQuota> | null,
): Promise<void> {
  const org = await prisma.organizations.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });

  const settings = (org?.settings as Record<string, unknown>) ?? {};
  const tokenQuotas = (settings.tokenQuotas as Record<string, unknown>) ?? {};

  if (override === null) {
    delete tokenQuotas[userId];
  } else {
    tokenQuotas[userId] = override;
  }

  await prisma.organizations.update({
    where: { id: organizationId },
    data: {
      settings: { ...settings, tokenQuotas } as any,
    },
  });
}

/**
 * Get all per-user quota overrides for an organization.
 */
export async function getUserQuotaOverrides(
  organizationId: string,
): Promise<Record<string, Partial<PlanQuota>>> {
  const org = await prisma.organizations.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });

  const settings = (org?.settings as Record<string, unknown>) ?? {};
  return (settings.tokenQuotas as Record<string, Partial<PlanQuota>>) ?? {};
}

/**
 * Get quota status for a user (for display in UI).
 */
export async function getUserQuotaStatus(
  organizationId: string,
  userId: string,
): Promise<QuotaCheckResult> {
  return checkTokenQuota(organizationId, userId);
}
