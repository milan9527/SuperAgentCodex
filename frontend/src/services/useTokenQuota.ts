import { useState, useCallback, useEffect, useRef } from 'react';
import { TokenUsageService, type QuotaStatus, type PlanQuota } from './api/tokenUsageService';

/**
 * Hook to fetch and manage the current user's token quota status.
 */
export function useMyQuota() {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await TokenUsageService.getMyQuota();
      if (mountedRef.current) setQuota(data);
    } catch (e) {
      console.error('Failed to load quota status:', e);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return { quota, isLoading, reload: load };
}

/**
 * Hook to fetch plan quota definitions.
 */
export function usePlanQuotas() {
  const [plans, setPlans] = useState<Record<string, PlanQuota>>({});
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await TokenUsageService.getPlanQuotas();
      if (mountedRef.current) setPlans(data);
    } catch (e) {
      console.error('Failed to load plan quotas:', e);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return { plans, isLoading, reload: load };
}

/**
 * Hook to manage per-user quota overrides (admin only).
 */
export function useQuotaOverrides() {
  const [overrides, setOverrides] = useState<Record<string, Partial<PlanQuota>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await TokenUsageService.getQuotaOverrides();
      if (mountedRef.current) setOverrides(data);
    } catch (e) {
      console.error('Failed to load quota overrides:', e);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setUserQuota = useCallback(async (userId: string, quota: Partial<PlanQuota>) => {
    await TokenUsageService.setUserQuota(userId, quota);
    await load();
  }, [load]);

  const removeUserQuota = useCallback(async (userId: string) => {
    await TokenUsageService.removeUserQuota(userId);
    await load();
  }, [load]);

  return { overrides, isLoading, reload: load, setUserQuota, removeUserQuota };
}
