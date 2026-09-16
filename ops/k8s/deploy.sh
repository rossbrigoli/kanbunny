#!/bin/bash
# Deploy Kanbunny to K3s via the GitOps flow (since 2026-07):
#   1. build + push docker.io/brigss007/kanbunny:<tag>
#   2. bump the image tag in the k3s-cluster repo (ArgoCD app "kanbunny" auto-syncs)
#
# NOTE (2026-09-08): the cluster imagePullSecret `dockerhub-brigss007-pull`
# currently gets 401 from Docker Hub for the private brigss007/kanbunny repo.
# Until it is refreshed, also pre-seed the image on optiplex2 (step 3), which
# the kubelet picks up because imagePullPolicy=IfNotPresent.
set -euo pipefail

TAG="${1:-$(date +%Y-%m-%d)}"
IMAGE="docker.io/brigss007/kanbunny:${TAG}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GITOPS_MANIFEST="$HOME/projects/k3s-cluster/manifests/kanbunny/01-kanbunny.yaml"
NODE="192.168.68.141"
export KUBECONFIG=$HOME/projects/k3s-cluster/kubeconfig

echo "Building $IMAGE ..."
podman build -t "$IMAGE" "$PROJECT_DIR"

echo "Pushing $IMAGE ..."
podman push "$IMAGE"

echo "Bumping image tag in GitOps manifest ..."
sed -i -E "s|image: docker.io/brigss007/kanbunny:[^[:space:]]+|image: ${IMAGE}|" "$GITOPS_MANIFEST"
(
  cd "$HOME/projects/k3s-cluster"
  git add manifests/kanbunny
  git commit -m "Bump kanbunny image to ${TAG}"
  git push
)

echo "Pre-seeding image on optiplex2 (workaround for expired pull secret) ..."
ARCHIVE="/tmp/kanbunny-${TAG}.tar"
podman save "$IMAGE" -o "$ARCHIVE"
scp -q "$ARCHIVE" "ross@$NODE:$ARCHIVE"
ssh "ross@$NODE" "sudo ctr -n k8s.io images import '$ARCHIVE'; rm -f '$ARCHIVE'"

echo "Waiting for ArgoCD rollout ..."
kubectl rollout status deployment/kanbunny -n kanbunny --timeout=300s
echo "Done. Kanbunny ${TAG} is running (ArgoCD app 'kanbunny', IngressRoute kanbunny.lab)."
