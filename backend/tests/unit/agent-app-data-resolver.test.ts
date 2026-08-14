import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('../../src/config/database.js', () => ({
  prisma: {
    published_apps: { findMany },
    app_backend_instances: { updateMany: vi.fn() },
  },
}));

import { agentAppDataResolver } from '../../src/services/agent-app-data-resolver.js';

describe('AgentAppDataResolverService', () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('uses a valid relation filter for active backend instances', async () => {
    await agentAppDataResolver.getAppBackendConfigs('org-1', {
      scopeId: 'scope-1',
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        org_id: 'org-1',
        backend_type: 'insforge',
        backend_instance: {
          is: { status: 'active' },
        },
        business_scope_id: 'scope-1',
      },
    }));
  });

  it('requires a backend instance without filtering its status when activeOnly is false', async () => {
    await agentAppDataResolver.getAppBackendConfigs('org-1', {
      activeOnly: false,
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        org_id: 'org-1',
        backend_type: 'insforge',
        backend_instance: {
          isNot: null,
        },
      },
    }));
  });
});
