/**
 * Token Usage API Service
 */

import { restClient } from './restClient';

export interface MonthlyUsage {
  userId: string;
  userName?: string;
  email?: string;
  month: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  invocationCount: number;
}

export interface QuotaStatus {
  allowed: boolean;
  currentTokens: number;
  currentCostUsd: number;
  tokenLimit: number;
  costLimit: number;
  usagePercent: number;
  reason?: string;
}

export interface PlanQuota {
  maxTokensPerMonth: number;
  maxCostPerMonth: number;
}

export const TokenUsageService = {
  /** Get current user's usage history */
  getMyUsage: (months = 6) =>
    restClient
      .get<{ data: MonthlyUsage[] }>(`/api/token-usage/me?months=${months}`)
      .then((r) => r.data),

  /** Get all members' usage for a month (Admin/Owner only) */
  getOrganizationUsage: (month?: string) =>
    restClient
      .get<{ data: MonthlyUsage[] }>(`/api/token-usage/organization${month ? `?month=${month}` : ''}`)
      .then((r) => r.data),

  /** Get a specific user's usage history (Admin/Owner only) */
  getUserUsage: (userId: string, months = 6) =>
    restClient
      .get<{ data: MonthlyUsage[] }>(`/api/token-usage/users/${userId}?months=${months}`)
      .then((r) => r.data),

  // ---- Quota endpoints ----

  /** Get current user's quota status */
  getMyQuota: () =>
    restClient
      .get<{ data: QuotaStatus }>('/api/token-usage/quota/me')
      .then((r) => r.data),

  /** Get plan quota definitions */
  getPlanQuotas: () =>
    restClient
      .get<{ data: Record<string, PlanQuota> }>('/api/token-usage/quota/plans')
      .then((r) => r.data),

  /** Get all per-user quota overrides (Admin/Owner only) */
  getQuotaOverrides: () =>
    restClient
      .get<{ data: Record<string, Partial<PlanQuota>> }>('/api/token-usage/quota/overrides')
      .then((r) => r.data),

  /** Set per-user quota override (Admin/Owner only) */
  setUserQuota: (userId: string, quota: Partial<PlanQuota>) =>
    restClient
      .put<{ data: QuotaStatus }>(`/api/token-usage/quota/users/${userId}`, quota)
      .then((r) => r.data),

  /** Remove per-user quota override (Admin/Owner only) */
  removeUserQuota: (userId: string) =>
    restClient
      .delete<{ data: QuotaStatus }>(`/api/token-usage/quota/users/${userId}`)
      .then((r) => r.data),
};
