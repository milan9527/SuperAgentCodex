#!/usr/bin/env bash
set -Eeuo pipefail

export AWS_PAGER=""

STACK_NAME="SuperAgentCodex"
REGION="us-east-1"
DOMAIN_NAME=""
HOSTED_ZONE_ID=""
SKIP_CDK=false
SKIP_AGENTCORE=false
SKIP_FRONTEND=false
SKIP_BACKEND=false
AGENTCORE_RUNTIME_NAME=""
AGENTCORE_IMAGE_TAG=""
AGENTCORE_RUNTIME_ARN_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: deploy-full-ecs.sh [options]

Options:
  --stack NAME                    CloudFormation stack name
  --region REGION                AWS region (default: us-east-1)
  --domain DOMAIN                Optional CloudFront custom domain
  --hosted-zone-id ID            Route53 hosted zone for --domain
  --agentcore-runtime-name NAME   New Runtime name; must not already exist
  --agentcore-image-tag TAG       Immutable AgentCore image tag
  --agentcore-runtime-arn ARN     Reuse this existing READY Runtime without updating it
  --skip-cdk                      Reuse an existing stack
  --skip-agentcore                Reuse the Runtime configured on the latest ECS task
  --skip-frontend                 Skip frontend build and S3 deployment
  --skip-backend                  Skip backend image, migration, seed, and ECS deployment
  -h, --help                      Show this help

The script never updates or deletes an existing AgentCore Runtime. A normal
full deployment creates a new Runtime and points only this stack's ECS service
at it.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --domain) DOMAIN_NAME="$2"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="$2"; shift 2 ;;
    --agentcore-runtime-name) AGENTCORE_RUNTIME_NAME="$2"; shift 2 ;;
    --agentcore-image-tag) AGENTCORE_IMAGE_TAG="$2"; shift 2 ;;
    --agentcore-runtime-arn) AGENTCORE_RUNTIME_ARN_OVERRIDE="$2"; shift 2 ;;
    --skip-cdk) SKIP_CDK=true; shift ;;
    --skip-agentcore) SKIP_AGENTCORE=true; shift ;;
    --skip-frontend) SKIP_FRONTEND=true; shift ;;
    --skip-backend) SKIP_BACKEND=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if { [[ -n "$DOMAIN_NAME" && -z "$HOSTED_ZONE_ID" ]]; } \
  || { [[ -z "$DOMAIN_NAME" && -n "$HOSTED_ZONE_ID" ]]; }; then
  echo "ERROR: --domain and --hosted-zone-id must be supplied together." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INDUSTRY_PACKS_SOURCE="$PROJECT_ROOT/industry-packs"
INDUSTRY_PACKS_BUILD_DIR="$PROJECT_ROOT/backend/industry-packs-build"
RUN_ID="$(date -u +%Y%m%d%H%M%S)"
GIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
HOST_ARCH="$(uname -m)"
TARGET_PLATFORM="linux/arm64"
TEMP_FILES=()

cleanup() {
  if [[ -d "$INDUSTRY_PACKS_BUILD_DIR" ]]; then
    find "$INDUSTRY_PACKS_BUILD_DIR" \
      -mindepth 1 \
      -maxdepth 1 \
      ! -name '.gitkeep' \
      -exec rm -rf -- {} +
  fi
  if [[ ${#TEMP_FILES[@]} -gt 0 ]]; then
    rm -f "${TEMP_FILES[@]}"
  fi
}
trap cleanup EXIT

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

for command_name in aws docker node npm npx jq python3 openssl curl git sort rsync; do
  require_command "$command_name"
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STACK_SLUG="$(printf '%s' "$STACK_NAME" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
[[ -n "$STACK_SLUG" ]] || fail "Stack name does not contain a usable repository prefix."

BACKEND_ECR_REPO="super-agent-backend-${STACK_SLUG}"
BACKEND_ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${BACKEND_ECR_REPO}"
BACKEND_IMAGE_TAG="backend-${RUN_ID}-${GIT_SHA}"

sanitize_runtime_name() {
  printf '%s' "$1" | tr -cd '[:alnum:]_'
}

if [[ -z "$AGENTCORE_RUNTIME_NAME" ]]; then
  AGENTCORE_RUNTIME_NAME="$(sanitize_runtime_name "${STACK_NAME}Codex${RUN_ID}")"
  AGENTCORE_RUNTIME_NAME="${AGENTCORE_RUNTIME_NAME:0:48}"
fi
if [[ -z "$AGENTCORE_IMAGE_TAG" ]]; then
  AGENTCORE_IMAGE_TAG="codex-${RUN_ID}-${GIT_SHA}"
fi

ensure_arm64_build() {
  case "$HOST_ARCH" in
    aarch64|arm64)
      echo "  Native ARM64 build host detected."
      ;;
    *)
      echo "  Configuring buildx/QEMU for $TARGET_PLATFORM on $HOST_ARCH..."
      if ! docker buildx inspect superagent-arm64 >/dev/null 2>&1; then
        docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
        docker buildx create \
          --name superagent-arm64 \
          --driver docker-container \
          --bootstrap >/dev/null
      fi
      docker buildx use superagent-arm64
      ;;
  esac

  docker buildx inspect --bootstrap \
    | grep -q 'linux/arm64' \
    || fail "Docker buildx cannot build linux/arm64 images."
}

require_output() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" || "$value" == "None" || "$value" == "null" ]]; then
    fail "CloudFormation output is missing: $name"
  fi
}

echo "============================================================"
echo "Super Agent Codex full ECS deployment"
echo "Account:           $ACCOUNT_ID"
echo "Region:            $REGION"
echo "Stack:             $STACK_NAME"
echo "Backend image:     $BACKEND_ECR_URI:$BACKEND_IMAGE_TAG"
echo "AgentCore Runtime: $AGENTCORE_RUNTIME_NAME"
echo "Target platform:   $TARGET_PLATFORM"
echo "============================================================"

ensure_arm64_build

# ---------------------------------------------------------------------------
# Phase 1: CDK infrastructure
# ---------------------------------------------------------------------------
if [[ "$SKIP_CDK" == false ]]; then
  echo
  echo "=== Phase 1: CDK infrastructure ==="
  cd "$PROJECT_ROOT/infra"
  npm ci
  npm run build

  DB_ENGINE_VERSION="$(
    (aws rds describe-db-engine-versions \
      --engine postgres \
      --region "$REGION" \
      --query "DBEngineVersions[?starts_with(EngineVersion,'16.')].EngineVersion" \
      --output text || true) \
      | tr '\t' '\n' \
      | sed '/^$/d' \
      | sort -V \
      | tail -1
  )"
  REDIS_ENGINE_VERSION="$(
    (aws elasticache describe-cache-engine-versions \
      --engine redis \
      --region "$REGION" \
      --query "CacheEngineVersions[?starts_with(EngineVersion,'7.')].EngineVersion" \
      --output text || true) \
      | tr '\t' '\n' \
      | sed '/^$/d' \
      | sort -V \
      | tail -1
  )"

  CDK_ARGS=(
    -c "stackName=$STACK_NAME"
    -c "enableCdn=true"
    -c "deployTarget=ecs"
  )
  [[ -n "$DB_ENGINE_VERSION" ]] \
    && CDK_ARGS+=(-c "dbEngineVersion=$DB_ENGINE_VERSION")
  [[ -n "$REDIS_ENGINE_VERSION" ]] \
    && CDK_ARGS+=(-c "redisEngineVersion=$REDIS_ENGINE_VERSION")
  if [[ -n "$DOMAIN_NAME" ]]; then
    CDK_ARGS+=(-c "domainName=$DOMAIN_NAME" -c "hostedZoneId=$HOSTED_ZONE_ID")
  fi

  export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID"
  export CDK_DEFAULT_REGION="$REGION"
  echo "  PostgreSQL: ${DB_ENGINE_VERSION:-CDK default}"
  echo "  Redis:      ${REDIS_ENGINE_VERSION:-CDK default}"
  npx cdk synth "${CDK_ARGS[@]}" --quiet >/dev/null
  npx cdk deploy "${CDK_ARGS[@]}" \
    --region "$REGION" \
    --require-approval never
else
  echo
  echo "=== Phase 1: CDK infrastructure (skipped) ==="
fi

echo
echo "=== Reading stack outputs ==="
OUTPUTS="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json)"

get_output() {
  local key="$1"
  jq -r --arg key "$key" \
    '.[] | select(.OutputKey == $key) | .OutputValue' \
    <<<"$OUTPUTS" \
    | head -1
}

DB_ENDPOINT="$(get_output DBEndpoint)"
DB_SECRET_ARN="$(get_output DBSecretArn)"
AVATAR_BUCKET="$(get_output AvatarBucketName)"
SKILLS_BUCKET="$(get_output SkillsBucketName)"
WORKSPACE_BUCKET="$(get_output WorkspaceBucketName)"
REDIS_ENDPOINT="$(get_output RedisEndpoint)"
REDIS_PORT="$(get_output RedisPort)"
AUTH_MODE="$(get_output AuthMode)"
FRONTEND_BUCKET="$(get_output FrontendBucketName)"
CF_DIST_ID="$(get_output CloudFrontDistributionId)"
CF_DOMAIN="$(get_output CloudFrontDomainName)"
ECS_CLUSTER_NAME="$(get_output EcsClusterName)"
ECS_SERVICE_NAME="$(get_output EcsServiceName)"
ECS_TASK_FAMILY="$(get_output EcsTaskFamily)"
ECS_TASK_EXEC_ROLE_ARN="$(get_output EcsTaskExecRoleArn)"
ECS_TASK_ROLE_ARN="$(get_output EcsTaskRoleArn)"
ECS_SUBNETS="$(get_output EcsSubnets)"
ECS_SG="$(get_output EcsSecurityGroup)"
ALB_DNS="$(get_output AlbDnsName)"
COGNITO_USER_POOL_ID="$(get_output CognitoUserPoolId)"
COGNITO_CLIENT_ID="$(get_output CognitoClientId)"
COGNITO_DOMAIN="$(get_output CognitoDomainUrl)"

for pair in \
  "DBEndpoint:$DB_ENDPOINT" \
  "DBSecretArn:$DB_SECRET_ARN" \
  "AvatarBucketName:$AVATAR_BUCKET" \
  "SkillsBucketName:$SKILLS_BUCKET" \
  "WorkspaceBucketName:$WORKSPACE_BUCKET" \
  "RedisEndpoint:$REDIS_ENDPOINT" \
  "RedisPort:$REDIS_PORT" \
  "EcsClusterName:$ECS_CLUSTER_NAME" \
  "EcsServiceName:$ECS_SERVICE_NAME" \
  "EcsTaskFamily:$ECS_TASK_FAMILY" \
  "EcsTaskExecRoleArn:$ECS_TASK_EXEC_ROLE_ARN" \
  "EcsTaskRoleArn:$ECS_TASK_ROLE_ARN" \
  "EcsSubnets:$ECS_SUBNETS" \
  "EcsSecurityGroup:$ECS_SG" \
  "AlbDnsName:$ALB_DNS"; do
  require_output "${pair%%:*}" "${pair#*:}"
done

if [[ -n "$DOMAIN_NAME" ]]; then
  PUBLIC_URL="https://$DOMAIN_NAME"
else
  require_output CloudFrontDomainName "$CF_DOMAIN"
  PUBLIC_URL="https://$CF_DOMAIN"
fi
require_output FrontendBucketName "$FRONTEND_BUCKET"
require_output CloudFrontDistributionId "$CF_DIST_ID"

WORKSPACE_REGION="$(aws s3api get-bucket-location \
  --bucket "$WORKSPACE_BUCKET" \
  --query LocationConstraint \
  --output text)"
if [[ -z "$WORKSPACE_REGION" || "$WORKSPACE_REGION" == "None" ]]; then
  WORKSPACE_REGION="us-east-1"
fi

echo "  Database:   $DB_ENDPOINT"
echo "  Redis:      $REDIS_ENDPOINT:$REDIS_PORT"
echo "  Workspace:  s3://$WORKSPACE_BUCKET ($WORKSPACE_REGION)"
echo "  ECS:        $ECS_CLUSTER_NAME / $ECS_SERVICE_NAME"
echo "  Public URL: $PUBLIC_URL"

# ---------------------------------------------------------------------------
# Phase 2: create-only Codex AgentCore Runtime
# ---------------------------------------------------------------------------
AGENT_RUNTIME="codex"
AGENTCORE_RUNTIME_ARN=""
AGENTCORE_EXECUTION_ROLE_ARN=""

if [[ -n "$AGENTCORE_RUNTIME_ARN_OVERRIDE" ]]; then
  echo
  echo "=== Phase 2: reuse explicit Codex AgentCore Runtime ==="
  RUNTIME_ARN_PREFIX="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/"
  [[ "$AGENTCORE_RUNTIME_ARN_OVERRIDE" == "$RUNTIME_ARN_PREFIX"* ]] \
    || fail "Explicit Runtime ARN must belong to account ${ACCOUNT_ID} in ${REGION}."
  AGENTCORE_RUNTIME_ID="${AGENTCORE_RUNTIME_ARN_OVERRIDE##*/}"
  RUNTIME_DETAILS="$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "$AGENTCORE_RUNTIME_ID" \
    --region "$REGION" \
    --output json)"
  [[ "$(jq -r '.status' <<<"$RUNTIME_DETAILS")" == "READY" ]] \
    || fail "Explicit AgentCore Runtime is not READY."
  AGENTCORE_RUNTIME_ARN="$(jq -r '.agentRuntimeArn' <<<"$RUNTIME_DETAILS")"
  AGENTCORE_EXECUTION_ROLE_ARN="$(jq -r '.roleArn' <<<"$RUNTIME_DETAILS")"
  require_output AGENTCORE_RUNTIME_ARN "$AGENTCORE_RUNTIME_ARN"
  require_output AGENTCORE_EXECUTION_ROLE_ARN "$AGENTCORE_EXECUTION_ROLE_ARN"
  AGENT_RUNTIME="agentcore"
  echo "  Reusing READY Runtime without modifying it: $AGENTCORE_RUNTIME_ARN"
elif [[ "$SKIP_AGENTCORE" == false ]]; then
  echo
  echo "=== Phase 2: create-only Codex AgentCore Runtime ==="
  AGENTCORE_OUTPUT_FILE="$(mktemp /tmp/super-agent-agentcore.XXXXXX)"
  TEMP_FILES+=("$AGENTCORE_OUTPUT_FILE")

  "$SCRIPT_DIR/deploy-codex-agentcore-new.sh" \
    --stack "$STACK_NAME" \
    --region "$REGION" \
    --workspace-bucket "$WORKSPACE_BUCKET" \
    --workspace-region "$WORKSPACE_REGION" \
    --runtime-name "$AGENTCORE_RUNTIME_NAME" \
    --image-tag "$AGENTCORE_IMAGE_TAG" \
    | tee "$AGENTCORE_OUTPUT_FILE"

  AGENTCORE_RUNTIME_ARN="$(grep '^AGENTCORE_RUNTIME_ARN=' "$AGENTCORE_OUTPUT_FILE" \
    | tail -1 | cut -d= -f2-)"
  AGENTCORE_EXECUTION_ROLE_ARN="$(
    grep '^AGENTCORE_EXECUTION_ROLE_ARN=' "$AGENTCORE_OUTPUT_FILE" \
      | tail -1 | cut -d= -f2-
  )"
  require_output AGENTCORE_RUNTIME_ARN "$AGENTCORE_RUNTIME_ARN"
  require_output AGENTCORE_EXECUTION_ROLE_ARN "$AGENTCORE_EXECUTION_ROLE_ARN"
  AGENT_RUNTIME="agentcore"
else
  echo
  echo "=== Phase 2: AgentCore Runtime (skipped) ==="
  EXISTING_ENV="$(aws ecs describe-task-definition \
    --task-definition "$ECS_TASK_FAMILY" \
    --region "$REGION" \
    --query 'taskDefinition.containerDefinitions[0].environment' \
    --output json 2>/dev/null || echo '[]')"
  AGENTCORE_RUNTIME_ARN="$(jq -r \
    '.[] | select(.name == "AGENTCORE_RUNTIME_ARN") | .value' \
    <<<"$EXISTING_ENV" | head -1)"
  AGENTCORE_EXECUTION_ROLE_ARN="$(jq -r \
    '.[] | select(.name == "AGENTCORE_EXECUTION_ROLE_ARN") | .value' \
    <<<"$EXISTING_ENV" | head -1)"
  if [[ -n "$AGENTCORE_RUNTIME_ARN" ]]; then
    AGENT_RUNTIME="agentcore"
    echo "  Reusing Runtime configured on the latest ECS task: $AGENTCORE_RUNTIME_ARN"
  else
    echo "  No existing Runtime found; backend will use its local Codex app-server."
  fi
fi

# ---------------------------------------------------------------------------
# Phase 3: backend image, migrations, seed, and ECS service
# ---------------------------------------------------------------------------
if [[ "$SKIP_BACKEND" == false ]]; then
  AGENTCORE_BROWSER_IDENTIFIER=""
  AGENTCORE_CODE_INTERPRETER_IDENTIFIER=""
  if [[ "$AGENT_RUNTIME" == "agentcore" ]]; then
    echo
    echo "=== Phase 2b: dedicated AgentCore Browser and Code Interpreter ==="
    AGENTCORE_TOOLS_OUTPUT_FILE="$(mktemp /tmp/super-agent-agentcore-tools.XXXXXX)"
    TEMP_FILES+=("$AGENTCORE_TOOLS_OUTPUT_FILE")
    "$SCRIPT_DIR/ensure-agentcore-tools.sh" \
      --stack "$STACK_NAME" \
      --region "$REGION" \
      --execution-role-arn "$AGENTCORE_EXECUTION_ROLE_ARN" \
      | tee "$AGENTCORE_TOOLS_OUTPUT_FILE"
    AGENTCORE_BROWSER_IDENTIFIER="$(
      grep '^AGENTCORE_BROWSER_IDENTIFIER=' "$AGENTCORE_TOOLS_OUTPUT_FILE" \
        | tail -1 | cut -d= -f2-
    )"
    AGENTCORE_CODE_INTERPRETER_IDENTIFIER="$(
      grep '^AGENTCORE_CODE_INTERPRETER_IDENTIFIER=' "$AGENTCORE_TOOLS_OUTPUT_FILE" \
        | tail -1 | cut -d= -f2-
    )"
    require_output AGENTCORE_BROWSER_IDENTIFIER "$AGENTCORE_BROWSER_IDENTIFIER"
    require_output \
      AGENTCORE_CODE_INTERPRETER_IDENTIFIER \
      "$AGENTCORE_CODE_INTERPRETER_IDENTIFIER"
  fi

  echo
  echo "=== Phase 3: backend ECS deployment ==="

  if ! aws ecr describe-repositories \
    --repository-names "$BACKEND_ECR_REPO" \
    --region "$REGION" >/dev/null 2>&1; then
    aws ecr create-repository \
      --repository-name "$BACKEND_ECR_REPO" \
      --image-tag-mutability IMMUTABLE \
      --image-scanning-configuration scanOnPush=true \
      --region "$REGION" >/dev/null
  else
    aws ecr put-image-tag-mutability \
      --repository-name "$BACKEND_ECR_REPO" \
      --image-tag-mutability IMMUTABLE \
      --region "$REGION" >/dev/null
  fi

  EXISTING_BACKEND_IMAGE="$(aws ecr describe-images \
    --repository-name "$BACKEND_ECR_REPO" \
    --image-ids "imageTag=$BACKEND_IMAGE_TAG" \
    --region "$REGION" \
    --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || true)"
  [[ -z "$EXISTING_BACKEND_IMAGE" || "$EXISTING_BACKEND_IMAGE" == "None" ]] \
    || fail "Backend image tag already exists: $BACKEND_IMAGE_TAG"

  aws ecr get-login-password --region "$REGION" \
    | docker login \
      --username AWS \
      --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

  [[ -d "$INDUSTRY_PACKS_SOURCE" ]] \
    || fail "Industry packs source directory not found: $INDUSTRY_PACKS_SOURCE"
  mkdir -p "$INDUSTRY_PACKS_BUILD_DIR"
  rsync -a --delete \
    --exclude '.gitkeep' \
    "$INDUSTRY_PACKS_SOURCE/" \
    "$INDUSTRY_PACKS_BUILD_DIR/"
  INDUSTRY_PACK_COUNT="$(find "$INDUSTRY_PACKS_BUILD_DIR" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name 'industry-pack-*' \
    | wc -l \
    | tr -d '[:space:]')"
  [[ "$INDUSTRY_PACK_COUNT" -gt 0 ]] \
    || fail "No industry packs were staged for the backend image."
  echo "  Staged $INDUSTRY_PACK_COUNT industry packs for the backend image."

  docker buildx build \
    --platform "$TARGET_PLATFORM" \
    --tag "$BACKEND_ECR_URI:$BACKEND_IMAGE_TAG" \
    --push \
    "$PROJECT_ROOT/backend"

  SECRET_JSON="$(aws secretsmanager get-secret-value \
    --secret-id "$DB_SECRET_ARN" \
    --region "$REGION" \
    --query SecretString \
    --output text)"
  DB_USER="$(jq -r '.username' <<<"$SECRET_JSON")"
  DB_PASS="$(jq -r '.password' <<<"$SECRET_JSON")"
  DB_HOST="$(jq -r '.host // empty' <<<"$SECRET_JSON")"
  DB_PORT="$(jq -r '.port // 5432' <<<"$SECRET_JSON")"
  DB_NAME="$(jq -r '.dbname // "super_agent"' <<<"$SECRET_JSON")"
  [[ -n "$DB_HOST" ]] || DB_HOST="$DB_ENDPOINT"
  ENCODED_DB_PASS="$(DB_PASS="$DB_PASS" python3 -c \
    'import os, urllib.parse; print(urllib.parse.quote(os.environ["DB_PASS"], safe=""))')"
  DATABASE_URL="postgresql://${DB_USER}:${ENCODED_DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=no-verify"

  JWT_SECRET_NAME="${STACK_NAME}/jwt-secret"
  JWT_SECRET="$(aws secretsmanager get-secret-value \
    --secret-id "$JWT_SECRET_NAME" \
    --region "$REGION" \
    --query SecretString \
    --output text 2>/dev/null || true)"
  if [[ -z "$JWT_SECRET" || "$JWT_SECRET" == "None" ]]; then
    JWT_SECRET="$(openssl rand -hex 32)"
    aws secretsmanager create-secret \
      --name "$JWT_SECRET_NAME" \
      --description "Stable JWT signing secret for $STACK_NAME" \
      --secret-string "$JWT_SECRET" \
      --region "$REGION" >/dev/null
  fi

  export DATABASE_URL REGION STACK_NAME ECS_TASK_FAMILY
  export ECS_TASK_EXEC_ROLE_ARN ECS_TASK_ROLE_ARN BACKEND_ECR_URI BACKEND_IMAGE_TAG
  MIGRATION_TASK_FILE="$(mktemp /tmp/super-agent-migration-task.XXXXXX.json)"
  TEMP_FILES+=("$MIGRATION_TASK_FILE")
  python3 >"$MIGRATION_TASK_FILE" <<'PY'
import json
import os

task = {
    "family": f"{os.environ['ECS_TASK_FAMILY']}-migrate",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "512",
    "memory": "1024",
    "runtimePlatform": {
        "cpuArchitecture": "ARM64",
        "operatingSystemFamily": "LINUX",
    },
    "executionRoleArn": os.environ["ECS_TASK_EXEC_ROLE_ARN"],
    "taskRoleArn": os.environ["ECS_TASK_ROLE_ARN"],
    "containerDefinitions": [{
        "name": "migrate",
        "image": f"{os.environ['BACKEND_ECR_URI']}:{os.environ['BACKEND_IMAGE_TAG']}",
        "essential": True,
        "entryPoint": ["sh", "-c"],
        "command": ["npx prisma migrate deploy"],
        "environment": [
            {"name": "DATABASE_URL", "value": os.environ["DATABASE_URL"]},
            {"name": "NODE_ENV", "value": "production"},
        ],
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
                "awslogs-group": f"/super-agent/{os.environ['STACK_NAME'].lower()}/ecs-backend",
                "awslogs-region": os.environ["REGION"],
                "awslogs-stream-prefix": "migration",
            },
        },
    }],
}
print(json.dumps(task))
PY

  MIGRATION_TASK_DEF="$(aws ecs register-task-definition \
    --cli-input-json "file://$MIGRATION_TASK_FILE" \
    --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"

  run_one_off_task() {
    local label="$1"
    local task_definition="$2"
    local overrides_file="${3:-}"
    local args=(
      ecs run-task
      --cluster "$ECS_CLUSTER_NAME"
      --task-definition "$task_definition"
      --launch-type FARGATE
      --network-configuration
      "awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}"
      --region "$REGION"
      --output json
    )
    if [[ -n "$overrides_file" ]]; then
      args+=(--overrides "file://$overrides_file")
    fi

    local run_output
    run_output="$(aws "${args[@]}")"
    local failure_count
    failure_count="$(jq '.failures | length' <<<"$run_output")"
    [[ "$failure_count" == "0" ]] \
      || fail "$label task could not start: $(jq -c '.failures' <<<"$run_output")"
    local task_arn
    task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_output")"
    [[ -n "$task_arn" ]] || fail "$label task returned no task ARN."

    echo "  Waiting for $label task: $task_arn"
    aws ecs wait tasks-stopped \
      --cluster "$ECS_CLUSTER_NAME" \
      --tasks "$task_arn" \
      --region "$REGION"

    local task_state
    task_state="$(aws ecs describe-tasks \
      --cluster "$ECS_CLUSTER_NAME" \
      --tasks "$task_arn" \
      --region "$REGION" \
      --output json)"
    local exit_code
    exit_code="$(jq -r '.tasks[0].containers[0].exitCode // -1' <<<"$task_state")"
    if [[ "$exit_code" != "0" ]]; then
      echo "$task_state" | jq -c \
        '.tasks[0] | {stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}'
      fail "$label task failed with exit code $exit_code."
    fi
    echo "  $label task completed successfully."
  }

  run_one_off_task "database migration" "$MIGRATION_TASK_DEF"

  SEED_OVERRIDES_FILE="$(mktemp /tmp/super-agent-seed-overrides.XXXXXX.json)"
  TEMP_FILES+=("$SEED_OVERRIDES_FILE")
  jq -n '{
    containerOverrides: [{
      name: "migrate",
      command: ["npx tsx prisma/seed.ts && npx tsx prisma/seed-local-auth.ts && npx tsx prisma/seed-showcase-from-packs.ts"]
    }]
  }' >"$SEED_OVERRIDES_FILE"
  run_one_off_task "database seed" "$MIGRATION_TASK_DEF" "$SEED_OVERRIDES_FILE"

  export REDIS_HOST="$REDIS_ENDPOINT" REDIS_PORT="$REDIS_PORT"
  export AUTH_MODE="${AUTH_MODE:-local}" AWS_REGION="$REGION"
  export AVATAR_BUCKET SKILLS_BUCKET WORKSPACE_BUCKET WORKSPACE_REGION
  export PUBLIC_URL JWT_SECRET AGENT_RUNTIME
  export AGENTCORE_RUNTIME_ARN AGENTCORE_EXECUTION_ROLE_ARN
  export AGENTCORE_BROWSER_IDENTIFIER AGENTCORE_CODE_INTERPRETER_IDENTIFIER
  MAIN_TASK_FILE="$(mktemp /tmp/super-agent-main-task.XXXXXX.json)"
  TEMP_FILES+=("$MAIN_TASK_FILE")
  python3 >"$MAIN_TASK_FILE" <<'PY'
import json
import os

env = {
    "PORT": "3000",
    "HOST": "0.0.0.0",
    "NODE_ENV": "production",
    "LOG_LEVEL": "info",
    "PROCESS_ROLE": "all",
    "DATABASE_URL": os.environ["DATABASE_URL"],
    "REDIS_HOST": os.environ["REDIS_HOST"],
    "REDIS_PORT": os.environ["REDIS_PORT"],
    "REDIS_PASSWORD": "",
    "AUTH_MODE": os.environ["AUTH_MODE"],
    "AWS_REGION": os.environ["AWS_REGION"],
    "AWS_DEFAULT_REGION": os.environ["AWS_REGION"],
    "S3_BUCKET_NAME": os.environ["AVATAR_BUCKET"],
    "S3_PRESIGNED_URL_EXPIRES": "3600",
    "SKILLS_S3_BUCKET": os.environ["SKILLS_BUCKET"],
    "AGENTCORE_WORKSPACE_S3_BUCKET": os.environ["WORKSPACE_BUCKET"],
    "WORKSPACE_S3_REGION": os.environ["WORKSPACE_REGION"],
    "AGENT_WORKSPACE_BASE_DIR": "/app/workspaces",
    "CORS_ORIGIN": os.environ["PUBLIC_URL"],
    "APP_URL": os.environ["PUBLIC_URL"],
    "AGENTCORE_BACKEND_API_URL": os.environ["PUBLIC_URL"],
    "RAG_ENABLED": "true",
    "JWT_SECRET": os.environ["JWT_SECRET"],
    "AGENT_RUNTIME": os.environ["AGENT_RUNTIME"],
    "CODEX_REASONING_EFFORT": "high",
}
runtime_arn = os.environ.get("AGENTCORE_RUNTIME_ARN", "")
role_arn = os.environ.get("AGENTCORE_EXECUTION_ROLE_ARN", "")
if runtime_arn:
    env["AGENTCORE_RUNTIME_ARN"] = runtime_arn
if role_arn:
    env["AGENTCORE_EXECUTION_ROLE_ARN"] = role_arn
if os.environ["AGENT_RUNTIME"] == "agentcore":
    env["AGENTCORE_BROWSER_IDENTIFIER"] = os.environ["AGENTCORE_BROWSER_IDENTIFIER"]
    env["AGENTCORE_CODE_INTERPRETER_IDENTIFIER"] = os.environ["AGENTCORE_CODE_INTERPRETER_IDENTIFIER"]

task = {
    "family": os.environ["ECS_TASK_FAMILY"],
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "1024",
    "memory": "2048",
    "ephemeralStorage": {"sizeInGiB": 30},
    "runtimePlatform": {
        "cpuArchitecture": "ARM64",
        "operatingSystemFamily": "LINUX",
    },
    "executionRoleArn": os.environ["ECS_TASK_EXEC_ROLE_ARN"],
    "taskRoleArn": os.environ["ECS_TASK_ROLE_ARN"],
    "containerDefinitions": [{
        "name": "backend",
        "image": f"{os.environ['BACKEND_ECR_URI']}:{os.environ['BACKEND_IMAGE_TAG']}",
        "essential": True,
        "portMappings": [{"containerPort": 3000, "protocol": "tcp"}],
        "environment": [{"name": key, "value": value} for key, value in env.items()],
        "linuxParameters": {"initProcessEnabled": True},
        "stopTimeout": 60,
        "healthCheck": {
            "command": ["CMD-SHELL", "curl -fsS http://localhost:3000/health/ready || exit 1"],
            "interval": 30,
            "timeout": 10,
            "retries": 3,
            "startPeriod": 60,
        },
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
                "awslogs-group": f"/super-agent/{os.environ['STACK_NAME'].lower()}/ecs-backend",
                "awslogs-region": os.environ["REGION"],
                "awslogs-stream-prefix": "backend",
            },
        },
    }],
}
print(json.dumps(task))
PY

  TASK_DEF_ARN="$(aws ecs register-task-definition \
    --cli-input-json "file://$MAIN_TASK_FILE" \
    --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"
  aws ecs update-service \
    --cluster "$ECS_CLUSTER_NAME" \
    --service "$ECS_SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count 1 \
    --force-new-deployment \
    --region "$REGION" >/dev/null
  echo "  Waiting for ECS service to stabilize..."
  aws ecs wait services-stable \
    --cluster "$ECS_CLUSTER_NAME" \
    --services "$ECS_SERVICE_NAME" \
    --region "$REGION"

  SERVICE_STATE=""
  for ((attempt = 1; attempt <= 24; attempt++)); do
    SERVICE_STATE="$(aws ecs describe-services \
      --cluster "$ECS_CLUSTER_NAME" \
      --services "$ECS_SERVICE_NAME" \
      --region "$REGION" \
      --query 'services[0]' \
      --output json)"
    ROLLOUT_STATE="$(jq -r \
      '.deployments[] | select(.status == "PRIMARY") | .rolloutState // "COMPLETED"' \
      <<<"$SERVICE_STATE")"
    [[ "$ROLLOUT_STATE" != "FAILED" ]] \
      || fail "ECS deployment entered the FAILED rollout state."
    [[ "$ROLLOUT_STATE" == "COMPLETED" ]] && break
    sleep 5
  done
  [[ "$(jq -r '.runningCount' <<<"$SERVICE_STATE")" == "1" ]] \
    || fail "ECS service is not running exactly one task."
  [[ "$ROLLOUT_STATE" == "COMPLETED" ]] \
    || fail "ECS deployment did not reach COMPLETED."

  curl --fail --silent --show-error \
    --retry 18 \
    --retry-all-errors \
    --retry-delay 10 \
    "http://${ALB_DNS}/health/ready" >/dev/null
  echo "  Backend readiness passed through the ALB."
else
  echo
  echo "=== Phase 3: backend ECS deployment (skipped) ==="
fi

# ---------------------------------------------------------------------------
# Phase 4: frontend
# ---------------------------------------------------------------------------
if [[ "$SKIP_FRONTEND" == false ]]; then
  echo
  echo "=== Phase 4: frontend S3/CloudFront deployment ==="
  cd "$PROJECT_ROOT/frontend"
  npm ci
  if [[ "${AUTH_MODE:-local}" == "cognito" ]]; then
    VITE_API_BASE_URL="" \
    VITE_COGNITO_REGION="$REGION" \
    VITE_COGNITO_USER_POOL_ID="$COGNITO_USER_POOL_ID" \
    VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
    VITE_COGNITO_DOMAIN="$COGNITO_DOMAIN" \
    VITE_COGNITO_REDIRECT_URI="$PUBLIC_URL/auth/callback" \
      npx vite build
  else
    VITE_API_BASE_URL="" VITE_AUTH_MODE=local npx vite build
  fi

  aws s3 sync "$PROJECT_ROOT/frontend/dist/" \
    "s3://$FRONTEND_BUCKET/" \
    --delete \
    --region "$REGION"
  INVALIDATION_ID="$(aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths '/*' \
    --query 'Invalidation.Id' \
    --output text)"
  aws cloudfront wait invalidation-completed \
    --distribution-id "$CF_DIST_ID" \
    --id "$INVALIDATION_ID"
else
  echo
  echo "=== Phase 4: frontend deployment (skipped) ==="
fi

curl --fail --silent --show-error \
  --retry 18 \
  --retry-all-errors \
  --retry-delay 10 \
  "$PUBLIC_URL/" >/dev/null

echo
echo "============================================================"
echo "Deployment complete"
echo "App URL:          $PUBLIC_URL"
echo "ALB:              http://$ALB_DNS"
echo "ECS:              $ECS_CLUSTER_NAME / $ECS_SERVICE_NAME"
echo "Database:         $DB_ENDPOINT"
echo "Workspace bucket: s3://$WORKSPACE_BUCKET"
echo "Skills bucket:    s3://$SKILLS_BUCKET"
if [[ -n "$AGENTCORE_RUNTIME_ARN" ]]; then
  echo "AgentCore:        $AGENTCORE_RUNTIME_ARN"
fi
if [[ "${AUTH_MODE:-local}" == "local" ]]; then
  echo "Login:            admin@example.com / admin123"
fi
echo "Logs:             aws logs tail /super-agent/${STACK_NAME,,}/ecs-backend --region $REGION --follow"
echo "============================================================"
