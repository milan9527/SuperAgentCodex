#!/usr/bin/env bash
set -euo pipefail

echo "=== App Host POC — Teardown ==="
echo ""

# Local kind cluster
if kind get clusters 2>/dev/null | grep -q "app-host-poc"; then
  echo "Deleting kind cluster..."
  kind delete cluster --name app-host-poc
  echo "Done."
elif command -v kubectl &>/dev/null && kubectl config current-context 2>/dev/null | grep -q "eks"; then
  echo "Detected EKS context. To destroy EKS resources:"
  echo "  cd $(dirname "$0")/../cdk && npx cdk destroy --all"
else
  echo "No kind or EKS cluster found."
fi
