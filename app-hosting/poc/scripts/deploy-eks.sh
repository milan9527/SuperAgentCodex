#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POC_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== App Host POC — AWS EKS Deployment ==="
echo ""

# 1. CDK deploy
echo "[1/4] Deploying CDK stack (EKS + S3 + IAM)..."
cd "$POC_DIR/cdk"
npm install
npx cdk deploy --require-approval never --all

# 2. Get kubeconfig
echo ""
echo "[2/4] Updating kubeconfig..."
CLUSTER_NAME=$(aws eks list-clusters --query 'clusters[?contains(@, `app-host`)]' --output text | head -1)
aws eks update-kubeconfig --name "$CLUSTER_NAME"

# 3. Build and push images to ECR
echo ""
echo "[3/4] Building and pushing images to ECR..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" 2>/dev/null || true

for img in app-host-api app-runtime; do
  echo "  Building $img..."
  docker build -t "$img:poc" "$POC_DIR/services/$img/"
  docker tag "$img:poc" "$REGISTRY/$img:poc"
  docker push "$REGISTRY/$img:poc"
done

# 4. Deploy K8s manifests
echo ""
echo "[4/4] Applying K8s manifests..."
kubectl apply -f "$POC_DIR/k8s/infra/traefik.yaml"
kubectl apply -f "$POC_DIR/k8s/infra/app-host-api.yaml"

for tenant_file in "$POC_DIR/k8s/tenants"/tenant-*.yaml; do
  kubectl apply -f "$tenant_file"
done

echo ""
echo "=== Done! ==="
echo ""
echo "Get the Traefik LoadBalancer URL:"
echo "  kubectl get svc traefik -n traefik-system -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'"
