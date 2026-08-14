#!/usr/bin/env bash
set -euo pipefail

# Creates a brand-new Codex AgentCore Runtime. This script never calls
# update-agent-runtime or delete-agent-runtime and never changes backend config.

export AWS_PAGER=""

STACK_NAME="SuperAgent"
REGION="us-east-1"
WORKSPACE_BUCKET=""
WORKSPACE_REGION=""
RUNTIME_NAME=""
IMAGE_TAG=""
RUN_ID="$(date -u +%Y%m%d%H%M%S)"

usage() {
  echo "Usage: $0 [--stack NAME] [--region REGION] [--workspace-bucket BUCKET]"
  echo "          [--workspace-region REGION]"
  echo "          [--runtime-name NAME] [--image-tag TAG]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --workspace-bucket) WORKSPACE_BUCKET="$2"; shift 2 ;;
    --workspace-region) WORKSPACE_REGION="$2"; shift 2 ;;
    --runtime-name) RUNTIME_NAME="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REPOSITORY="super-agent-agentcore-codex"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPOSITORY}"

sanitize_name() {
  printf '%s' "$1" | tr -cd '[:alnum:]_'
}

if [[ -z "$RUNTIME_NAME" ]]; then
  RUNTIME_NAME="$(sanitize_name "${STACK_NAME}Codex${RUN_ID}")"
  RUNTIME_NAME="${RUNTIME_NAME:0:48}"
fi
if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="codex-${RUN_ID}-$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
fi

if [[ -z "$WORKSPACE_BUCKET" ]]; then
  WORKSPACE_BUCKET="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='WorkspaceBucketName'].OutputValue" \
    --output text 2>/dev/null || true)"
fi
if [[ -z "$WORKSPACE_BUCKET" || "$WORKSPACE_BUCKET" == "None" ]]; then
  WORKSPACE_BUCKET="super-agent-workspace-${ACCOUNT_ID}"
fi
if [[ -z "$WORKSPACE_REGION" ]]; then
  WORKSPACE_REGION="$(aws s3api get-bucket-location \
    --bucket "$WORKSPACE_BUCKET" \
    --query LocationConstraint \
    --output text 2>/dev/null || true)"
fi
if [[ -z "$WORKSPACE_REGION" || "$WORKSPACE_REGION" == "None" ]]; then
  WORKSPACE_REGION="us-east-1"
fi

echo "Runtime name: $RUNTIME_NAME"
echo "Image:        $ECR_URI:$IMAGE_TAG"
echo "Workspace:    s3://$WORKSPACE_BUCKET ($WORKSPACE_REGION)"

EXISTING_RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes \
  --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId" \
  --output text)"
if [[ -n "$EXISTING_RUNTIME_ID" && "$EXISTING_RUNTIME_ID" != "None" ]]; then
  echo "ERROR: Runtime '$RUNTIME_NAME' already exists. Refusing to update it."
  exit 1
fi

aws ecr describe-repositories \
  --repository-names "$ECR_REPOSITORY" \
  --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository \
    --repository-name "$ECR_REPOSITORY" \
    --image-tag-mutability IMMUTABLE \
    --region "$REGION" >/dev/null

EXISTING_IMAGE="$(aws ecr describe-images \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids "imageTag=$IMAGE_TAG" \
  --region "$REGION" \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)"
if [[ -n "$EXISTING_IMAGE" && "$EXISTING_IMAGE" != "None" ]]; then
  echo "ERROR: Image tag '$IMAGE_TAG' already exists. Refusing to overwrite it."
  exit 1
fi

ROLE_SUFFIX="$(sanitize_name "${STACK_NAME}${RUN_ID}")"
ROLE_NAME="super-agent-codex-${ROLE_SUFFIX:0:43}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "ERROR: Dedicated role '$ROLE_NAME' already exists. Refusing to mutate it."
  exit 1
fi

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"bedrock-agentcore.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }' \
  --description "Dedicated execution role for a new Codex AgentCore validation runtime" \
  >/dev/null

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "codex-agentcore-validation" \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {
        \"Sid\":\"BedrockInvoke\",
        \"Effect\":\"Allow\",
        \"Action\":[
          \"bedrock:InvokeModel\",
          \"bedrock:InvokeModelWithResponseStream\",
          \"bedrock-mantle:CreateInference\"
        ],
        \"Resource\":\"*\"
      },
      {
        \"Sid\":\"WorkspaceS3\",
        \"Effect\":\"Allow\",
        \"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\",\"s3:ListBucket\"],
        \"Resource\":[
          \"arn:aws:s3:::${WORKSPACE_BUCKET}\",
          \"arn:aws:s3:::${WORKSPACE_BUCKET}/*\"
        ]
      },
      {
        \"Sid\":\"ECRPull\",
        \"Effect\":\"Allow\",
        \"Action\":[\"ecr:GetAuthorizationToken\",\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],
        \"Resource\":\"*\"
      },
      {
        \"Sid\":\"AgentCoreTools\",
        \"Effect\":\"Allow\",
        \"Action\":[
          \"bedrock-agentcore:StartBrowserSession\",
          \"bedrock-agentcore:StopBrowserSession\",
          \"bedrock-agentcore:GetBrowserSession\",
          \"bedrock-agentcore:ConnectBrowserAutomationStream\",
          \"bedrock-agentcore:ConnectBrowserLiveViewStream\",
          \"bedrock-agentcore:StartCodeInterpreterSession\",
          \"bedrock-agentcore:InvokeCodeInterpreter\",
          \"bedrock-agentcore:StopCodeInterpreterSession\",
          \"bedrock-agentcore:GetCodeInterpreterSession\"
        ],
        \"Resource\":\"*\"
      },
      {
        \"Sid\":\"Observability\",
        \"Effect\":\"Allow\",
        \"Action\":[
          \"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",
          \"xray:PutTraceSegments\",\"xray:PutTelemetryRecords\",
          \"cloudwatch:PutMetricData\"
        ],
        \"Resource\":\"*\"
      }
    ]
  }"

aws ecr get-login-password --region "$REGION" \
  | docker login \
    --username AWS \
    --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

if ! docker buildx inspect superagent-codex-arm64 >/dev/null 2>&1; then
  docker buildx create \
    --name superagent-codex-arm64 \
    --driver docker-container \
    --use >/dev/null
else
  docker buildx use superagent-codex-arm64
fi
docker buildx inspect --bootstrap >/dev/null
docker buildx build \
  --platform linux/arm64 \
  --tag "$ECR_URI:$IMAGE_TAG" \
  --push \
  "$PROJECT_ROOT/agentcore"

SERVICE_NAME="${RUNTIME_NAME}.DEFAULT"
ENV_VARS="{
  \"AWS_REGION\":\"${REGION}\",
  \"AWS_DEFAULT_REGION\":\"${REGION}\",
  \"WORKSPACE_S3_REGION\":\"${WORKSPACE_REGION}\",
  \"CODEX_HOME\":\"/home/node/.codex\",
  \"CODEX_EXECUTABLE\":\"/usr/local/bin/codex\",
  \"CODEX_REASONING_EFFORT\":\"high\",
  \"AGENT_OBSERVABILITY_ENABLED\":\"true\",
  \"OTEL_EXPORTER_OTLP_PROTOCOL\":\"http/protobuf\",
  \"OTEL_SERVICE_NAME\":\"${SERVICE_NAME}\",
  \"OTEL_RESOURCE_ATTRIBUTES\":\"service.name=${SERVICE_NAME}\"
}"

echo "Waiting for the new IAM role to become assumable..."
sleep 10

RUNTIME_OUTPUT=""
CREATE_OK=false
for attempt in 1 2 3 4 5; do
  if RUNTIME_OUTPUT="$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "$RUNTIME_NAME" \
    --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$ECR_URI:$IMAGE_TAG\"}}" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --environment-variables "$ENV_VARS" \
    --description "Isolated Codex migration validation runtime" \
    --region "$REGION" \
    --output json 2>&1)"; then
    CREATE_OK=true
    break
  fi
  echo "Create attempt $attempt/5 failed; waiting for IAM propagation..."
  sleep 10
done
if [[ "$CREATE_OK" != "true" ]]; then
  echo "ERROR: Failed to create the new runtime after five attempts."
  echo "$RUNTIME_OUTPUT"
  exit 1
fi

RUNTIME_ID="$(printf '%s' "$RUNTIME_OUTPUT" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['agentRuntimeId'])")"
RUNTIME_ARN="$(printf '%s' "$RUNTIME_OUTPUT" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('agentRuntimeArn',''))")"
if [[ -z "$RUNTIME_ARN" ]]; then
  RUNTIME_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/${RUNTIME_ID}"
fi

STATUS="UNKNOWN"
for attempt in $(seq 1 30); do
  STATUS="$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "$RUNTIME_ID" \
    --region "$REGION" \
    --query status \
    --output text 2>/dev/null || echo UNKNOWN)"
  [[ "$STATUS" == "READY" ]] && break
  echo "Runtime status: $STATUS ($attempt/30)"
  sleep 10
done

if [[ "$STATUS" != "READY" ]]; then
  echo "ERROR: New runtime did not become READY. Current status: $STATUS"
  echo "The runtime was not updated or deleted; inspect it manually: $RUNTIME_ID"
  exit 1
fi

echo ""
echo "New Codex AgentCore Runtime is READY."
echo "AGENTCORE_RUNTIME_ARN=$RUNTIME_ARN"
echo "AGENTCORE_WORKSPACE_S3_BUCKET=$WORKSPACE_BUCKET"
echo "Image=$ECR_URI:$IMAGE_TAG"
echo ""
echo "Backend configuration was not changed."
