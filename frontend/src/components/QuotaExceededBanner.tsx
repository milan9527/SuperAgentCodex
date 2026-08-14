/**
 * Quota Exceeded Banner
 *
 * Displayed inline in the chat when a 429 QUOTA_EXCEEDED error is received.
 * Shows the user their usage and suggests contacting admin for a limit increase.
 */

import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/i18n';

interface QuotaExceededBannerProps {
  reason?: string;
  currentTokens?: number;
  tokenLimit?: number;
  usagePercent?: number;
  onDismiss?: () => void;
}

export function QuotaExceededBanner({
  reason,
  currentTokens,
  tokenLimit,
  usagePercent,
  onDismiss,
}: QuotaExceededBannerProps) {
  const { t } = useTranslation();

  return (
    <div className="mx-4 my-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-red-300">
            {t('tokenQuota.exceededTitle')}
          </h4>
          <p className="text-xs text-red-400/80 mt-1">
            {reason || t('tokenQuota.exceededMessage')}
          </p>
          {currentTokens != null && tokenLimit != null && tokenLimit > 0 && (
            <div className="mt-2">
              <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-red-500 rounded-full"
                  style={{ width: '100%' }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {usagePercent ?? 100}% — {t('tokenQuota.contactAdmin')}
              </p>
            </div>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-gray-500 hover:text-gray-300 text-xs"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
