/**
 * REST Approval Service
 * 
 * Handles API calls for workflow human approval checkpoints.
 * Supports fetching pending/processed approvals and resolving checkpoints.
 */

import { restClient } from './restClient';
import { ServiceError } from '@/utils/errorHandling';

/**
 * Checkpoint status types
 */
export type CheckpointStatus = 'waiting' | 'resolved' | 'cancelled' | 'expired';

/**
 * Upstream output from a completed node
 */
export interface UpstreamOutput {
  title: string;
  output: unknown;
}

/**
 * Input context provided to the checkpoint
 */
export interface CheckpointInputContext {
  upstream_outputs: Record<string, UpstreamOutput>;
  variables: Record<string, unknown>;
}

/**
 * Checkpoint configuration stored on the node
 */
export interface CheckpointConfig {
  checkpointType: 'human_approval';
  instructions: string;
  approverRoles?: string[];
  expiresInSeconds?: number;
  timeoutAction?: 'expire' | 'auto_approve';
  displayFields?: string[];
}

/**
 * A checkpoint record from the API
 */
export interface Checkpoint {
  id: string;
  executionId: string;
  nodeId: string;
  nodeTitle: string;
  checkpointType: string;
  status: CheckpointStatus;
  config: CheckpointConfig;
  inputContext: CheckpointInputContext;
  createdAt: string;
  expiresAt: string | null;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: { approved: boolean; reason?: string };
  reason?: string;
}

/**
 * Request body for approving a checkpoint
 */
export interface ApproveCheckpointRequest {
  status: 'resolved';
  result: { approved: boolean; reason?: string };
  scopeId?: string;
}

/**
 * Request body for rejecting a checkpoint
 */
export interface RejectCheckpointRequest {
  status: 'cancelled';
  reason?: string;
}

/**
 * REST implementation of the Approval Service
 */
export const RestApprovalService = {
  /**
   * Fetches all pending checkpoints for the current user
   */
  async getPendingCheckpoints(): Promise<Checkpoint[]> {
    try {
      const response = await restClient.get<Checkpoint[] | { data: Checkpoint[] }>(
        '/api/workflows/checkpoints/pending'
      );
      // Handle both array and wrapped response formats
      if (Array.isArray(response)) return response;
      return response.data || [];
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('Failed to fetch pending checkpoints', 'UNKNOWN');
    }
  },

  /**
   * Fetches processed (resolved/cancelled/expired) checkpoints for the current user
   */
  async getProcessedCheckpoints(): Promise<Checkpoint[]> {
    try {
      const response = await restClient.get<Checkpoint[] | { data: Checkpoint[] }>(
        '/api/workflows/checkpoints/processed'
      );
      if (Array.isArray(response)) return response;
      return response.data || [];
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('Failed to fetch processed checkpoints', 'UNKNOWN');
    }
  },

  /**
   * Approves a checkpoint
   */
  async approveCheckpoint(
    executionId: string,
    checkpointId: string,
    reason?: string,
    scopeId?: string
  ): Promise<void> {
    try {
      const body: ApproveCheckpointRequest = {
        status: 'resolved',
        result: { approved: true, reason },
        scopeId,
      };
      await restClient.post(
        `/api/workflows/executions/${executionId}/checkpoints/${checkpointId}/resolve`,
        body
      );
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('Failed to approve checkpoint', 'UNKNOWN');
    }
  },

  /**
   * Rejects a checkpoint
   */
  async rejectCheckpoint(
    executionId: string,
    checkpointId: string,
    reason?: string
  ): Promise<void> {
    try {
      const body: RejectCheckpointRequest = {
        status: 'cancelled',
        reason,
      };
      await restClient.post(
        `/api/workflows/executions/${executionId}/checkpoints/${checkpointId}/resolve`,
        body
      );
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('Failed to reject checkpoint', 'UNKNOWN');
    }
  },
};

export default RestApprovalService;
