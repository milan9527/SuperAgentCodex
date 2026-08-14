# App Host POC — InsForge Multi-Tenant Architecture

> 每个租户一个 InsForge 实例（PG + PostgREST + App + Deno），每个 App 一个 PG Schema。
> 用 Floci 模拟 AWS S3/IAM，Traefik 做 Ingress 路由。
> 最后更新：2026-05-20

---

## 一、架构概览

```
Docker Desktop
└── docker-compose.floci.yml
    │
    ├── floci:4566                      ← AWS 模拟器（S3 + IAM）
    │
    ├── traefik:8080                    ← 反向代理（按 Host 头路由到租户 InsForge）
    │
    ├── app-host-api:3001               ← 管控面 API（租户/App 生命周期管理）
    │     └── meta-db (PG)              ← 元数据存储
    │
    ├── 【租户: Tenant A】 ─── InsForge 实例 ───
    │     ├── pg-alpha:5433             ← PostgreSQL（per-app schema 隔离）
    │     ├── postgrest-alpha:5430      ← 自动 REST API（过滤/排序/嵌套/聚合）
    │     ├── insforge-alpha:7130/7131  ← App Server + Auth Service
    │     └── deno-alpha:7133           ← Serverless Functions
    │
    ├── 【租户: Tenant B】 ─── InsForge 实例 ───
    │     ├── pg-beta:5434
    │     ├── postgrest-beta:5431
    │     ├── insforge-beta:7230/7231
    │     └── deno-beta:7233
    │
    └── 【租户: Tenant C】 ─── InsForge 实例 ───
          ├── pg-gamma:5435
          ├── postgrest-gamma:5432
          ├── insforge-gamma:7330/7331
          └── deno-gamma:7333
```

### 数据隔离模型

```
租户隔离: 每个租户一个完整 InsForge 实例（独立 PG + 独立 Auth + 独立 Storage）

App 隔离: 同一租户内，每个 App 一个 PG Schema
  pg-alpha (InsForge PG)
    ├── public schema          ← InsForge 内部表（users, functions, etc.）
    ├── app_550e8400e29b       ← Tenant ASchedule Manager App
    │   └── schedules
    ├── app_xxxxxxxxxxxx       ← Tenant ACreative Manager App（未来扩展）
    │   └── ...
    └── ...

S3 隔离: 每个租户一个桶
  app-host-alpha-a1b2c3d4e5f6
  app-host-beta-7a8b9c0d1e2f
  app-host-gamma-3a4b5c6d7e8f
```

### 对比旧 POC（手写 Runtime）

| 能力 | 旧 POC（手写 Runtime） | 新 POC（InsForge） |
|------|----------------------|-------------------|
| Data API | 手写 CRUD（无过滤/排序） | PostgREST（完整 REST，支持过滤/排序/嵌套/分页） |
| 用户认证 | 手写 bcrypt + JWT | InsForge Auth（注册/登录/OAuth/RBAC） |
| 文件存储 | 手写 S3 presigned URL | InsForge Storage（完整文件管理 + CDN） |
| Serverless | 无 | Deno Functions（per-app 命名空间） |
| Agent MCP | 空壳 Agent Bridge | InsForge MCP Server（Agent 直接操作 App 数据） |
| Schema 管理 | 手动建表 | InsForge API 动态建表 + PostgREST 自动暴露 |

---

## 二、系统要求

| 组件 | 最低版本 | 说明 |
|------|---------|------|
| **Docker Desktop** | 4.x+ | 需要 ~6 GB 内存分配 |
| **Node.js** | 20.x+ | 部署脚本运行环境 |
| 磁盘空间 | ~4 GB | InsForge 镜像 + PG 数据卷 |
| 内存 | ~6 GB 空余 | 3 个 InsForge 实例 × 4 容器 |

---

## 三、目录结构

```
poc/
├── README.md                          ← 本文件
├── docker-compose.floci.yml           ← 核心编排文件
├── FLOCI-LOCAL-DEPLOY.md              ← 架构设计文档
│
├── insforge-init/                     ← InsForge PG 初始化文件
│   ├── db-init.sql                    ← 创建 PostgREST 角色
│   ├── jwt.sql                        ← JWT 配置
│   └── postgresql.conf                ← PG 配置（pg_cron, pgcrypto）
│
├── services/
│   └── app-host-api/                  ← 管控面 API（TypeScript / Fastify）
│       ├── package.json
│       ├── Dockerfile
│       └── src/
│           ├── index.ts               ← REST 端点
│           ├── k8s.ts                 ← K8s 资源管理（生产用）
│           └── db.ts                  ← 元数据 PG 操作
│
├── scripts/                           ← TypeScript 部署脚本
│   ├── package.json
│   └── src/
│       ├── deploy.ts                  ← 一键部署
│       ├── setup-aws.ts              ← 创建 S3 桶 + IAM 角色
│       ├── provision-db.ts           ← 创建 per-app schema + 表 + 授权
│       ├── seed.ts                   ← 填充示例数据
│       └── teardown.ts               ← 清理
│
├── cdk/                               ← AWS CDK（生产部署用）
└── k8s/                               ← K8s manifests（EKS 部署用）
```

---

## 四、部署步骤

### 4.1 安装脚本依赖

```bash
cd app-hosting/poc/scripts
npm install
cd ..
```

### 4.2 一键部署

```bash
npx tsx scripts/src/deploy.ts
```

此脚本依次执行：

| 步骤 | 动作 | 耗时 |
|------|------|------|
| 1/4 | `docker compose up -d --build`（含 InsForge 镜像构建） | 首次 ~5-8 分钟 |
| 2/4 | 等待 3 个租户 PG + InsForge App 就绪 | ~30-60 秒 |
| 3/4 | 在 Floci 中创建 S3 桶 + IAM 角色 | ~5 秒 |
| 4/4 | 在各租户 PG 中创建 per-app Schema + 表 + 授权 | ~5 秒 |

### 4.3 填充示例数据

```bash
npx tsx scripts/src/seed.ts
```

### 4.4 验证

```bash
# 直接查 PG
psql -h localhost -p 5433 -U postgres -d insforge -c 'SELECT * FROM app_550e8400e29b.schedules;'
# 密码: alpha_pg_poc_123

# 通过 InsForge API
curl http://localhost:7130/api/health
```

---

## 五、访问地址

### InsForge 实例（per-tenant）

| 租户 | App API | Auth | PostgREST | PG | Deno |
|------|---------|------|-----------|-----|------|
| Tenant A | :7130 | :7131 | :5430 | :5433 | :7133 |
| Tenant B | :7230 | :7231 | :5431 | :5434 | :7233 |
| Tenant C | :7330 | :7331 | :5432 | :5435 | :7333 |

### 基础设施

| 服务 | URL | 用途 |
|------|-----|------|
| Floci (AWS API) | http://localhost:4566 | S3/IAM 操作 |
| App Host API | http://localhost:3001/health | 管控面 |
| Traefik Dashboard | http://localhost:8081 | 路由管理 |

### PG 连接信息

| 租户 | Host | Port | DB | User | Password |
|------|------|------|----|------|----------|
| Tenant A | localhost | 5433 | insforge | postgres | alpha_pg_poc_123 |
| Tenant B | localhost | 5434 | insforge | postgres | beta_pg_poc_123 |
| Tenant C | localhost | 5435 | insforge | postgres | gamma_pg_poc_123 |

---

## 六、API 使用示例

### 6.1 通过 InsForge API 操作数据

```bash
# InsForge 健康检查
curl http://localhost:7130/api/health

# 通过 InsForge Records API 查询（需要先了解 InsForge API 格式）
# 具体端点参考 InsForge 文档: /api/tables/{schema}/{table}/records
```

### 6.2 通过 PostgREST 操作数据

PostgREST 默认暴露 `public` schema。要访问 app schema 的数据，
需要配置 `PGRST_DB_SCHEMA` 包含 app schema，或通过 InsForge API 访问。

```bash
# 直接 PG 查询（最可靠的验证方式）
docker exec -it $(docker ps -qf "name=pg-alpha") \
  psql -U postgres -d insforge -c 'SELECT * FROM app_550e8400e29b.schedules;'
```

### 6.3 InsForge Auth（用户认证）

```bash
# 注册 App 用户（通过 InsForge Auth Service）
curl -X POST http://localhost:7131/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@alpha.com","password":"pass123"}'

# 登录
curl -X POST http://localhost:7131/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@alpha.com","password":"pass123"}'
# 返回 JWT token
```

### 6.4 S3 文件操作（通过 InsForge Storage）

```bash
# InsForge Storage API
curl http://localhost:7130/api/storage/buckets

# 或直接通过 Floci S3
export AWS_ENDPOINT_URL=http://localhost:4566
aws s3 ls s3://app-host-alpha-a1b2c3d4e5f6/ --endpoint-url http://localhost:4566
```

### 6.5 验证租户隔离

```bash
# Tenant A的 InsForge 只能看到Tenant A的数据
docker exec -it $(docker ps -qf "name=pg-alpha") \
  psql -U postgres -d insforge -c '\dn'
# 只有 public + app_550e8400e29b

# Tenant B的 InsForge 完全独立
docker exec -it $(docker ps -qf "name=pg-beta") \
  psql -U postgres -d insforge -c '\dn'
# 只有 public + app_4d5e6f7a8b9c
```

---

## 七、与 Super Agent 的集成点

### 7.1 App 发布流程

```
Super Agent App Builder 点击"发布"
  → Super Agent 后端调用 App Host API: POST /api/tenants/:name/apps
  → App Host API:
      1. 在租户的 InsForge PG 中创建 app_{shortId} schema
      2. 通过 InsForge API 建表（或直接 SQL）
      3. 配置 PostgREST 权限
      4. 返回访问 URL
```

### 7.2 Agent MCP 访问 App 数据

```
Agent 需要查询 App 数据
  → Super Agent 的 agent-app-data-resolver.ts
  → 生成 InsForge MCP 配置:
      {
        command: "npx",
        args: ["-y", "insforge-mcp@latest", "--url", "http://insforge-alpha:7130"],
        env: { INSFORGE_SCHEMA: "app_550e8400e29b" }
      }
  → Agent 通过 MCP 操作 App 的 schedules 表
```

### 7.3 App 前端访问后端

```
App 前端（Nginx 容器）
  → /api/* 请求 proxy 到租户的 InsForge 实例
  → InsForge 根据 JWT 中的 schema claim 路由到正确的 app schema
  → PostgREST 返回数据
```

---

## 八、运维操作

### 查看容器状态

```bash
docker compose -f docker-compose.floci.yml ps
```

### 查看日志

```bash
# 全部
docker compose -f docker-compose.floci.yml logs -f

# 单个租户的 InsForge
docker compose -f docker-compose.floci.yml logs -f insforge-alpha

# 单个租户的 PG
docker compose -f docker-compose.floci.yml logs -f pg-alpha
```

### 连接租户 PG

```bash
docker exec -it $(docker ps -qf "name=pg-alpha") psql -U postgres -d insforge

# 查看所有 schema
\dn

# 查看schedule数据
SELECT * FROM app_550e8400e29b.schedules;
```

### 重启单个租户的 InsForge

```bash
docker compose -f docker-compose.floci.yml restart insforge-alpha
```

---

## 九、清理

```bash
# 全部清理
npx tsx scripts/src/teardown.ts

# 或直接:
docker compose -f docker-compose.floci.yml down -v --remove-orphans
```

---

## 十、从 POC 到生产

| 本地 POC | 生产 (AWS) |
|----------|-----------|
| Floci 模拟 S3 | 真实 S3 |
| Docker Compose 编排 | EKS + Helm |
| InsForge Docker 容器 | InsForge on ECS/EKS |
| PG Docker 容器 | RDS PostgreSQL |
| Traefik Docker labels | Traefik IngressRoute CRD |
| `*.app.localhost` | `*.app.mysuperagent.com` |

**代码不需要改**：InsForge 通过环境变量切换 PG/S3 连接，同一套代码两个环境运行。
