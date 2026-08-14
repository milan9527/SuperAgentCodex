/**
 * Published Apps Routes
 * REST API endpoints for the internal mini-SaaS marketplace.
 */

import { FastifyInstance } from 'fastify';
import { stat as fsStat, cp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { join, extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { authenticate } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { prisma } from '../config/database.js';
import type { Prisma } from '@prisma/client';
import { chatService } from '../services/chat.service.js';
import { workspaceManager } from '../services/workspace-manager.js';
import { streamRegistry } from '../services/stream-registry.js';
import { findAppRoot } from '../services/app-finder.js';

const execFileAsync = promisify(execFile);

const APPS_STORAGE_DIR = join(config.claude.workspaceBaseDir, '_published_apps');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export async function appsRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * GET /api/apps — List published apps
   */
  fastify.get<{ Querystring: { status?: string; category?: string; search?: string; page?: string; limit?: string } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        description: 'List published apps',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            category: { type: 'string' },
            search: { type: 'string' },
            page: { type: 'string' },
            limit: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const page = Math.max(1, parseInt(request.query.page || '1'));
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || '20')));

      const where: Record<string, unknown> = {
        org_id: orgId,
        status: request.query.status || 'published',
      };
      if (request.query.category) where.category = request.query.category;
      if (request.query.search) {
        where.OR = [
          { name: { contains: request.query.search, mode: 'insensitive' } },
          { description: { contains: request.query.search, mode: 'insensitive' } },
        ];
      }

      const [data, total] = await Promise.all([
        prisma.published_apps.findMany({
          where,
          orderBy: { published_at: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.published_apps.count({ where }),
      ]);

      return reply.status(200).send({
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    },
  );

  /**
   * GET /api/apps/challenge/current — Get the current weekly challenge
   *
   * Returns the active challenge for the marketplace, or null if none.
   * NOTE: Must be registered BEFORE /:id to avoid parametric route conflict.
   */
  fastify.get(
    '/challenge/current',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Get the current marketplace challenge',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request, reply) => {
      // TODO: Replace with DB-backed challenge model
      const challenge = {
        id: 'weekly-challenge-1',
        title: '本周挑战：做一个团队协作工具',
        description: '使用 AI 创建一个帮助团队协作的工具',
        deadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        participants: 42,
        reward: '⭐ Featured 展示位',
      };
      return reply.status(200).send({ data: challenge });
    },
  );

  /**
   * GET /api/apps/creators/top — Get top app creators
   *
   * Returns the top creators ranked by total app runs within the org.
   * NOTE: Must be registered BEFORE /:id to avoid parametric route conflict.
   */
  fastify.get(
    '/creators/top',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Get top app creators in the org',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;

      // Aggregate apps by published_by user, count apps and sum usage
      const apps = await prisma.published_apps.findMany({
        where: { org_id: orgId, status: 'published' },
        select: { published_by: true, id: true },
      });

      // Get usage counts per app
      const usageCounts = await prisma.app_usage_events.groupBy({
        by: ['app_id'],
        where: { org_id: orgId, event_type: 'launch' },
        _count: { id: true },
      });
      const usageMap = new Map(usageCounts.map(u => [u.app_id, u._count.id]));

      // Aggregate by creator
      const creatorMap = new Map<string, { app_count: number; total_runs: number }>();
      for (const app of apps) {
        if (!app.published_by) continue;
        const existing = creatorMap.get(app.published_by) || { app_count: 0, total_runs: 0 };
        existing.app_count++;
        existing.total_runs += usageMap.get(app.id) || 0;
        creatorMap.set(app.published_by, existing);
      }

      // Sort by total runs and take top 6
      const sorted = [...creatorMap.entries()]
        .sort((a, b) => b[1].total_runs - a[1].total_runs)
        .slice(0, 6);

      // Resolve user names
      const userIds = sorted.map(([id]) => id);
      const users = userIds.length > 0
        ? await prisma.profiles.findMany({
            where: { id: { in: userIds } },
            select: { id: true, full_name: true, username: true, avatar_url: true },
          })
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      const creators = sorted.map(([userId, stats], idx) => {
        const user = userMap.get(userId);
        return {
          id: userId,
          name: user?.full_name || user?.username || 'Unknown',
          avatar: user?.avatar_url || null,
          app_count: stats.app_count,
          total_runs: stats.total_runs,
          rank: idx + 1,
        };
      });

      return reply.status(200).send({ data: creators });
    },
  );

  /**
   * GET /api/apps/:id — Get a single published app
   */
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Get a published app',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const app = await prisma.published_apps.findFirst({
        where: { id: request.params.id, org_id: request.user!.orgId },
      });
      if (!app) return reply.status(404).send({ error: 'App not found' });
      return reply.status(200).send(app);
    },
  );

  /**
   * POST /api/apps — Register a new published app
   */
  fastify.post<{ Body: { name: string; description?: string; icon?: string; category?: string; session_id?: string; business_scope_id?: string; entry_point?: string; bundle_path: string; metadata?: Record<string, unknown> } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Register a published app',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name', 'bundle_path'],
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            icon: { type: 'string' },
            category: { type: 'string' },
            session_id: { type: 'string' },
            business_scope_id: { type: 'string' },
            entry_point: { type: 'string' },
            bundle_path: { type: 'string' },
            metadata: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const app = await prisma.published_apps.create({
        data: {
          org_id: request.user!.orgId,
          session_id: b.session_id || null,
          business_scope_id: b.business_scope_id || null,
          name: b.name,
          description: b.description || null,
          icon: b.icon || '🚀',
          category: b.category || 'tool',
          entry_point: b.entry_point || 'index.html',
          bundle_path: b.bundle_path,
          published_by: request.user!.id,
          metadata: (b.metadata || {}) as Prisma.InputJsonValue,
        },
      });
      return reply.status(201).send(app);
    },
  );

  /**
   * POST /api/apps/publish-from-workspace — Publish an app directly from a session workspace folder.
   *
   * This is the primary endpoint used by the app-publisher skill. It:
   *   1. Resolves the folder path within the session workspace
   *   2. Validates an HTML entry point exists
   *   3. Copies the bundle to the published apps storage directory
   *   4. Creates the DB record
   *   5. Returns the app ID and access URL
   */
  fastify.post<{
    Body: {
      session_id: string;
      folder_path: string;
      name: string;
      description?: string;
      icon?: string;
      category?: string;
      entry_point?: string;
      status?: string;
      backend_type?: string;
    };
  }>(
    '/publish-from-workspace',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Publish or preview an app from a session workspace folder',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['session_id', 'folder_path', 'name'],
          properties: {
            session_id: { type: 'string', format: 'uuid' },
            folder_path: { type: 'string', minLength: 1, description: 'Relative path within the workspace to the app folder' },
            name: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            icon: { type: 'string' },
            category: { type: 'string', enum: ['tool', 'dashboard', 'utility', 'game', 'internal'] },
            entry_point: { type: 'string', description: 'Relative path to the HTML entry point within the folder (default: index.html)' },
            status: { type: 'string', enum: ['published', 'preview'], description: 'App status — "preview" for staging, "published" for marketplace listing' },
            backend_type: { type: 'string', enum: ['none', 'builtin', 'insforge', 'custom'], description: 'Backend data service type for the app' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const { session_id, folder_path, name, description, icon, category, entry_point, status: requestedStatus, backend_type } = request.body;
      const appStatus = requestedStatus === 'preview' ? 'preview' : 'published';

      // 1. Look up the session to get the business_scope_id
      let session;
      try {
        session = await chatService.getSessionById(session_id, orgId);
      } catch {
        return reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }

      const scopeId = session.business_scope_id;
      if (!scopeId) {
        return reply.status(400).send({
          error: 'Session has no business scope — cannot resolve workspace',
          code: 'NO_SCOPE',
        });
      }

      // NOTE: S3 sync before publish is intentionally skipped.
      // The background sync-back in runConversation() already populates the
      // local workspace cache after each agent invocation. Blocking here
      // added seconds of latency for no benefit — the auto-build step below
      // works on whatever files are already local, and for agentcore the
      // container has already built dist/ and synced it to S3 → local.
      // If files are still missing (rare race), the auto-build or entry-point
      // check will surface a clear error.
      // if (config.agentRuntime === 'agentcore') {
      //   try {
      //     await workspaceManager.ensureS3SyncedToLocal(orgId, scopeId, session_id);
      //   } catch (err) {
      //     request.log.warn({ err }, 'S3 sync failed before app publish');
      //   }
      // }

      // 2. Resolve the folder path within the workspace
      const workspacePath = workspaceManager.getSessionWorkspacePath(orgId, scopeId, session_id);
      let resolvedPath = workspaceManager.resolveWorkspaceFilePath(orgId, scopeId, session_id, folder_path);
      if (!resolvedPath) {
        return reply.status(400).send({
          error: 'Invalid folder path (path traversal detected)',
          code: 'INVALID_PATH',
        });
      }

      // 3. Verify the folder exists — if not, try auto-discovering the app root
      let folderExists = false;
      try {
        const st = await fsStat(resolvedPath);
        folderExists = st.isDirectory();
      } catch {
        // folder_path doesn't exist
      }

      if (!folderExists) {
        // Auto-discover: the agent may have created the app in a nested/different folder
        request.log.warn({ folder_path }, 'Specified folder not found, auto-discovering app root');
        const candidate = await findAppRoot(workspacePath);
        if (candidate.score > 0 && candidate.path !== workspacePath) {
          resolvedPath = candidate.path;
          request.log.info({ discovered: candidate.relativePath, score: candidate.score }, 'Auto-discovered app root');
        } else {
          return reply.status(404).send({ error: `Folder not found: ${folder_path}`, code: 'FOLDER_NOT_FOUND' });
        }
      }

      // 4. Auto-build: if the folder has a package.json with a build script,
      //    rebuild when:
      //    a) No dist/ or build/ output exists yet, OR
      //    b) Source files are newer than the existing build output.
      //    This handles both first-time builds and re-builds after the agent
      //    modifies source files (e.g. adding seed data) without rebuilding.
      const pkgJsonPath = join(resolvedPath, 'package.json');
      const hasDist = existsSync(join(resolvedPath, 'dist'));
      const hasBuild = existsSync(join(resolvedPath, 'build'));

      // Check if source files are newer than the build output
      let sourceNewerThanBuild = false;
      if (hasDist || hasBuild) {
        try {
          const buildDir = hasDist ? join(resolvedPath, 'dist') : join(resolvedPath, 'build');
          const buildMtime = (await fsStat(buildDir)).mtimeMs;

          // Check if any source file is newer than the build directory
          const srcDir = join(resolvedPath, 'src');
          if (existsSync(srcDir)) {
            const checkNewer = async (dir: string): Promise<boolean> => {
              const entries = await import('fs/promises').then(m => m.readdir(dir, { withFileTypes: true }));
              for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                  if (await checkNewer(fullPath)) return true;
                } else {
                  const fileMtime = (await fsStat(fullPath)).mtimeMs;
                  if (fileMtime > buildMtime) return true;
                }
              }
              return false;
            };
            sourceNewerThanBuild = await checkNewer(srcDir);
          }

          // Also check top-level config files (package.json, vite.config.*, index.html)
          if (!sourceNewerThanBuild) {
            for (const configFile of ['package.json', 'index.html', 'vite.config.ts', 'vite.config.js']) {
              const cfgPath = join(resolvedPath, configFile);
              if (existsSync(cfgPath)) {
                const cfgMtime = (await fsStat(cfgPath)).mtimeMs;
                if (cfgMtime > buildMtime) {
                  sourceNewerThanBuild = true;
                  break;
                }
              }
            }
          }

          if (sourceNewerThanBuild) {
            request.log.info({ folder_path }, 'Source files are newer than build output — will rebuild');
          }
        } catch (err) {
          request.log.warn({ err }, 'Failed to check source vs build timestamps, skipping rebuild check');
        }
      }

      const needsBuild = !hasDist && !hasBuild;

      // Pre-build: Inject InsForge token into .env so Vite inlines it during build
      if (config.insforge.enabled && existsSync(join(resolvedPath, '.env'))) {
        try {
          const { createHmac } = await import('crypto');
          const jwtSecret = process.env.INSFORGE_JWT_SECRET || config.insforge.jwtSecret;
          const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
          const payload = Buffer.from(JSON.stringify({ role: 'authenticated', iss: 'super-agent', exp: 4102444800 })).toString('base64url');
          const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
          const token = `${header}.${payload}.${signature}`;

          let envContent = await readFile(join(resolvedPath, '.env'), 'utf-8');
          if (envContent.includes('__INSFORGE_TOKEN__')) {
            envContent = envContent.replace('__INSFORGE_TOKEN__', token);
            envContent = envContent.replace(/VITE_INSFORGE_URL=.*/, `VITE_INSFORGE_URL=http://${config.insforge.host}:${config.insforge.portPostgrest}`);
            await writeFile(join(resolvedPath, '.env'), envContent, 'utf-8');
            request.log.info({ folder_path }, 'Injected InsForge token into .env before build');
          }
        } catch (tokenErr: any) {
          request.log.warn({ err: tokenErr?.message }, 'Failed to inject InsForge token');
        }
      }

      if (existsSync(pkgJsonPath) && (needsBuild || sourceNewerThanBuild)) {
        try {
          const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
          const hasBuildScript = pkg.scripts?.build;

          if (hasBuildScript) {
            request.log.info({ folder_path, reason: needsBuild ? 'no-build-output' : 'source-newer' },
              needsBuild ? 'No dist/build found — auto-building app' : 'Source files changed — rebuilding app');

            // Ensure Vite projects use relative base path for sub-path deployment.
            // Published apps are served under /api/apps/<uuid>/static/, not root /.
            const viteConfigCandidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
            let isViteProject = false;
            for (const vc of viteConfigCandidates) {
              const vcPath = join(resolvedPath, vc);
              if (existsSync(vcPath)) {
                isViteProject = true;
                try {
                  let vcContent = await readFile(vcPath, 'utf-8');
                  if (!vcContent.includes("base:") && !vcContent.includes("base :")) {
                    vcContent = vcContent.replace(
                      /defineConfig\(\s*\{/,
                      "defineConfig({\n  base: './',",
                    );
                    await writeFile(vcPath, vcContent, 'utf-8');
                    request.log.info({ viteConfig: vc }, 'Injected base: "./" for sub-path deployment');
                  }
                } catch { /* non-critical */ }

                // Ensure tsconfig.json exists if the project has .ts/.tsx files
                // Without it, tsc-based build scripts will fail
                const tsconfigPath = join(resolvedPath, 'tsconfig.json');
                if (!existsSync(tsconfigPath)) {
                  const hasTsFiles = existsSync(join(resolvedPath, 'src', 'main.tsx'))
                    || existsSync(join(resolvedPath, 'src', 'main.ts'))
                    || existsSync(join(resolvedPath, 'src', 'App.tsx'));
                  if (hasTsFiles) {
                    const minimalTsconfig = JSON.stringify({
                      compilerOptions: {
                        target: 'ES2020',
                        useDefineForClassFields: true,
                        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
                        module: 'ESNext',
                        skipLibCheck: true,
                        moduleResolution: 'bundler',
                        allowImportingTsExtensions: true,
                        isolatedModules: true,
                        noEmit: true,
                        jsx: 'react-jsx',
                        strict: false,
                        noUnusedLocals: false,
                        noUnusedParameters: false,
                      },
                      include: ['src'],
                    }, null, 2);
                    await writeFile(tsconfigPath, minimalTsconfig, 'utf-8');
                    request.log.info({ folder_path }, 'Generated minimal tsconfig.json for Vite+TS project');
                  }
                }

                break;
              }
            }

            // Install dependencies and build.
            // The workspace may have a partial node_modules (runtime deps synced
            // from S3) but missing devDependencies (vite, etc.) and possibly
            // missing third-party deps the agent added. Run a full npm install
            // to ensure everything is present.
            //
            // IMPORTANT: Override NODE_ENV to ensure devDependencies (vite,
            // typescript, etc.) are installed — the backend runs with
            // NODE_ENV=production which causes npm to skip devDependencies.
            const buildEnv = { ...process.env, NODE_ENV: 'development' };

            request.log.info({ folder_path }, 'Running npm install');
            try {
              const { stderr: installStderr } = await execFileAsync('npm', ['install'], {
                cwd: resolvedPath,
                timeout: 120_000,
                env: buildEnv,
              });
              if (installStderr) {
                request.log.warn({ folder_path, stderr: installStderr.slice(0, 500) }, 'npm install stderr');
              }
            } catch (installErr: any) {
              throw new Error(`npm install failed: ${installErr?.message || 'Unknown error'}`);
            }

            request.log.info({ folder_path }, 'npm install completed, running build');

            if (isViteProject) {
              const viteBin = join(resolvedPath, 'node_modules', '.bin', 'vite');
              try {
                if (existsSync(viteBin)) {
                  await execFileAsync(viteBin, ['build'], {
                    cwd: resolvedPath,
                    timeout: 60_000,
                    env: buildEnv,
                  });
                } else {
                  request.log.warn({ folder_path, viteBin }, 'vite binary not found after npm install, falling back to npx');
                  await execFileAsync('npx', ['vite', 'build'], {
                    cwd: resolvedPath,
                    timeout: 60_000,
                    env: buildEnv,
                  });
                }
              } catch (viteBuildErr: any) {
                // Vite build may fail due to TypeScript errors — retry with --force or esbuild-only
                request.log.warn({ folder_path, err: viteBuildErr?.message?.slice(0, 200) }, 'Vite build failed, retrying without type checking');
                const viteCmd = existsSync(viteBin) ? viteBin : 'npx';
                const viteArgs = existsSync(viteBin) ? ['build'] : ['vite', 'build'];
                // Set VITE_CJS_IGNORE_WARNING and skip tsc by using esbuild directly
                await execFileAsync(viteCmd, viteArgs, {
                  cwd: resolvedPath,
                  timeout: 60_000,
                  env: { ...buildEnv, VITE_CJS_IGNORE_WARNING: 'true', TSC_COMPILE_ON_ERROR: 'true' },
                });
              }
            } else {
              await execFileAsync('npm', ['run', 'build'], {
                cwd: resolvedPath,
                timeout: 60_000,
                env: buildEnv,
              });
            }

            request.log.info({ folder_path }, 'Auto-build completed');
          }
        } catch (buildErr: any) {
          request.log.error({ err: buildErr?.message, folder_path }, 'Auto-build failed');
          return reply.status(500).send({
            error: `App build failed: ${buildErr?.message || 'Unknown error'}. Ensure the app has a valid build script.`,
            code: 'BUILD_FAILED',
          });
        }
      }

      // 5. Determine entry point — check common locations
      //    Prefer dist/ and build/ over root index.html because root index.html
      //    in framework projects (Vite, CRA) is the dev template, not the built output.
      let resolvedEntry = entry_point || 'index.html';
      const candidateEntries = entry_point
        ? [entry_point]
        : ['dist/index.html', 'build/index.html', 'index.html'];

      let foundEntry = false;
      for (const candidate of candidateEntries) {
        if (existsSync(join(resolvedPath, candidate))) {
          resolvedEntry = candidate;
          foundEntry = true;
          break;
        }
      }

      if (!foundEntry) {
        // Last resort: auto-discover a better app folder that has an entry point
        const candidate = await findAppRoot(workspacePath);
        if (candidate.score > 0 && candidate.path !== resolvedPath) {
          resolvedPath = candidate.path;
          request.log.info({ discovered: candidate.relativePath, score: candidate.score }, 'Re-discovered app root for entry point');
          for (const candidate2 of candidateEntries) {
            if (existsSync(join(resolvedPath, candidate2))) {
              resolvedEntry = candidate2;
              foundEntry = true;
              break;
            }
          }
        }
      }

      if (!foundEntry) {
        return reply.status(400).send({
          error: `No HTML entry point found. Checked: ${candidateEntries.join(', ')}. If this is a framework project, run the build step first.`,
          code: 'NO_ENTRY_POINT',
        });
      }

      // If the entry is inside a build output subfolder (dist/ or build/),
      // copy only that subfolder instead of the entire project directory.
      const safePath = resolvedPath as string; // guaranteed non-null after early return above
      let copySourcePath = safePath;
      if (resolvedEntry.startsWith('dist/') || resolvedEntry.startsWith('build/')) {
        const buildDir = resolvedEntry.startsWith('dist/') ? 'dist' : 'build';
        copySourcePath = join(safePath, buildDir);
        resolvedEntry = 'index.html'; // entry is now at root of the copied folder
      }

      // 6. Check if this app was already published from the same session + folder
      const existingApp = await prisma.published_apps.findFirst({
        where: {
          org_id: orgId,
          session_id: session_id,
          status: appStatus,
          metadata: { path: ['source_folder'], equals: folder_path },
        },
      });

      if (existingApp) {
        // ── UPGRADE existing app ──

        // Bump version: 1.0.0 → 1.1.0, 1.1.0 → 1.2.0, etc.
        const parts = (existingApp.version || '1.0.0').split('.');
        const minor = parseInt(parts[1] || '0') + 1;
        const newVersion = `${parts[0]}.${minor}.0`;

        // Save old version to history
        await prisma.app_versions.create({
          data: {
            app_id: existingApp.id,
            version: existingApp.version,
            bundle_path: existingApp.bundle_path,
            published_by: existingApp.published_by,
          },
        });

        // Replace the bundle on disk
        const targetDir = existingApp.bundle_path;
        try {
          await rm(targetDir, { recursive: true, force: true });
        } catch { /* old dir may already be gone */ }
        await mkdir(targetDir, { recursive: true });
        try {
          await cp(copySourcePath, targetDir, { recursive: true });
        } catch {
          return reply.status(500).send({ error: 'Failed to copy app bundle', code: 'COPY_FAILED' });
        }

        // Re-execute db-init.sql on upgrade (handles schema migrations)
        const dbInitPath = join(resolvedPath, 'db-init.sql');
        if (existsSync(dbInitPath) && config.insforge.enabled) {
          try {
            const { execFile: ef } = await import('child_process');
            const { promisify: p } = await import('util');
            const execFileP = p(ef);
            const sqlContent = await readFile(dbInitPath, 'utf-8');
            await execFileP('psql', [
              '-h', config.insforge.host,
              '-p', String(config.insforge.portPostgres),
              '-U', config.insforge.pgUser,
              '-d', config.insforge.pgDb,
              '--no-psqlrc',
              '-c', sqlContent,
            ], {
              timeout: 15_000,
              env: { ...process.env, PGPASSWORD: config.insforge.pgPassword },
            });
            request.log.info({ folder_path }, 'Executed db-init.sql on upgrade');
          } catch (dbErr: any) {
            request.log.warn({ err: dbErr?.message }, 'db-init.sql execution failed on upgrade (non-fatal)');
          }
        }

        // Update DB record
        const app = await prisma.published_apps.update({
          where: { id: existingApp.id },
          data: {
            name,
            description: description || existingApp.description,
            icon: icon || existingApp.icon,
            category: category || existingApp.category,
            entry_point: resolvedEntry,
            version: newVersion,
            published_at: new Date(),
            metadata: { source_folder: folder_path },
          },
        });

        const accessUrl = `/api/apps/${app.id}/static/${resolvedEntry}`;

        // Emit preview_ready SSE event for preview apps
        if (appStatus === 'preview' && streamRegistry.isActive(session_id)) {
          streamRegistry.push(session_id, {
            type: 'preview_ready',
            appId: app.id,
            url: accessUrl,
            appName: name,
          });
        }

        return reply.status(200).send({ ...app, access_url: accessUrl, upgraded: true, previous_version: existingApp.version });
      }

      // ── NEW publish ──

      // 7. Copy bundle to published apps storage
      await mkdir(APPS_STORAGE_DIR, { recursive: true });
      const appId = crypto.randomUUID();
      const targetDir = join(APPS_STORAGE_DIR, appId);

      try {
        await cp(copySourcePath, targetDir, { recursive: true });
      } catch (err) {
        return reply.status(500).send({
          error: 'Failed to copy app bundle',
          code: 'COPY_FAILED',
        });
      }

      // 7.6. Execute db-init.sql if present (creates tables in InsForge)
      const dbInitPath = join(resolvedPath, 'db-init.sql');
      if (existsSync(dbInitPath) && config.insforge.enabled) {
        try {
          const { execFile: ef } = await import('child_process');
          const { promisify: p } = await import('util');
          const execFileP = p(ef);
          const sqlContent = await readFile(dbInitPath, 'utf-8');
          await execFileP('psql', [
            '-h', config.insforge.host,
            '-p', String(config.insforge.portPostgres),
            '-U', config.insforge.pgUser,
            '-d', config.insforge.pgDb,
            '--no-psqlrc',
            '-c', sqlContent,
          ], {
            timeout: 15_000,
            env: { ...process.env, PGPASSWORD: config.insforge.pgPassword },
          });
          request.log.info({ folder_path }, 'Executed db-init.sql against InsForge');
        } catch (dbErr: any) {
          request.log.warn({ err: dbErr?.message, folder_path }, 'db-init.sql execution failed (non-fatal)');
        }
      }

      // 8. Create DB record
      const app = await prisma.published_apps.create({
        data: {
          id: appId,
          org_id: orgId,
          session_id: session_id,
          business_scope_id: scopeId,
          name,
          description: description || null,
          icon: icon || '🚀',
          category: category || 'tool',
          status: appStatus,
          entry_point: resolvedEntry,
          bundle_path: targetDir,
          published_by: request.user!.id,
          backend_type: backend_type || 'none',
          metadata: { source_folder: folder_path },
        },
      });

      const accessUrl = `/api/apps/${appId}/static/${resolvedEntry}`;

      // Emit preview_ready SSE event for preview apps
      if (appStatus === 'preview' && streamRegistry.isActive(session_id)) {
        streamRegistry.push(session_id, {
          type: 'preview_ready',
          appId: app.id,
          url: accessUrl,
          appName: name,
        });
      }

      return reply.status(201).send({
        ...app,
        access_url: accessUrl,
        backend_type: app.backend_type,
      });
    },
  );

  /**
   * GET /api/apps/:id/static/* — Serve built app files
   *
   * Auth strategy: HTML entry points require a ?token= query param (verified via authenticate).
   * Non-HTML assets (JS, CSS, images, fonts) are served without auth — they are build
   * artifacts with no sensitive data, and the app ID is a non-guessable UUID.
   */
  fastify.get<{ Params: { id: string; '*': string }; Querystring: { token?: string } }>(
    '/:id/static/*',
    {
      schema: {
        description: 'Serve published app static files',
        tags: ['Apps'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            '*': { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const appId = request.params.id;
      const requestedPath = request.params['*'] || '';
      const ext = extname(requestedPath).toLowerCase();
      const isHtml = ext === '.html' || ext === '.htm' || !requestedPath;

      // HTML entry points require authentication (token comes via ?token= on the iframe src)
      if (isHtml) {
        await authenticate(request, reply);
        if (reply.sent) return; // auth failed, response already sent
      }

      // Look up the app — for HTML we can filter by org, for assets we just check existence
      const where: Record<string, unknown> = { id: appId };
      if (request.user?.orgId) where.org_id = request.user.orgId;
      const app = await prisma.published_apps.findFirst({ where });
      if (!app) return reply.status(404).send({ error: 'App not found' });

      const resolvedPath = requestedPath || app.entry_point;
      const filePath = join(APPS_STORAGE_DIR, app.id, resolvedPath);

      // Security: prevent path traversal
      if (!filePath.startsWith(join(APPS_STORAGE_DIR, app.id))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const staticPrefix = `/api/apps/${app.id}/static/`;

      // Helper: serve HTML with absolute asset paths rewritten to the app sub-path.
      const serveHtml = async (htmlPath: string) => {
        let html = await readFile(htmlPath, 'utf-8');
        html = html.replace(/(src|href|action)="\/(?!\/)/g, `$1="${staticPrefix}`);
        html = html.replace(/url\("\/(?!\/)/g, `url("${staticPrefix}`);
        return reply
          .type('text/html')
          .header('Content-Length', Buffer.byteLength(html))
          .header('Cache-Control', 'no-cache')
          .send(html);
      };

      if (!existsSync(filePath)) {
        // SPA fallback — serve entry point for client-side routing
        const indexPath = join(APPS_STORAGE_DIR, app.id, app.entry_point);
        if (existsSync(indexPath)) {
          return serveHtml(indexPath);
        }
        return reply.status(404).send({ error: 'File not found' });
      }

      // HTML files get path rewriting
      if (isHtml) {
        return serveHtml(filePath);
      }

      // Non-HTML assets: serve as-is with long cache
      const stat = await fsStat(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      return reply
        .type(contentType)
        .header('Content-Length', stat.size)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(createReadStream(filePath));
    },
  );

  /**
   * POST /api/apps/:id/fork — Fork (clone) an existing app
   *
   * Creates a copy of the app for the current user.
   */
  fastify.post<{ Params: { id: string } }>(
    '/:id/fork',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Fork an existing published app',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const sourceApp = await prisma.published_apps.findFirst({
        where: { id: request.params.id, org_id: orgId },
      });
      if (!sourceApp) return reply.status(404).send({ error: 'App not found' });

      // Create a copy with new ID
      const newId = crypto.randomUUID();
      const targetDir = join(APPS_STORAGE_DIR, newId);

      // Copy bundle
      try {
        await mkdir(targetDir, { recursive: true });
        await cp(sourceApp.bundle_path, targetDir, { recursive: true });
      } catch {
        return reply.status(500).send({ error: 'Failed to fork app bundle' });
      }

      // Create DB record
      const forkedApp = await prisma.published_apps.create({
        data: {
          id: newId,
          org_id: orgId,
          name: `${sourceApp.name} (Fork)`,
          description: sourceApp.description,
          icon: sourceApp.icon,
          category: sourceApp.category,
          version: '1.0.0',
          status: 'published',
          entry_point: sourceApp.entry_point,
          bundle_path: targetDir,
          published_by: request.user!.id,
          metadata: { forked_from: sourceApp.id },
        },
      });

      return reply.status(201).send(forkedApp);
    },
  );

  /**
   * DELETE /api/apps/:id — Permanently delete a published app
   *
   * Removes the DB record (cascades to usage events, ratings, versions)
   * and deletes the on-disk bundle directory.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Permanently delete a published app and its associated data',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const app = await prisma.published_apps.findFirst({
        where: { id: request.params.id, org_id: request.user!.orgId },
      });
      if (!app) return reply.status(404).send({ error: 'App not found' });

      // Delete DB record — FK cascades handle usage_events, ratings, versions
      await prisma.published_apps.delete({ where: { id: app.id } });

      // Best-effort cleanup of the on-disk bundle
      const bundleDir = join(APPS_STORAGE_DIR, app.id);
      try {
        const { rm } = await import('fs/promises');
        await rm(bundleDir, { recursive: true, force: true });
      } catch {
        // Non-fatal — the DB record is already gone
        request.log.warn({ appId: app.id, bundleDir }, 'Failed to remove app bundle directory');
      }

      return reply.status(200).send({ deleted: true, id: app.id });
    },
  );

  /**
   * DELETE /api/apps — Bulk-delete multiple published apps
   *
   * Accepts { ids: string[] } in the request body.
   */
  fastify.delete<{ Body: { ids: string[] } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Bulk-delete published apps',
        tags: ['Apps'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const { ids } = request.body;

      // Only delete apps that belong to this org
      const apps = await prisma.published_apps.findMany({
        where: { id: { in: ids }, org_id: orgId },
        select: { id: true },
      });
      const validIds = apps.map(a => a.id);

      if (validIds.length === 0) {
        return reply.status(404).send({ error: 'No matching apps found' });
      }

      await prisma.published_apps.deleteMany({ where: { id: { in: validIds } } });

      // Best-effort cleanup of bundle directories
      const { rm } = await import('fs/promises');
      for (const appId of validIds) {
        try {
          await rm(join(APPS_STORAGE_DIR, appId), { recursive: true, force: true });
        } catch {
          request.log.warn({ appId }, 'Failed to remove app bundle directory');
        }
      }

      return reply.status(200).send({ deleted: true, count: validIds.length, ids: validIds });
    },
  );
}
