#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POC_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== App Host POC — Local Deployment ==="
echo ""

# 1. Create kind cluster
echo "[1/6] Creating kind cluster..."
if kind get clusters 2>/dev/null | grep -q "app-host-poc"; then
  echo "  Cluster already exists, skipping."
else
  kind create cluster --config "$POC_DIR/kind-config.yaml"
fi

# 2. Set kubectl context
kubectl cluster-info --context kind-app-host-poc

# 3. Build and load images
echo ""
echo "[2/6] Building and loading Docker images..."

echo "  Building app-host-api..."
docker build -t app-host-api:poc "$POC_DIR/services/app-host-api/" 2>/dev/null || {
  echo "  WARNING: app-host-api build failed, using placeholder"
}

echo "  Building app-runtime..."
docker build -t app-runtime:poc "$POC_DIR/services/runtime/" 2>/dev/null || {
  echo "  WARNING: app-runtime build failed, using placeholder"
}

echo "  Loading images into kind..."
kind load docker-image app-host-api:poc --name app-host-poc 2>/dev/null || true
kind load docker-image app-runtime:poc --name app-host-poc 2>/dev/null || true

# 4. Deploy infrastructure
echo ""
echo "[3/6] Deploying Traefik Ingress..."
kubectl apply -f "$POC_DIR/k8s/infra/traefik.yaml"
kubectl wait --for=condition=available deployment/traefik -n traefik-system --timeout=60s 2>/dev/null || true

echo ""
echo "[4/6] Deploying App Host API..."
kubectl apply -f "$POC_DIR/k8s/infra/app-host-api.yaml"
kubectl wait --for=condition=available deployment/app-host-api -n app-host-system --timeout=60s 2>/dev/null || true

# 5. Create PG roles for each tenant before deploying apps
echo ""
echo "[5/6] Deploying tenants..."

for tenant_file in "$POC_DIR/k8s/tenants"/tenant-*.yaml; do
  tenant_name=$(basename "$tenant_file" .yaml | sed 's/tenant-//')
  echo "  Deploying tenant: $tenant_name"
  kubectl apply -f "$tenant_file"

  # Wait for tenant DB to be ready
  kubectl wait --for=condition=ready pod -l app=tenant-db -n "$tenant_name" --timeout=90s 2>/dev/null || true

  # Create app-specific PG role inside tenant DB
  echo "    Creating PG roles in tenant DB..."
  case "$tenant_name" in
    dunhe)
      kubectl exec -n dunhe statefulset/tenant-db -- psql -U tenant_admin -d tenant_dunhe -c \
        "DO \$\$ BEGIN CREATE ROLE app_550e8400e29b WITH LOGIN PASSWORD 'schedule123'; EXCEPTION WHEN DUPLICATE_OBJECT THEN NULL; END \$\$; \
         GRANT CREATE ON DATABASE tenant_dunhe TO app_550e8400e29b;" 2>/dev/null || true
      ;;
    othermedia)
      kubectl exec -n othermedia statefulset/tenant-db -- psql -U tenant_admin -d tenant_othermedia -c \
        "DO \$\$ BEGIN CREATE ROLE app_4d5e6f7a8b9c WITH LOGIN PASSWORD 'crm123'; EXCEPTION WHEN DUPLICATE_OBJECT THEN NULL; END \$\$; \
         GRANT CREATE ON DATABASE tenant_othermedia TO app_4d5e6f7a8b9c;" 2>/dev/null || true
      ;;
    testcorp)
      kubectl exec -n testcorp statefulset/tenant-db -- psql -U tenant_admin -d tenant_testcorp -c \
        "DO \$\$ BEGIN CREATE ROLE app_9a0b1c2d3e4f WITH LOGIN PASSWORD 'dash123'; EXCEPTION WHEN DUPLICATE_OBJECT THEN NULL; END \$\$; \
         GRANT CREATE ON DATABASE tenant_testcorp TO app_9a0b1c2d3e4f;" 2>/dev/null || true
      ;;
  esac
done

# 6. Show status
echo ""
echo "[6/6] Status:"
echo ""
kubectl get namespaces -l tenant
echo ""
kubectl get pods --all-namespaces | grep -E "NAME|tenant-db|schedule|crm|dashboard|traefik|app-host"
echo ""

# Show access URLs
echo "=== Access URLs ==="
echo ""
echo "Add these entries to your /etc/hosts (or hosts file):"
echo "  127.0.0.1 550e8400e29b.app.poc.local"
echo "  127.0.0.1 4d5e6f7a8b9c.app.poc.local"
echo "  127.0.0.1 9a0b1c2d3e4f.app.poc.local"
echo ""
echo "Then visit:"
echo "  http://550e8400e29b.app.poc.local:8080  — 敦和国际 排期管理"
echo "  http://4d5e6f7a8b9c.app.poc.local:8080  — 另一家传媒 客户管理"
echo "  http://9a0b1c2d3e4f.app.poc.local:8080  — 测试公司 数据看板"
echo ""
echo "Traefik dashboard: http://localhost:8081"
