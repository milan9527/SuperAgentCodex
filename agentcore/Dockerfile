# Super Agent — AgentCore Runtime Container
# Runs Codex app-server inside AWS Bedrock AgentCore.
# Implements the AgentCore HTTP protocol (POST /invocations + GET /ping).

FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app

# Keep the final image below AgentCore's high-layer threshold and use a numeric
# user. AgentCore can return 424 before forwarding requests when a high-layer
# image declares a non-numeric USER.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl git unzip python3 python3-pip python3-venv \
    && pip3 install --break-system-packages --no-cache-dir uv \
    && npm install -g @openai/codex@0.146.0 \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    && mkdir -p /workspace /home/node/.codex \
    && chown -R 1000:1000 /workspace /home/node/.codex /app

COPY --from=build --chown=1000:1000 /app/package*.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist

ENV CODEX_HOME=/home/node/.codex \
    CODEX_EXECUTABLE=/usr/local/bin/codex \
    WORKSPACE_S3_REGION=us-east-1

# Run as non-root
USER 1000:1000

# Keep Codex state outside the mirrored project workspace. AgentCore session
# affinity preserves this directory when the same runtime session is reused.
ENV HOME=/home/node

WORKDIR /workspace

# AgentCore protocol requires port 8080
EXPOSE 8080

# Preload the AWS Distro for OpenTelemetry (ADOT) register hook BEFORE the ESM
# app loads. This CJS hook installs the global OTEL providers + the SigV4-signed
# OTLP→CloudWatch export pipeline (gated on AGENT_OBSERVABILITY_ENABLED + OTEL_*
# env vars set by the deploy script). Our ESM app then emits contract-compliant
# spans/events through the global OTEL API. --require works with ESM apps; the
# hook itself is CommonJS so it coexists with the ESM application.
# Absolute path to the register module: WORKDIR is /workspace but node_modules
# lives in /app, so a bare package specifier in --require won't resolve from CWD.
CMD ["node", "--require", "/app/node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/build/src/register.js", "/app/dist/index.js"]
