/**
 * Agent App Data Resolver
 *
 * Resolves InsForge backend MCP configurations for agents operating within
 * a business scope. When a Scope Agent or Digital Twin needs to access app
 * data, this service:
 *
 * 1. Finds all published apps with InsForge backends in the given scope
 * 2. Generates MCP server configurations pointing to each app's InsForge instance
 * 3. Returns configs that can be injected into the agent's workspace settings
 *
 * This enables agents to discover and access app data through the standard
 * MCP protocol without any manual configuration.
 */

import { prisma } from '../config/database.js';
import type { MCPServerSDKConfig } from './agent-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppBackendMcpConfig {
  /** Unique key for the MCP server entry (e.g., "app-backend-crm-app") */
  key: string;
  /** Human-readable name */
  displayName: string;
  /** The app this backend belongs to */
  appId: string;
  appName: string;
  /** MCP server SDK config (compatible with Claude Agent SDK) */
  config: MCPServerSDKConfig;
}

export interface ResolverOptions {
  /** Only include apps in this scope */
  scopeId?: string;
  /** Only include a specific app */
  appId?: string;
  /** Only include active backends (default: true) */
  activeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AgentAppDataResolverService {

  /**
   * Resolve all available InsForge MCP configs for an agent in a given org/scope.
   *
   * Returns a Record<string, MCPServerSDKConfig> that can be merged into
   * the agent's workspace settings.json mcpServers section.
   */
  async resolveForAgent(
    organizationId: string,
    options: ResolverOptions = {},
  ): Promise<Record<string, MCPServerSDKConfig>> {
    const configs = await this.getAppBackendConfigs(organizationId, options);
    const result: Record<string, MCPServerSDKConfig> = {};

    for (const cfg of configs) {
      result[cfg.key] = cfg.config;
    }

    return result;
  }

  /**
   * Get detailed app backend MCP configs (includes app metadata).
   */
  async getAppBackendConfigs(
    organizationId: string,
    options: ResolverOptions = {},
  ): Promise<AppBackendMcpConfig[]> {
    const { scopeId, appId, activeOnly = true } = options;

    // Build query conditions
    const where: Record<string, unknown> = {
      org_id: organizationId,
      backend_type: 'insforge',
      backend_instance: activeOnly
        ? { is: { status: 'active' } }
        : { isNot: null },
    };

    if (scopeId) {
      where.business_scope_id = scopeId;
    }

    if (appId) {
      where.id = appId;
    }

    const apps = await prisma.published_apps.findMany({
      where: where as any,
      include: {
        backend_instance: true,
      },
      orderBy: { name: 'asc' },
    });

    return apps
      .filter(app => app.backend_instance)
      .map(app => {
        const instance = app.backend_instance!;
        const sanitizedName = app.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30);

        const key = `app-data-${sanitizedName}-${app.id.slice(0, 8)}`;

        return {
          key,
          displayName: `${app.name} 数据`,
          appId: app.id,
          appName: app.name,
          config: this.buildMcpConfig(instance, app.id),
        };
      });
  }

  /**
   * Build an MCPServerSDKConfig for a single InsForge instance.
   *
   * The InsForge MCP server is accessed via streamable HTTP transport
   * at the project's app port.
   */
  private buildMcpConfig(instance: {
    host: string;
    port_app: number;
    api_key: string;
    mcp_endpoint: string | null;
  }, appId: string): MCPServerSDKConfig {
    // InsForge MCP uses stdio transport via npx
    // The schema context tells the MCP server which schema to operate on
    const schemaName = `app_${appId.replace(/-/g, '').slice(0, 12)}`;

    return {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'insforge-mcp@latest',
        '--url', `http://${instance.host}:${instance.port_app}`,
        '--api-key', instance.api_key,
      ],
      env: {
        INSFORGE_URL: `http://${instance.host}:${instance.port_app}`,
        INSFORGE_API_KEY: instance.api_key,
        INSFORGE_SCHEMA: schemaName,
      },
    };
  }

  /** Inject InsForge MCP configs into the workspace's active runtime config. */
  async injectIntoWorkspace(
    workspacePath: string,
    organizationId: string,
    scopeId: string,
  ): Promise<number> {
    const configs = await this.resolveForAgent(organizationId, { scopeId });
    if (Object.keys(configs).length === 0) return 0;

    const { workspaceManager } = await import('./workspace-manager.js');
    const existing = await workspaceManager.readWorkspaceMcpServers(workspacePath);
    await workspaceManager.writeWorkspaceMcpServers(workspacePath, {
      ...existing,
      ...configs,
    });

    return Object.keys(configs).length;
  }

  /**
   * Remove InsForge MCP configs from a workspace (e.g., when backend is destroyed).
   */
  async removeFromWorkspace(
    workspacePath: string,
    appId: string,
  ): Promise<void> {
    try {
      const { workspaceManager } = await import('./workspace-manager.js');
      const mcpServers = await workspaceManager.readWorkspaceMcpServers(workspacePath);

      // Remove entries that match the app ID pattern
      const prefix = `app-data-`;
      const suffix = `-${appId.slice(0, 8)}`;
      for (const key of Object.keys(mcpServers)) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          delete mcpServers[key];
        }
      }

      await workspaceManager.writeWorkspaceMcpServers(workspacePath, mcpServers);
    } catch {
      // Non-critical — workspace may not exist
    }
  }

  /**
   * Touch activity on the InsForge instance when an agent accesses it.
   * Called by the agent runtime when MCP tools from an app backend are invoked.
   */
  async recordAgentAccess(appId: string, agentId: string, operation: string): Promise<void> {
    // Update last_active_at
    await prisma.app_backend_instances.updateMany({
      where: { app_id: appId, status: 'active' },
      data: { last_active_at: new Date() },
    });

    // TODO: Write to audit log table (agent_data_access_log)
    // For now, just log
    console.log(`[AgentAppData] Agent ${agentId} accessed app ${appId}: ${operation}`);
  }
}

export const agentAppDataResolver = new AgentAppDataResolverService();
