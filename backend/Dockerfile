# =============================================================================
# Dockerfile for Super Agent Backend
# Multi-stage build for optimized production image
# Requirements: 1.5
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencies
# Install all dependencies including devDependencies for building
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# -----------------------------------------------------------------------------
# Stage 2: Builder
# Build the TypeScript application and generate Prisma client
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Copy built-in skills directory
COPY skills ./skills

# Copy connector-packages (used by connector-registry service)
COPY connector-packages ./connector-packages
COPY runtime-assets ./runtime-assets

# Copy industry-packs if present in build context (placed by deploy script)
# The deploy script ensures this directory exists (may be empty)
COPY industry-packs-build ./industry-packs-build

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript with the same strict gate used by local development and CI.
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: Production
# Minimal production image with only runtime dependencies
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma and curl for health checks
RUN apk add --no-cache openssl curl

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 backend

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Keep the Claude CLI for rollback and pin the Codex CLI used by the local
# Codex app-server runtime.
RUN npm install -g @anthropic-ai/claude-code @openai/codex@0.146.0

# Create workspace directory for agent workspaces
RUN mkdir -p /app/workspaces /home/backend/.codex && \
    chown -R backend:nodejs /app/workspaces /home/backend

# Copy Prisma schema and generated client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy built-in skills directory (used by workspace-manager for built-in skills)
COPY --from=builder /app/skills ./skills

# Copy connector-packages (used by connector-registry service at runtime)
COPY --from=builder /app/connector-packages ./connector-packages
COPY --from=builder /app/runtime-assets ./runtime-assets

# Copy industry-packs (used by pack-deploy service for workflow/skill provisioning)
# Path must resolve to /app/../industry-packs = /industry-packs
COPY --from=builder /app/industry-packs-build /industry-packs

# Set ownership to non-root user
RUN chown -R backend:nodejs /app && chown -R backend:nodejs /industry-packs

# Switch to non-root user
USER backend

# Expose application port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV CODEX_HOME=/home/backend/.codex

# Health check - uses the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
