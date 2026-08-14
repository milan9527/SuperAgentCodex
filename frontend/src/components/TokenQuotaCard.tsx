/**
 * Token Quota Card
 *
 * Displays the user's current token quota status with a progress bar,
 * usage numbers, and limit information.
 */

import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { QuotaStatus } from '@/services/api/tokenUsageService';

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getBarColor(percent: number): string {
  if (percent >= 100) return 'bg-red-500';
  if (percent >= 80) return 'bg-yellow-500';
  return 'bg-blue-500';
}

function getStatusIcon(percent: number) {
  if (percent >= 100) return <XCircle className="w-5 h-5 text-red-400" />;
  if (percent >= 80) return <AlertTriangle className="w-5 h-5 text-yellow-400" />;
  return <CheckCircle className="w-5 h-5 text-green-400" />;
}

interface TokenQuotaCardProps {
  quota: QuotaStatus;
}

export function TokenQuotaCard({ quota }: TokenQuotaCardProps) {
  const { t } = useTranslation();

  const isUnlimited = quota.tokenLimit === 0 && quota.costLimit === 0;
  const percent = isUnlimited ? 0 : quota.usagePercent;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-white flex items-center gap-2">
          {getStatusIcon(percent)}
          {t('tokenQuota.title')}
        </h3>
        {isUnlimited ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
            {t('tokenQuota.unlimited')}
          </span>
        ) : (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            percent >= 100
              ? 'bg-red-500/10 text-red-400 border-red-500/20'
              : percent >= 80
                ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
          }`}>
            {percent}% {t('tokenQuota.used')}
          </span>
        )}
      </div>

      {!isUnlimited && (
        <>
          {/* Progress bar */}
          <div className="w-full h-2.5 bg-gray-800 rounded-full overflow-hidden mb-3">
            <div
              className={`h-full rounded-full transition-all duration-500 ${getBarColor(percent)}`}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>

          {/* Usage numbers */}
          <div className="flex justify-between text-xs text-gray-400">
            <span>
              {formatTokens(quota.currentTokens)} / {formatTokens(quota.tokenLimit)} tokens
            </span>
            <span>
              ${quota.currentCostUsd.toFixed(2)} / ${quota.costLimit.toFixed(2)}
            </span>
          </div>
        </>
      )}

      {isUnlimited && (
        <div className="text-xs text-gray-500 mt-1">
          {t('tokenQuota.unlimitedDesc')}
        </div>
      )}

      {/* Warning message when approaching or exceeding limit */}
      {percent >= 80 && percent < 100 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-yellow-400 bg-yellow-500/5 border border-yellow-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {t('tokenQuota.warningApproaching')}
        </div>
      )}

      {percent >= 100 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          {t('tokenQuota.warningExceeded')}
        </div>
      )}
    </div>
  );
}
