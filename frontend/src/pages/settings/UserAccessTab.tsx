/**
 * UserAccessTab — View and manage agent access per user.
 *
 * Admin-only tab in Settings that shows which agents each user can access,
 * the source of that access, and allows granting/revoking permissions.
 */

import { useState, useEffect, useCallback } from 'react';
import { Search, Shield, Users, Loader2, X, Plus, ChevronDown } from 'lucide-react';
import { restClient } from '@/services/api/restClient';
import { useMembers } from '@/services/useMembers';

interface UserAgentAccess {
  id: string;
  name: string;
  display_name: string;
  role: string | null;
  origin: string;
  business_scope_id: string | null;
  scope_name: string | null;
  access_level: string;
  access_source: string;
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  explicit: { label: '显式授权', color: 'bg-blue-500/20 text-blue-300' },
  creator: { label: '创建者', color: 'bg-yellow-500/20 text-yellow-300' },
  scope_membership: { label: 'Scope 成员', color: 'bg-purple-500/20 text-purple-300' },
  public: { label: '公开 Agent', color: 'bg-green-500/20 text-green-300' },
  scope_open: { label: '开放 Scope', color: 'bg-gray-500/20 text-gray-300' },
};

const LEVEL_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  invoke: '可调用',
  view: '可查看',
};

interface Props {
  isAdmin: boolean;
}

export function UserAccessTab({ isAdmin }: Props) {
  const { members } = useMembers();
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [agentAccess, setAgentAccess] = useState<UserAgentAccess[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');

  const loadUserAccess = useCallback(async (userId: string) => {
    if (!userId) { setAgentAccess([]); return; }
    setLoading(true);
    try {
      const res = await restClient.get<{ data: UserAgentAccess[] }>(
        `/api/agents/user-access/${userId}`
      );
      setAgentAccess(res.data || []);
    } catch {
      setAgentAccess([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      loadUserAccess(selectedUserId);
    }
  }, [selectedUserId, loadUserAccess]);

  const handleRevokeExplicit = async (agentId: string) => {
    if (!window.confirm('确定要移除此用户对该 Agent 的显式授权吗？')) return;
    try {
      // Find the permission record to delete
      const permsRes = await restClient.get<{ data: Array<{ id: string; user_id: string }> }>(
        `/api/agents/${agentId}/permissions`
      );
      const perm = permsRes.data?.find(p => p.user_id === selectedUserId);
      if (perm) {
        await restClient.delete(`/api/agents/${agentId}/permissions/${perm.id}`);
        await loadUserAccess(selectedUserId);
      }
    } catch (err) {
      console.error('Failed to revoke:', err);
    }
  };

  // Filter agents by search
  const filteredAccess = agentAccess.filter(a => {
    if (!searchFilter) return true;
    const q = searchFilter.toLowerCase();
    return a.display_name.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      (a.scope_name || '').toLowerCase().includes(q);
  });

  // Group by access source
  const grouped = {
    explicit: filteredAccess.filter(a => a.access_source === 'explicit' || a.access_source === 'creator'),
    scope: filteredAccess.filter(a => a.access_source === 'scope_membership'),
    inherited: filteredAccess.filter(a => a.access_source === 'public' || a.access_source === 'scope_open'),
  };

  if (!isAdmin) {
    return (
      <div className="text-center text-gray-500 py-8">
        仅管理员可查看用户权限总览
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* User selector */}
      <div>
        <label className="text-sm text-gray-400 mb-2 block">选择用户查看其 Agent 访问权限</label>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white focus:border-blue-500 focus:outline-none"
        >
          <option value="">-- 选择用户 --</option>
          {members.map(m => (
            <option key={m.user_id} value={m.user_id}>
              {m.name || m.email} ({m.role})
            </option>
          ))}
        </select>
      </div>

      {/* Results */}
      {selectedUserId && (
        <>
          {/* Search filter */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="搜索 Agent 名称或 Scope..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
            </div>
          ) : agentAccess.length === 0 ? (
            <div className="text-center text-gray-500 py-8 bg-gray-800/30 rounded-lg border border-gray-700/50">
              该用户无法访问任何 Agent
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary */}
              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-400">
                  共 <span className="text-white font-medium">{agentAccess.length}</span> 个可访问 Agent
                </span>
                <span className="text-gray-600">|</span>
                <span className="text-blue-400">{grouped.explicit.length} 显式授权</span>
                <span className="text-purple-400">{grouped.scope.length} Scope 继承</span>
                <span className="text-gray-400">{grouped.inherited.length} 公开/开放</span>
              </div>

              {/* Explicit permissions */}
              {grouped.explicit.length > 0 && (
                <AccessGroup
                  title="显式授权 / 创建者"
                  subtitle="通过 agent_permissions 表直接授予或作为创建者拥有"
                  items={grouped.explicit}
                  canRevoke
                  onRevoke={handleRevokeExplicit}
                />
              )}

              {/* Scope membership */}
              {grouped.scope.length > 0 && (
                <AccessGroup
                  title="Scope 成员继承"
                  subtitle="通过 Scope 成员角色自动获得的权限"
                  items={grouped.scope}
                />
              )}

              {/* Public / open scope */}
              {grouped.inherited.length > 0 && (
                <AccessGroup
                  title="公开 / 开放 Scope"
                  subtitle="Agent 设为公开或所在 Scope 为开放模式"
                  items={grouped.inherited}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AccessGroup({ title, subtitle, items, canRevoke, onRevoke }: {
  title: string;
  subtitle: string;
  items: UserAgentAccess[];
  canRevoke?: boolean;
  onRevoke?: (agentId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-gray-800/30 border border-gray-700/50 rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="text-left">
          <h4 className="text-sm font-medium text-white">{title} ({items.length})</h4>
          <p className="text-[11px] text-gray-500">{subtitle}</p>
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>

      {!collapsed && (
        <div className="border-t border-gray-700/50">
          <div className="divide-y divide-gray-700/30">
            {items.map(item => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[10px] font-medium flex-shrink-0">
                  {item.display_name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{item.display_name}</p>
                  <p className="text-[10px] text-gray-500 truncate">
                    {item.scope_name ? `${item.scope_name} · ` : ''}{item.role || item.origin}
                  </p>
                </div>
                <span className="text-[10px] text-gray-400 font-medium">
                  {LEVEL_LABELS[item.access_level] || item.access_level}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${SOURCE_LABELS[item.access_source]?.color || 'bg-gray-500/20 text-gray-300'}`}>
                  {SOURCE_LABELS[item.access_source]?.label || item.access_source}
                </span>
                {canRevoke && item.access_source === 'explicit' && onRevoke && (
                  <button
                    onClick={() => onRevoke(item.id)}
                    className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                    title="移除授权"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
