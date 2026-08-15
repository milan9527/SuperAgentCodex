#!/usr/bin/env bash
set -Eeuo pipefail

export AWS_PAGER=""

STACK_NAME="SuperAgentCodex"
REGION="us-east-1"
EXECUTION_ROLE_ARN=""

usage() {
  cat <<'EOF'
Usage: ensure-agentcore-tools.sh [options]

Options:
  --stack NAME                 Stack/resource prefix
  --region REGION             AWS region
  --execution-role-arn ARN    Role used if a dedicated tool must be created
  -h, --help                  Show this help

The script creates or verifies dedicated Browser and Code Interpreter
resources. It never updates or deletes an existing resource.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --execution-role-arn) EXECUTION_ROLE_ARN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

[[ -n "$EXECUTION_ROLE_ARN" ]] \
  || { echo "ERROR: --execution-role-arn is required." >&2; exit 1; }

for command_name in aws jq sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 \
    || { echo "ERROR: Required command not found: $command_name" >&2; exit 1; }
done

sanitize_name() {
  printf '%s' "$1" | tr -cd '[:alnum:]_'
}

RESOURCE_PREFIX="$(sanitize_name "$STACK_NAME")"
[[ -n "$RESOURCE_PREFIX" ]] \
  || { echo "ERROR: Stack name does not contain a usable resource prefix." >&2; exit 1; }

BROWSER_NAME="${RESOURCE_PREFIX}_browser_webauth"
BROWSER_NAME="${BROWSER_NAME:0:48}"
CODE_INTERPRETER_NAME="${RESOURCE_PREFIX}_code_interpreter"
CODE_INTERPRETER_NAME="${CODE_INTERPRETER_NAME:0:48}"

wait_for_browser() {
  local browser_id="$1"
  local status="UNKNOWN"
  for attempt in $(seq 1 60); do
    status="$(aws bedrock-agentcore-control get-browser \
      --browser-id "$browser_id" \
      --region "$REGION" \
      --query status \
      --output text 2>/dev/null || echo UNKNOWN)"
    [[ "$status" == "READY" ]] && return 0
    [[ "$status" == "CREATE_FAILED" || "$status" == "DELETE_FAILED" ]] && break
    echo "Browser status: $status ($attempt/60)" >&2
    sleep 5
  done
  echo "ERROR: Browser '$browser_id' did not become READY (status=$status)." >&2
  return 1
}

wait_for_code_interpreter() {
  local code_interpreter_id="$1"
  local status="UNKNOWN"
  for attempt in $(seq 1 60); do
    status="$(aws bedrock-agentcore-control get-code-interpreter \
      --code-interpreter-id "$code_interpreter_id" \
      --region "$REGION" \
      --query status \
      --output text 2>/dev/null || echo UNKNOWN)"
    [[ "$status" == "READY" ]] && return 0
    [[ "$status" == "CREATE_FAILED" || "$status" == "DELETE_FAILED" ]] && break
    echo "Code Interpreter status: $status ($attempt/60)" >&2
    sleep 5
  done
  echo "ERROR: Code Interpreter '$code_interpreter_id' did not become READY (status=$status)." >&2
  return 1
}

BROWSER_ID="$(
  aws bedrock-agentcore-control list-browsers \
    --region "$REGION" \
    --output json \
    | jq -r --arg name "$BROWSER_NAME" \
      '.browserSummaries[] | select(.name == $name) | .browserId' \
    | head -1
)"
if [[ -z "$BROWSER_ID" || "$BROWSER_ID" == "None" ]]; then
  BROWSER_TOKEN="$(printf '%s' "${STACK_NAME}:browser:${REGION}:${EXECUTION_ROLE_ARN}" \
    | sha256sum | cut -d' ' -f1)"
  BROWSER_ID="$(aws bedrock-agentcore-control create-browser \
    --name "$BROWSER_NAME" \
    --description "Dedicated browser with web bot authentication for ${STACK_NAME}" \
    --execution-role-arn "$EXECUTION_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --browser-signing '{"enabled":true}' \
    --client-token "$BROWSER_TOKEN" \
    --region "$REGION" \
    --query browserId \
    --output text)"
fi

wait_for_browser "$BROWSER_ID"
BROWSER_DETAILS="$(aws bedrock-agentcore-control get-browser \
  --browser-id "$BROWSER_ID" \
  --region "$REGION" \
  --output json)"
BROWSER_EXECUTION_ROLE_ARN="$(jq -r '.executionRoleArn // empty' <<<"$BROWSER_DETAILS")"
if [[ -n "$BROWSER_EXECUTION_ROLE_ARN" ]]; then
  aws iam get-role \
    --role-name "${BROWSER_EXECUTION_ROLE_ARN##*/}" \
    >/dev/null
fi
[[ "$(jq -r '.networkConfiguration.networkMode' <<<"$BROWSER_DETAILS")" == "PUBLIC" ]] \
  || { echo "ERROR: Existing browser is not configured for PUBLIC networking." >&2; exit 1; }
[[ "$(jq -r '.browserSigning.enabled' <<<"$BROWSER_DETAILS")" == "true" ]] \
  || { echo "ERROR: Existing browser does not have web bot authentication enabled." >&2; exit 1; }

CODE_INTERPRETER_ID="$(
  aws bedrock-agentcore-control list-code-interpreters \
    --region "$REGION" \
    --output json \
    | jq -r --arg name "$CODE_INTERPRETER_NAME" \
      '.codeInterpreterSummaries[] | select(.name == $name) | .codeInterpreterId' \
    | head -1
)"
if [[ -z "$CODE_INTERPRETER_ID" || "$CODE_INTERPRETER_ID" == "None" ]]; then
  CODE_INTERPRETER_TOKEN="$(
    printf '%s' "${STACK_NAME}:code-interpreter:${REGION}:${EXECUTION_ROLE_ARN}" \
      | sha256sum | cut -d' ' -f1
  )"
  CODE_INTERPRETER_ID="$(aws bedrock-agentcore-control create-code-interpreter \
    --name "$CODE_INTERPRETER_NAME" \
    --description "Dedicated code interpreter for ${STACK_NAME}" \
    --execution-role-arn "$EXECUTION_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --client-token "$CODE_INTERPRETER_TOKEN" \
    --region "$REGION" \
    --query codeInterpreterId \
    --output text)"
fi

wait_for_code_interpreter "$CODE_INTERPRETER_ID"
CODE_INTERPRETER_DETAILS="$(aws bedrock-agentcore-control get-code-interpreter \
  --code-interpreter-id "$CODE_INTERPRETER_ID" \
  --region "$REGION" \
  --output json)"
CODE_INTERPRETER_EXECUTION_ROLE_ARN="$(
  jq -r '.executionRoleArn // empty' <<<"$CODE_INTERPRETER_DETAILS"
)"
if [[ -n "$CODE_INTERPRETER_EXECUTION_ROLE_ARN" ]]; then
  aws iam get-role \
    --role-name "${CODE_INTERPRETER_EXECUTION_ROLE_ARN##*/}" \
    >/dev/null
fi
[[ "$(jq -r '.networkConfiguration.networkMode' <<<"$CODE_INTERPRETER_DETAILS")" == "PUBLIC" ]] \
  || { echo "ERROR: Existing Code Interpreter is not configured for PUBLIC networking." >&2; exit 1; }

echo "AGENTCORE_BROWSER_IDENTIFIER=$BROWSER_ID"
echo "AGENTCORE_CODE_INTERPRETER_IDENTIFIER=$CODE_INTERPRETER_ID"
