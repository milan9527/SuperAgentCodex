/**
 * K8s orchestration module — placeholder for production EKS deployment.
 * Not used in Docker/InsForge POC mode.
 *
 * In production, this module would:
 *   - Create K8s namespaces per tenant
 *   - Deploy InsForge instances as Helm releases
 *   - Manage Traefik IngressRoutes
 *
 * For the POC, all orchestration is handled by docker-compose + insforge.ts.
 */

export async function createTenantNamespace(_tenantName: string): Promise<void> {
  console.log('[k8s] Not implemented in Docker mode — use docker-compose');
}

export async function createTenantPG(_tenantName: string): Promise<string> {
  console.log('[k8s] Not implemented in Docker mode — InsForge PG is in docker-compose');
  return 'docker-compose';
}

export async function createAppDeployment(
  _tenantName: string,
  _appShortId: string,
  _config: any
): Promise<void> {
  console.log('[k8s] Not implemented in Docker mode — use insforge.ts');
}

export async function deleteApp(_tenantName: string, _appShortId: string): Promise<void> {
  console.log('[k8s] Not implemented in Docker mode — use insforge.ts');
}

export async function getAppStatus(_tenantName: string, _appShortId: string) {
  return { frontend: [], backend: [] };
}
