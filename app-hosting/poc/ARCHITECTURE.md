# App Host POC — InsForge 多租户架构设计文档

> **核心决策**: 每个租户一个 InsForge 实例，每个 App 一个 PG Schema。
> **日期**: 2026-05-20 | **版本**: v2.0（InsForge 改造版）

---

## 一、设计目标

| 目标 | 实现方式 |
|------|---------|
| **租户完全隔离** | 每个租户独立 InsForge 实例（独立 PG、独立 Auth、独立 Storage） |
| **App 数据隔离** | 同一租户内，每个 App 一个 PG Schema |
| **开箱即用的后端能力** | InsForge 提供 PostgREST API + Auth + Storage + Deno Functions |
| **Agent 可访问 App 数据** | 通过 InsForge MCP Server，Agent 直接操作 App 的表 |
| **零自建 Runtime** | 不再手写 CRUD/Auth/Files，全部由 InsForge 提供 |
| **本地零成本验证** | Floci 模拟 AWS S3/IAM，Docker Compose 编排 |

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户访问入口                                    │
│                                                                             │
│  App 用户 ──→ {appShortId}.{tenant}.app.localhost ──→ Traefik ──→ InsForge  │
│  管理员   ──→ platform.mysuperagent.com           ──→ Super Agent API       │
│                                                                             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Docker Compose 编排                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │  基础设施层                                                          │     │
│  │                                                                     │     │
│  │  ┌──────────┐  ┌──────────────┐  ┌────────────────────────────┐    │     │
│  │  │  Floci   │  │   Traefik    │  │     App Host API           │    │     │
│  │  │ (AWS 模拟)│  │  (Ingress)   │  │    (管控面/生命周期)        │    │     │
│  │  │ S3 + IAM │  │ Host 路由    │  │  ┌─────────────────────┐   │    │     │
│  │  │ :4566    │  │ :8080/:8081  │  │  │ meta-db (PG)        │   │    │     │
│  │  └──────────┘  └──────────────┘  │  │ tenants/apps 元数据  │   │    │     │
│  │                                   │  └─────────────────────┘   │    │     │
│  │                                   └────────────────────────────┘    │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │  租户层（每个租户一个 InsForge 实例）                                  │     │
│  │                                                                     │     │
│  │  ┌─── Tenant A InsForge ────────────────────────────────────────┐   │     │
│  │  │                                                              │   │     │
│  │  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐   │   │     │
│  │  │  │ PG       │  │ PostgREST │  │ InsForge │  │  Deno    │   │   │     │
│  │  │  │ :5433    │  │ :5430     │  │ App+Auth │  │ Functions│   │   │     │
│  │  │  │          │  │ 自动REST  │  │ :7130    │  │ :7133    │   │   │     │
│  │  │  │ Schemas: │  │ API       │  │ :7131    │  │          │   │   │     │
│  │  │  │ ├ public │  │           │  │          │  │          │   │   │     │
│  │  │  │ ├ app_A  │  │           │  │          │  │          │   │   │     │
│  │  │  │ └ app_B  │  │           │  │          │  │          │   │   │     │
│  │  │  └──────────┘  └───────────┘  └──────────┘  └──────────┘   │   │     │
│  │  └──────────────────────────────────────────────────────────────┘   │     │
│  │                                                                     │     │
│  │  ┌─── Tenant B InsForge ────────────────────────────────────────┐   │     │
│  │  │  PG:5434 | PostgREST:5431 | App:7230 Auth:7231 | Deno:7233  │   │     │
│  │  └──────────────────────────────────────────────────────────────┘   │     │
│  │                                                                     │     │
│  │  ┌─── Tenant C InsForge ────────────────────────────────────────┐   │     │
│  │  │  PG:5435 | PostgREST:5432 | App:7330 Auth:7331 | Deno:7333  │   │     │
│  │  └──────────────────────────────────────────────────────────────┘   │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │  存储层                                                              │     │
│  │                                                                     │     │
│  │  S3 (Floci 模拟):                                                   │     │
│  │    app-host-tenant-a-a1b2c3d4e5f6/                                  │     │
│  │    app-host-tenant-b-7a8b9c0d1e2f/                                  │     │
│  │    app-host-tenant-c-3a4b5c6d7e8f/                                  │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、InsForge 实例组成

每个租户的 InsForge 实例由 4 个容器组成：

```
InsForge 实例 (per-tenant)
│
├── PostgreSQL (ghcr.io/insforge/postgres:v15.13.2)
│   ├── 内置扩展: pg_cron, pgcrypto, http
│   ├── 预置角色: anon, authenticated, project_admin
│   ├── public schema: InsForge 内部表（users, functions, secrets...）
│   └── app_{shortId} schemas: 每个 App 的业务数据
│
├── PostgREST (postgrest/postgrest:v12.2.12)
│   ├── 自动将 PG 表暴露为 REST API
│   ├── 支持: 过滤、排序、分页、嵌套查询、聚合
│   ├── JWT 认证: 根据 role claim 切换权限
│   └── Schema 热加载: NOTIFY pgrst 触发重载
│
├── InsForge App Server (insforge:runner)
│   ├── 端口 7130: 主 API（Records, Tables, Storage, AI）
│   ├── 端口 7131: Auth Service（注册/登录/OAuth/RBAC）
│   ├── Storage: 文件上传/下载/presigned URL
│   ├── MCP Server: Agent 通过 MCP 操作 App 数据
│   └── Admin UI: 数据管理面板
│
└── Deno Runtime (denoland/deno:alpine-2.0.6)
    ├── 端口 7133: Serverless Functions
    ├── Per-app 函数命名空间
    ├── 可访问 PG 和 PostgREST
    └── 60s 超时保护
```

### 资源估算

| 组件 | CPU | RAM | 说明 |
|------|-----|-----|------|
| PG | 0.5 核 | 256 MB | 含 pg_cron 后台进程 |
| PostgREST | 0.1 核 | 64 MB | 纯代理，极轻量 |
| InsForge App | 0.5 核 | 256 MB | Node.js 服务 |
| Deno | 0.2 核 | 128 MB | 按需启动 worker |
| **单租户合计** | **1.3 核** | **704 MB** | |
| **3 租户 + 基础设施** | **~5 核** | **~3 GB** | 含 Traefik + Floci + meta-db |

---

## 四、数据隔离模型

### 4.1 租户级隔离（物理隔离）

```
租户 A 的 InsForge ←──── 完全独立 ────→ 租户 B 的 InsForge

  独立 PG 实例（不同容器、不同数据卷）
  独立 Auth 服务（不同 JWT Secret）
  独立 S3 桶（不同 IAM Role）
  独立 Docker Network（网络不互通）
```

**安全保证**: 即使某个租户的 InsForge 被攻破，也无法访问其他租户的数据。

### 4.2 App 级隔离（Schema 隔离）

```
同一租户的 InsForge PG 内部:

  insforge (database)
  ├── public schema          ← InsForge 系统表（不可被 App 直接访问）
  │   ├── _users             ← 平台用户
  │   ├── _functions         ← Deno 函数注册
  │   ├── _secrets           ← 加密存储
  │   └── ...
  │
  ├── app_550e8400e29b       ← App A（Schedule Manager）
  │   ├── schedules
  │   ├── clients
  │   └── ...
  │
  └── app_3f8a1c07d4b2       ← App B（Creative Manager）
      ├── campaigns
      ├── assets
      └── ...
```

**权限模型**（PostgREST 角色）:

| 角色 | 权限 | 使用场景 |
|------|------|---------|
| `anon` | SELECT on app schemas | 未登录用户（公开 App） |
| `authenticated` | ALL on app schemas | 已登录 App 用户 |
| `project_admin` | ALL + bypass RLS | InsForge 管理员 / Agent MCP |

### 4.3 S3 隔离

```
每个租户一个 S3 桶:
  app-host-{tenantName}-{orgShortId}/
    ├── {appId}/uploads/       ← App 用户上传
    ├── {appId}/frontend/      ← App 前端构建产物
    ├── {appId}/exports/       ← 导出文件
    └── {appId}/temp/          ← 临时文件（TTL 清理）

IAM 隔离:
  app-runtime-tenant-a → 只能访问 app-host-tenant-a-* 桶
  app-runtime-tenant-b → 只能访问 app-host-tenant-b-* 桶
```

---

## 五、App 生命周期

### 5.1 创建 App

```
Super Agent 后端
  │
  │ POST /api/tenants/{tenant}/apps
  │ Body: { appName, schemaDef }
  ▼
App Host API
  │
  ├── 1. 生成 appId (UUID) + shortId (前12位hex)
  ├── 2. 记录到 meta-db (status: creating)
  ├── 3. 连接租户的 InsForge PG
  │      ├── CREATE SCHEMA "app_{shortId}"
  │      ├── GRANT 权限给 anon/authenticated/project_admin
  │      ├── CREATE TABLE（根据 schemaDef）
  │      └── NOTIFY pgrst, 'reload schema'
  ├── 4. 更新 meta-db (status: deployed)
  └── 5. 返回: { appId, schemaName, insforgeUrl, mcpConfig }
```

### 5.2 访问 App 数据

```
方式 1: 通过 PostgREST（自动 REST API）
  GET  http://postgrest-tenant-a:3000/schedules?status=eq.active&order=budget.desc
  POST http://postgrest-tenant-a:3000/schedules
  需要: Authorization: Bearer {JWT with role=authenticated}
  需要: 配置 PGRST_DB_SCHEMA 包含 app schema

方式 2: 通过 InsForge API
  GET  http://insforge-tenant-a:7130/api/tables/app_550e8400e29b/schedules/records
  需要: API Key 或 JWT

方式 3: 通过 Agent MCP
  Agent 使用 insforge-mcp 工具直接操作表
  配置: { command: "npx", args: ["-y", "insforge-mcp@latest", "--url", "http://insforge-tenant-a:7130"] }
  环境: { INSFORGE_SCHEMA: "app_550e8400e29b" }

方式 4: 直接 PG 连接（开发/调试）
  psql -h localhost -p 5433 -U postgres -d insforge
  SELECT * FROM app_550e8400e29b.schedules;
```

### 5.3 删除 App

```
App Host API
  │
  ├── 1. DROP SCHEMA "app_{shortId}" CASCADE
  ├── 2. NOTIFY pgrst, 'reload schema'
  ├── 3. 清理 S3 prefix: s3://bucket/{appId}/*
  └── 4. 删除 meta-db 记录
```

---

## 六、与 Super Agent 的集成

### 6.1 集成架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Super Agent Platform                                           │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ App Builder  │  │ Agent Engine │  │ insforge-orchestrator │  │
│  │ (前端编辑器)  │  │ (对话/工作流) │  │ (schema 管理)         │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                  │                     │              │
└─────────┼──────────────────┼─────────────────────┼──────────────┘
          │                  │                     │
          │ 发布 App         │ MCP 调用            │ provision/destroy
          ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  App Host Service                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │ App Host API │ ←── REST API ──→ Super Agent 后端              │
│  │ :3001        │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         │ 管理 schema                                            │
│         ▼                                                       │
│  ┌─── InsForge (tenant-a) ──┐  ┌─── InsForge (tenant-b) ────────┐   │
│  │ PG + PostgREST + Auth  │  │ PG + PostgREST + Auth        │   │
│  │ + Deno + MCP           │  │ + Deno + MCP                 │   │
│  └────────────────────────┘  └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Agent MCP 访问流程

```
1. Agent 需要查询某个 App 的数据（如"Schedule Manager"）

2. Super Agent 的 agent-app-data-resolver.ts:
   - 查询 app_backend_instances 表
   - 找到 app_id 对应的 InsForge 实例信息
   - 生成 MCP 配置:
     {
       command: "npx",
       args: ["-y", "insforge-mcp@latest", "--url", "http://insforge-tenant-a:7130"],
       env: {
         INSFORGE_URL: "http://insforge-tenant-a:7130",
         INSFORGE_SCHEMA: "app_550e8400e29b"
       }
     }

3. Agent 通过 MCP 工具执行:
   - list_tables → ["schedules", "clients"]
   - query_records("schedules", { status: "active" }) → [...]
   - create_record("schedules", { channel: "Channel-1", ... })

4. InsForge MCP Server:
   - 验证 API Key
   - 将操作限制在 INSFORGE_SCHEMA 指定的 schema 内
   - 执行 SQL 并返回结果
```

### 6.3 App Builder 发布流程

```
1. 用户在 App Builder 中点击"发布"

2. Super Agent 后端:
   a. 构建 App 前端（npm build）
   b. 上传前端产物到 S3: s3://app-host-tenant-a-xxx/{appId}/frontend/
   c. 调用 App Host API:
      POST /api/tenants/tenant-a/apps
      Body: { appName: "Schedule Manager", schemaDef: { tables: { schedules: {...} } } }

3. App Host API:
   a. 在 InsForge PG 中创建 schema + 表
   b. 返回 { schemaName, insforgeUrl, mcpConfig }

4. Super Agent 后端:
   a. 记录 app_backend_instances（provider: 'insforge'）
   b. 更新 published_apps.backend_type = 'insforge'
   c. 返回访问 URL 给前端

5. App 前端容器（可选，Phase 2）:
   - Nginx 容器 serve 静态文件
   - /api/* proxy 到 InsForge App Server
   - Traefik 路由: {shortId}.{tenant}.app.localhost
```

---

## 七、认证模型

### 7.1 双层认证

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: 平台认证（Super Agent）                        │
│  ├── 平台管理员、组织成员                                 │
│  ├── JWT (Cognito / 内置 Auth)                          │
│  └── 用于: 管理后台、App Builder、Agent 对话              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Layer 2: App 认证（InsForge Auth）                      │
│  ├── App 终端用户                                        │
│  ├── InsForge Auth Service (:7131)                      │
│  │   ├── 邮箱/密码注册登录                               │
│  │   ├── OAuth (Google/GitHub/微信/企微)                 │
│  │   └── JWT 签发（含 role claim）                       │
│  └── 用于: Published App 运行时                          │
└─────────────────────────────────────────────────────────┘
```

### 7.2 JWT 流转

```
App 用户登录:
  POST /auth/login → InsForge Auth (:7131)
  返回 JWT: { sub: userId, role: "authenticated", schema: "app_550e8400e29b" }

App 用户访问数据:
  GET /api/data/schedules
  Header: Authorization: Bearer {JWT}
  → InsForge App Server 验证 JWT
  → 设置 PG role = authenticated
  → 查询 app_550e8400e29b.schedules
  → 返回数据

Agent 访问数据:
  MCP 调用 → InsForge MCP Server
  Header: X-API-Key: {apiKey}
  → 设置 PG role = project_admin（绕过 RLS）
  → 查询指定 schema 的表
```

---

## 八、网络隔离

```
Docker Networks:

  default (bridge)
  ├── traefik          ← 可访问所有 InsForge（做路由）
  ├── floci            ← 所有服务可访问（S3）
  ├── app-host-api     ← 可访问所有 InsForge PG（管理 schema）
  └── meta-db          ← 只有 app-host-api 访问

  insforge-tenant-a (bridge)     ← Tenant A 内部网络
  ├── pg-tenant-a
  ├── postgrest-tenant-a
  ├── insforge-tenant-a
  └── deno-tenant-a

  insforge-tenant-b (bridge)     ← Tenant B 内部网络
  ├── pg-tenant-b
  ├── postgrest-tenant-b
  ├── insforge-tenant-b
  └── deno-tenant-b

  insforge-tenant-c (bridge)     ← Tenant C 内部网络
  ├── pg-tenant-c
  ├── postgrest-tenant-c
  ├── insforge-tenant-c
  └── deno-tenant-c
```

**关键**: 租户 A 的 Deno Functions 无法连接租户 B 的 PG（不在同一网络）。

---

## 九、Traefik 路由策略

### POC 阶段

```
路由规则:
  *.tenant-a.app.localhost → insforge-tenant-a:7130
  *.tenant-b.app.localhost → insforge-tenant-b:7130
  *.tenant-c.app.localhost → insforge-tenant-c:7130

实现: Docker labels + HostRegexp
```

### 生产阶段

```
路由规则:
  {shortId}.app.mysuperagent.com → 对应租户的 InsForge

实现:
  Phase 1: 通配符证书 *.app.mysuperagent.com + Traefik IngressRoute
  Phase 3: 支持租户自带域名（CNAME + 独立证书）
```

---

## 十、对比：旧架构 vs 新架构

| 维度 | 旧 POC（手写 Runtime） | 新 POC（InsForge） |
|------|----------------------|-------------------|
| **容器数/租户** | 2（PG + Runtime） | 4（PG + PostgREST + App + Deno） |
| **Data API** | 手写 CRUD，无过滤排序 | PostgREST 完整 REST（过滤/排序/嵌套/分页/聚合） |
| **认证** | 手写 bcrypt + JWT | InsForge Auth（注册/登录/OAuth/RBAC/MFA） |
| **文件存储** | 手写 S3 presigned | InsForge Storage（完整文件管理 + CDN） |
| **Serverless** | 无 | Deno Functions（per-app 命名空间） |
| **Agent 访问** | 空壳 Agent Bridge | InsForge MCP（已在 Super Agent 中打通） |
| **Schema 管理** | 手动 SQL | InsForge API + PostgREST 自动暴露 |
| **Admin UI** | 无 | InsForge Dashboard（:7132） |
| **代码维护** | 自己维护 Runtime | InsForge 社区维护，只需升级镜像 |
| **RAM/租户** | ~320 MB | ~704 MB |
| **与 Super Agent 对接** | 需要写 Agent Bridge | 直接复用 insforge-orchestrator.ts |

**结论**: RAM 多用 ~400MB/租户，换来完整的 BaaS 能力和与 Super Agent 的无缝对接。

---

## 十一、从 POC 到生产的路径

| 阶段 | 编排 | PG | S3 | 路由 | 成本 |
|------|------|-----|-----|------|------|
| **POC（当前）** | Docker Compose | PG 容器 | Floci 模拟 | Traefik labels | $0 |
| **Phase 1** | Docker Compose (生产服务器) | PG 容器 + 定期备份 | 真实 S3 | Traefik + Let's Encrypt | ~$100/月 |
| **Phase 2** | ECS / EKS | RDS PostgreSQL | 真实 S3 + CloudFront | ALB + Traefik | ~$300/月 |
| **Phase 3** | EKS + HPA | RDS Multi-AZ | S3 + CloudFront | 自带域名 | 按需 |

**代码变更**: 零。InsForge 通过环境变量切换 PG/S3 连接，同一套代码所有环境运行。

---

## 十二、关键设计决策记录

### D1: 为什么不用一个共享 InsForge 实例？

**决策**: 每个租户独立 InsForge 实例。

**理由**:
- 租户间完全物理隔离（不同 PG 实例、不同 JWT Secret）
- 一个租户的流量不会影响另一个租户
- 可以按租户独立扩缩容
- 安全审计更简单（每个租户的数据在独立容器中）

**代价**: 容器数量多（4 × N 租户），但每个容器都很轻量。

### D2: 为什么保留 App Host API？

**决策**: 保留独立的管控面 API，不直接让 Super Agent 操作 InsForge PG。

**理由**:
- 关注点分离：App Host API 负责"哪个租户有哪些 App"，InsForge 负责"App 内部的数据"
- Super Agent 只需调用一个 REST API，不需要知道 InsForge 的内部细节
- 未来可以在 App Host API 中加入计费、配额、审计等管控逻辑

### D3: PostgREST 的 Schema 路由问题

**现状**: PostgREST 的 `PGRST_DB_SCHEMA` 是静态配置，不能动态切换。

**解决方案**:
- 方案 A（POC 采用）: 通过 InsForge API 访问数据，不直接暴露 PostgREST
- 方案 B（生产考虑）: 配置 `PGRST_DB_SCHEMA` 为逗号分隔的多 schema，通过 JWT 的 `search_path` claim 切换
- 方案 C: 每个 App 一个 PostgREST 实例（资源浪费，不推荐）

### D4: Deno Functions 的 App 隔离

**现状**: 同一租户的所有 App 共享一个 Deno Runtime。

**隔离方式**:
- 函数按 App 命名空间注册（`app_{shortId}/functionName`）
- 每个函数执行时注入 `INSFORGE_SCHEMA` 环境变量
- Worker 超时保护（60s）
- 未来可加 V8 Isolate 级别隔离
