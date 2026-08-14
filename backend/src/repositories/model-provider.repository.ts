/**
 * Model Provider Repository
 * Data access for reusable per-org LLM provider configs.
 */

import { prisma } from '../config/database.js';

export interface ModelProviderEntity {
  id: string;
  organization_id: string;
  name: string;
  type: string; // 'bedrock' | 'litellm'
  base_url: string | null;
  credential_id: string | null;
  default_model_id: string | null;
  is_org_default: boolean;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

class ModelProviderRepository {
  async findAll(organizationId: string): Promise<ModelProviderEntity[]> {
    return prisma.model_providers.findMany({
      where: { organization_id: organizationId },
      orderBy: [{ is_org_default: 'desc' }, { created_at: 'asc' }],
    }) as unknown as ModelProviderEntity[];
  }

  async findById(id: string, organizationId: string): Promise<ModelProviderEntity | null> {
    return prisma.model_providers.findFirst({
      where: { id, organization_id: organizationId },
    }) as unknown as ModelProviderEntity | null;
  }

  async findByName(organizationId: string, name: string): Promise<ModelProviderEntity | null> {
    return prisma.model_providers.findFirst({
      where: { organization_id: organizationId, name },
    }) as unknown as ModelProviderEntity | null;
  }

  async findOrgDefault(organizationId: string): Promise<ModelProviderEntity | null> {
    return prisma.model_providers.findFirst({
      where: { organization_id: organizationId, is_org_default: true },
    }) as unknown as ModelProviderEntity | null;
  }

  async create(
    data: Omit<ModelProviderEntity, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ModelProviderEntity> {
    return prisma.model_providers.create({
      data,
    }) as unknown as ModelProviderEntity;
  }

  async update(
    id: string,
    organizationId: string,
    data: Partial<Omit<ModelProviderEntity, 'id' | 'organization_id' | 'created_at' | 'updated_at'>>,
  ): Promise<ModelProviderEntity | null> {
    const result = await prisma.model_providers.updateMany({
      where: { id, organization_id: organizationId },
      data,
    });
    if (result.count === 0) return null;
    return this.findById(id, organizationId);
  }

  async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await prisma.model_providers.deleteMany({
      where: { id, organization_id: organizationId },
    });
    return result.count > 0;
  }

  /** Clears is_org_default on all of an org's providers (used before setting a new default). */
  async clearOrgDefault(organizationId: string): Promise<void> {
    await prisma.model_providers.updateMany({
      where: { organization_id: organizationId, is_org_default: true },
      data: { is_org_default: false },
    });
  }
}

export const modelProviderRepository = new ModelProviderRepository();
