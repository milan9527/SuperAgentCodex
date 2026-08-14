/**
 * Quota Management Section (Admin only)
 *
 * Allows admins to view and set per-user monthly token limits.
 * Displayed within the TokenUsageTab when the user is an admin.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Save, RotateCcw, Users, Pencil } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useMembers } from '@/services/useMembers';
import { TokenUsageService, type QuotaStatus } from '@/services/api/tokenUsageService';

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function parseTokenInput(value: string): number {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) return 0;
  // Support shorthand: 1m = 1,000,000; 500k = 500,000
  if (cleaned.endsWith('m')) return Math.round(parseFloat(cleaned) * 1_000_000);
  if (cleaned.endsWith('k')) return Math.round(parseFloat(cleaned) * 1_000);
  return Math.round(parseFloat(cleaned)) || 0;
}

interface UserQuotaRow {
  userId: string;
  name: string;
  email: string;
  currentTokens: number;
  tokenLimit: number;
  usagePercent: number;
  isEditing: boolean;
  editValue: string;
  isSaving: boolean;
}

export function QuotaManagementSection() {
  const { t } = useTranslation();
  const { members, isLoading: membersLoading } = useMembers();
  const [rows, setRows] = useState<UserQuotaRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadQuotas = useCallback(async () => {
    if (members.length === 0) return;
    setIsLoading(true);
    try {
      // Load quota status for each member in parallel
      const results = await Promise.allSettled(
        members
          .filter(m => m.user_id && m.status === 'active')
          .map(async (m) => {
            // Use the org-level endpoint to get each user's quota
            const [usageRows] = await Promise.all([
              TokenUsageService.getOrganizationUsage(),
            ]);
            const userUsage = usageRows.find(u => u.userId === m.user_id);
            // Get the user's effective quota
            let quotaStatus: QuotaStatus | null = null;
            try {
              // Admin can check any user's quota via the overrides + plan defaults
              const overrides = await TokenUsageService.getQuotaOverrides();
              const plans = await TokenUsageService.getPlanQuotas();
              const userOverride = overrides[m.user_id];
              // Determine effective limit
              const defaultPlan = plans['pro'] || plans['free'] || { maxTokensPerMonth: 10_000_000 };
              const tokenLimit = userOverride?.maxTokensPerMonth ?? defaultPlan.maxTokensPerMonth;
              const currentTokens = userUsage ? userUsage.inputTokens + userUsage.outputTokens : 0;
              quotaStatus = {
                allowed: tokenLimit === 0 || currentTokens < tokenLimit,
                currentTokens,
                currentCostUsd: userUsage?.totalCostUsd ?? 0,
                tokenLimit,
                costLimit: userOverride?.maxCostPerMonth ?? defaultPlan.maxCostPerMonth ?? 0,
                usagePercent: tokenLimit > 0 ? Math.round((currentTokens / tokenLimit) * 100) : 0,
              };
            } catch {
              quotaStatus = {
                allowed: true,
                currentTokens: userUsage ? userUsage.inputTokens + userUsage.outputTokens : 0,
                currentCostUsd: userUsage?.totalCostUsd ?? 0,
                tokenLimit: 0,
                costLimit: 0,
                usagePercent: 0,
              };
            }
            return {
              userId: m.user_id,
              name: m.name || m.email || m.invited_email || 'Unknown',
              email: m.email || m.invited_email || '',
              currentTokens: quotaStatus.currentTokens,
              tokenLimit: quotaStatus.tokenLimit,
              usagePercent: quotaStatus.usagePercent,
              isEditing: false,
              editValue: '',
              isSaving: false,
            };
          })
      );
      const loaded = results
        .filter((r): r is PromiseFulfilledResult<UserQuotaRow> => r.status === 'fulfilled')
        .map(r => r.value);
      setRows(loaded);
    } catch (err) {
      console.error('Failed to load quotas:', err);
    } finally {
      setIsLoading(false);
    }
  }, [members]);

  useEffect(() => {
    if (!membersLoading && members.length > 0) {
      void loadQuotas();
    }
  }, [membersLoading, members, loadQuotas]);

  const startEdit = (userId: string) => {
    setRows(prev => prev.map(r =>
      r.userId === userId
        ? { ...r, isEditing: true, editValue: r.tokenLimit > 0 ? String(r.tokenLimit) : '' }
        : r
    ));
  };

  const cancelEdit = (userId: string) => {
    setRows(prev => prev.map(r =>
      r.userId === userId ? { ...r, isEditing: false, editValue: '' } : r
    ));
  };

  const saveQuota = async (userId: string) => {
    const row = rows.find(r => r.userId === userId);
    if (!row) return;

    const newLimit = parseTokenInput(row.editValue);
    setRows(prev => prev.map(r =>
      r.userId === userId ? { ...r, isSaving: true } : r
    ));

    try {
      await TokenUsageService.setUserQuota(userId, { maxTokensPerMonth: newLimit });
      setRows(prev => prev.map(r =>
        r.userId === userId
          ? {
              ...r,
              tokenLimit: newLimit,
              usagePercent: newLimit > 0 ? Math.round((r.currentTokens / newLimit) * 100) : 0,
              isEditing: false,
              isSaving: false,
            }
          : r
      ));
    } catch (err) {
      console.error('Failed to save quota:', err);
      setRows(prev => prev.map(r =>
        r.userId === userId ? { ...r, isSaving: false } : r
      ));
    }
  };

  const resetQuota = async (userId: string) => {
    setRows(prev => prev.map(r =>
      r.userId === userId ? { ...r, isSaving: true } : r
    ));
    try {
      const result = await TokenUsageService.removeUserQuota(userId);
      setRows(prev => prev.map(r =>
        r.userId === userId
          ? {
              ...r,
              tokenLimit: result.tokenLimit,
              usagePercent: result.usagePercent,
              isEditing: false,
              isSaving: false,
            }
          : r
      ));
    } catch (err) {
      console.error('Failed to reset quota:', err);
      setRows(prev => prev.map(r =>
        r.userId === userId ? { ...r, isSaving: false } : r
      ));
    }
  };

  if (membersLoading || isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        {t('tokenQuota.noMembers')}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-white flex items-center gap-2">
          <Users className="w-4 h-4 text-orange-400" />
          {t('tokenQuota.manageTitle')}
        </h3>
        <p className="text-xs text-gray-500">{t('tokenQuota.manageHint')}</p>
      </div>

      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-800/40">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                {t('tokenQuota.colUser')}
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                {t('tokenQuota.colUsed')}
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                {t('tokenQuota.colLimit')}
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                {t('tokenQuota.colProgress')}
              </th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                {t('tokenQuota.colActions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.map(row => (
              <tr key={row.userId} className="hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-3">
                  <div className="text-white font-medium">{row.name}</div>
                  {row.email && <div className="text-xs text-gray-500">{row.email}</div>}
                </td>
                <td className="px-4 py-3 text-gray-300">
                  {formatTokens(row.currentTokens)}
                </td>
                <td className="px-4 py-3">
                  {row.isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={row.editValue}
                        onChange={(e) => setRows(prev => prev.map(r =>
                          r.userId === row.userId ? { ...r, editValue: e.target.value } : r
                        ))}
                        placeholder="e.g. 5M, 500K, 1000000"
                        className="w-32 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveQuota(row.userId);
                          if (e.key === 'Escape') cancelEdit(row.userId);
                        }}
                        autoFocus
                      />
                      <button
                        onClick={() => saveQuota(row.userId)}
                        disabled={row.isSaving}
                        className="p-1 text-green-400 hover:bg-green-500/10 rounded disabled:opacity-50"
                        title={t('common.save')}
                      >
                        {row.isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => cancelEdit(row.userId)}
                        className="p-1 text-gray-400 hover:bg-gray-700 rounded"
                        title={t('common.cancel')}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-white">
                      {row.tokenLimit === 0 ? t('tokenQuota.unlimited') : formatTokens(row.tokenLimit)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.tokenLimit > 0 ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden max-w-[100px]">
                        <div
                          className={`h-full rounded-full transition-all ${
                            row.usagePercent >= 100 ? 'bg-red-500'
                              : row.usagePercent >= 80 ? 'bg-yellow-500'
                              : 'bg-blue-500'
                          }`}
                          style={{ width: `${Math.min(100, row.usagePercent)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-10">{row.usagePercent}%</span>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-500">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {!row.isEditing && (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEdit(row.userId)}
                        className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
                        title={t('tokenQuota.editLimit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => resetQuota(row.userId)}
                        disabled={row.isSaving}
                        className="p-1.5 text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 rounded transition-colors disabled:opacity-50"
                        title={t('tokenQuota.resetToDefault')}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
