/**
 * useAgentPermissions Hook
 *
 * React hook for managing agent-level permissions.
 * Provides CRUD operations for agent permissions and visibility settings.
 */

import { useState, useEffect, useCallback } from 'react';
import { restClient } from './api/restClient';

export type AgentAccessLevel = 'owner' | 'admin' | 'invoke' | 'view' | 'none';

export interface AgentPermission {
  id: string;
  user_id: string;
  permission: AgentAccessLevel;
  granted_by: string | null;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface AgentVisibility {
  visibility: 'public' | 'scope_default' | 'private';
}

export function useAgentPermissions(agentId: string | null) {
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [myAccessLevel, setMyAccessLevel] = useState<AgentAccessLevel>('none');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch permissions list
  const fetchPermissions = useCallback(async () => {
    if (!agentId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await restClient.get<{ data: AgentPermission[] }>(
        `/api/agents/${agentId}/permissions`
      );
      setPermissions(response.data ?? []);
    } catch (err: any) {
      // 403 means user doesn't have admin access — that's fine, just can't manage
      if (err?.status === 403) {
        setPermissions([]);
      } else {
        setError(err?.message || 'Failed to load permissions');
      }
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  // Fetch current user's access level
  const fetchMyAccessLevel = useCallback(async () => {
    if (!agentId) return;
    try {
      const response = await restClient.get<{ agent_id: string; level: AgentAccessLevel }>(
        `/api/agents/${agentId}/access-level`
      );
      setMyAccessLevel(response.level);
    } catch {
      setMyAccessLevel('none');
    }
  }, [agentId]);

  useEffect(() => {
    fetchPermissions();
    fetchMyAccessLevel();
  }, [fetchPermissions, fetchMyAccessLevel]);

  // Grant permission to a user
  const grantPermission = useCallback(async (
    userId: string,
    permission: 'admin' | 'invoke' | 'view' = 'invoke'
  ) => {
    if (!agentId) return null;
    try {
      const result = await restClient.post<AgentPermission>(
        `/api/agents/${agentId}/permissions`,
        { user_id: userId, permission }
      );
      await fetchPermissions();
      return result;
    } catch (err: any) {
      setError(err?.message || 'Failed to grant permission');
      return null;
    }
  }, [agentId, fetchPermissions]);

  // Update a permission
  const updatePermission = useCallback(async (
    permId: string,
    permission: 'admin' | 'invoke' | 'view'
  ) => {
    if (!agentId) return false;
    try {
      await restClient.patch(
        `/api/agents/${agentId}/permissions/${permId}`,
        { permission }
      );
      await fetchPermissions();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Failed to update permission');
      return false;
    }
  }, [agentId, fetchPermissions]);

  // Revoke a permission
  const revokePermission = useCallback(async (permId: string) => {
    if (!agentId) return false;
    try {
      await restClient.delete(`/api/agents/${agentId}/permissions/${permId}`);
      await fetchPermissions();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke permission');
      return false;
    }
  }, [agentId, fetchPermissions]);

  // Update agent visibility
  const updateVisibility = useCallback(async (visibility: 'public' | 'scope_default' | 'private') => {
    if (!agentId) return false;
    try {
      await restClient.patch(`/api/agents/${agentId}/visibility`, { visibility });
      return true;
    } catch (err: any) {
      setError(err?.message || 'Failed to update visibility');
      return false;
    }
  }, [agentId]);

  return {
    permissions,
    myAccessLevel,
    isLoading,
    error,
    grantPermission,
    updatePermission,
    revokePermission,
    updateVisibility,
    refetch: fetchPermissions,
    // Convenience checks
    canManage: myAccessLevel === 'owner' || myAccessLevel === 'admin',
    canEdit: myAccessLevel === 'owner' || myAccessLevel === 'admin',
    canInvoke: myAccessLevel !== 'none' && myAccessLevel !== 'view',
    canView: myAccessLevel !== 'none',
    isOwner: myAccessLevel === 'owner',
  };
}
