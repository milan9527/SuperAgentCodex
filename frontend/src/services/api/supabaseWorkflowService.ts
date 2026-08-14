/**
 * Backward-compatible service name retained for older extensions.
 * The platform now uses the REST backend for persisted workflow data.
 */
export { RestWorkflowService as SupabaseWorkflowService } from './restWorkflowService';
