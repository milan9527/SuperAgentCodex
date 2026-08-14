/**
 * AgentPermissionsPanel
 *
 * UI component for managing agent-level permissions.
 * Shows visibility settings, owner info, and authorized users.
 * Only visible to users with admin/owner access to the agent.
 */

import { useState } from 'react';
import { Shield, Eye, EyeOff, Globe, Users, Plus, X, ChevronDown } from 'lucide-react';
import { useAgentPermissions, type AgentPermission, type AgentAccessLevel } from '@/services/useAgentPermissions';
import { useMembers } from '@/services/useMembers';
import { useTranslation } from '@/i18n';

interface AgentPermissionsPanelProps {
  agentId: string;
  agentVisibility?: string;
  agentCreatedBy?: string | null;
  agentOrigin?: string;
}

const PERMISSION_LABELS: Record<string, { label: string; color: string }> = {
  owner: { label: '所有者', color: 'text-yellow-400' },
  admin: { label: '管理员 (可编辑)', color: 'text-purple-400' },
  invoke: { label: '可调用', color: 'text-blue-400' },
  view: { label: '可查看', color: 'text-gray-400' },
};

const VISIBILITY_OPTIONS = [
  { value: 'public', label: '公开', desc: '组织内所有成员可调用', icon: Globe },
  { value: 'scope_default', label: '跟随 Scope', desc: '继承业务域的可见性设置', icon: Users },
  { value: 'private', label: '私有', desc: '仅 Owner 和被授权者可访问', icon: EyeOff },
] as const;

export function AgentPermissionsPanel({
  agentId,
  agentVisibility = 'scope_default',
  agentCreatedBy,
  agentOrigin,
}: AgentPermissionsPanelProps) {
  const { t } = useTranslation();
  const {
    permissions,
    myAccessLevel,
    isLoading,
    canManage,
    grantPermission,
    updatePermission,
    revokePermission,
    updateVisibility,
  } = useAgentPermissions(agentId);

  const { members } = useMembers();
  const [showAddUser, setShowAddUser] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedPermission, setSelectedPermission] = useState<'admin' | 'invoke' | 'view'>('invoke');
  const [currentVisibility, setCurrentVisibility] = useState(agentVisibility);

  const isDigitalTwin = agentOrigin === 'digital_twin';

  // Filter out users who already have permissions
  const existingUserIds = new Set(permissions.map(p => p.user_id));
  const availableMembers = members.filter(m => !existingUserIds.has(m.user_id));

  const handleVisibilityChange = async (visibility: 'public' | 'scope_default' | 'private') => {
    const success = await updateVisibility(visibility);
    if (success) setCurrentVisibility(visibility);
  };

  const handleAddPermission = async () => {
    if (!selectedUserId) return;
    await grantPermission(selectedUserId, selectedPermission);
    setShowAddUser(false);
    setSelectedUserId('');
    setSelectedPermission('invoke');
  };

  const handleUpdatePermission = async (permId: string, newPerm: 'admin' | 'invoke' | 'view') => {
    await updatePermission(permId, newPerm);
  };

  const handleRevokePermission = async (permId: string) => {
    if (window.confirm('确定要移除此用户的权限吗？')) {
      await revokePermission(permId);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 text-center text-gray-400">
        加载权限信息...
      </div>
    );
  }

  // Non-admin users see a read-only summary
  if (!canManage) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2 text-gray-400">
          <Shield className="w-4 h-4" />
          <span className="text-sm">
            你对此 Agent 的权限: <span className="text-white font-medium">
              {PERMISSION_LABELS[myAccessLevel]?.label || myAccessLevel}
            </span>
          </span>
        </div>
      </div>
    );
  }

  const ownerPermission = permissions.find(p => p.permission === 'owner');
  const nonOwnerPermissions = permissions.filter(p => p.permission !== 'owner');

  return (
    <div className="p-6 space-y-6">
      {/* Visibility Setting */}
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
          <Eye className="w-4 h-4" />
          可见性
        </h3>
        <div className="space-y-2">
          {VISIBILITY_OPTIONS.map(opt => (
            <label
              key={opt.value}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                currentVisibility === opt.value
                  ? 'border-blue-500/50 bg-blue-500/10'
                  : 'border-gray-700 hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="visibility"
                value={opt.value}
                checked={currentVisibility === opt.value}
                onChange={() => handleVisibilityChange(opt.value)}
                className="sr-only"
              />
              <opt.icon className={`w-4 h-4 ${currentVisibility === opt.value ? 'text-blue-400' : 'text-gray-500'}`} />
              <div>
                <div className={`text-sm ${currentVisibility === opt.value ? 'text-white' : 'text-gray-300'}`}>
                  {opt.label}
                </div>
                <div className="text-xs text-gray-500">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Owner */}
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-3">
          {isDigitalTwin ? '所有者 (本人)' : 'Owner'}
        </h3>
        {ownerPermission ? (
          <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400 text-sm font-medium">
              {(ownerPermission.name || ownerPermission.email || '?').charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white truncate">{ownerPermission.name || ownerPermission.email}</div>
              {ownerPermission.email && ownerPermission.name && (
                <div className="text-xs text-gray-500 truncate">{ownerPermission.email}</div>
              )}
            </div>
            <span className="text-xs text-yellow-400 font-medium">Owner</span>
          </div>
        ) : agentCreatedBy ? (
          <div className="text-sm text-gray-500 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            创建者 ID: {agentCreatedBy.slice(0, 8)}...
          </div>
        ) : (
          <div className="text-sm text-gray-500 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            未记录创建者 (历史 Agent)
          </div>
        )}
      </div>

      {/* Authorized Users */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-300">
            授权用户
          </h3>
          <button
            onClick={() => setShowAddUser(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded transition-colors"
          >
            <Plus size={14} />
            <span>添加</span>
          </button>
        </div>

        {/* Add user form */}
        {showAddUser && (
          <div className="mb-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700 space-y-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">选择用户</label>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
              >
                <option value="">-- 选择 --</option>
                {availableMembers.map(m => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">权限级别</label>
              <select
                value={selectedPermission}
                onChange={(e) => setSelectedPermission(e.target.value as any)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
              >
                <option value="admin">管理员 (可编辑)</option>
                <option value="invoke">可调用</option>
                <option value="view">可查看</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleAddPermission}
                disabled={!selectedUserId}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                确认添加
              </button>
              <button
                onClick={() => setShowAddUser(false)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* Permission list */}
        {nonOwnerPermissions.length === 0 ? (
          <div className="text-sm text-gray-500 p-3 bg-gray-800/30 rounded-lg border border-gray-700/50 text-center">
            暂无授权用户
          </div>
        ) : (
          <div className="space-y-2">
            {nonOwnerPermissions.map(perm => (
              <div
                key={perm.id}
                className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700"
              >
                <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-gray-300 text-sm font-medium">
                  {(perm.name || perm.email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{perm.name || perm.email}</div>
                  {perm.email && perm.name && (
                    <div className="text-xs text-gray-500 truncate">{perm.email}</div>
                  )}
                </div>
                <select
                  value={perm.permission}
                  onChange={(e) => handleUpdatePermission(perm.id, e.target.value as any)}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
                >
                  <option value="admin">管理员</option>
                  <option value="invoke">可调用</option>
                  <option value="view">可查看</option>
                </select>
                <button
                  onClick={() => handleRevokePermission(perm.id)}
                  className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                  title="移除权限"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
