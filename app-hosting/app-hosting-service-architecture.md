# App 托管服务独立架构方案

> **核心思路**: App Builder 产出的应用不再由 Super Agent 进程托管，而是部署到独立的 **App Host Service**，实现真正的应用级隔离和独立运维。
> **日期**: 2026-05-15 | **v2.0** — 补充容器编排决策、路由/证书策略、标识符体系

---

## 一、设计目标

| 目标 | 说明 |
|------|------|
| **进程隔离** | App 运行时不占用 Super Agent 的计算资源，不会因 App 流量拖垮主平台 |
| **租户隔离** | 每个组织（org）有独立的 PG 数据库和 S3 桶，App 只能访问自己 prefix 下的资源 |
| **弹性伸缩** | App 容器可独立扩缩容，不影响主平台 |
| **资源复用** | 同一个 Org 下的多个 App 共享 PG 实例（不同 Schema），节省成本 |
| **AI 不中断** | App 通过内部 API 调用 Super Agent 的 Agent/Workflow/RAG 能力 |

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           用户访问入口                                   │
│                                                                         │
│   外部用户 ──→ app.alpha.com/{appId} ──→ App Host Ingress               │
│   内部用户 ──→ platform.alpha.com    ──→ Super Agent API                │
│                                                                         │
└────────────┬──────────────────────────────────────┬─────────────────────┘
             │                                      │
             ▼                                      ▼
┌────────────────────────────┐    ┌─────────────────────────────────────┐
│   App Host Service（新）    │    │   Super Agent Platform（已有）       │
│   独立进程，独立部署         │    │   Agent / Workflow / Skills / RAG   │
│                            │    │                                     │
│  ┌──────────────────────┐  │    │  ┌───────────────────────────────┐  │
│  │  Ingress / Router    │  │    │  │  Agent API                    │  │
│  │  (Traefik)           │  │    │  │  POST /api/chat              │  │
│  └──────────┬───────────┘  │    │  │  POST /api/workflows/:id/run  │  │
│             │              │    │  │  GET  /api/knowledge/search   │  │
│  ┌──────────▼───────────┐  │    │  └──────┬────────────────────────┘  │
│  │  Per-App Containers   │  │    │         │                           │
│  │                       │  │    │         │ Agent API（内部调用）      │
│  │  ┌─────┐ ┌─────┐     │  │◄───┼─────────┘                           │
│  │  │App-A│ │App-B│ ... │  │────┼──→ Agent API 调用                   │
│  │  │ FE  │ │ FE  │     │  │    │                                     │
│  │  │ BE  │ │ BE  │     │  │    │  ┌───────────────────────────────┐  │
│  │  └──┬──┘ └──┬──┘     │  │    │  │  Super Agent PG               │  │
│  │     │       │        │  │    │  │  (agents, workflows, skills)  │  │
│  │     │       │        │  │    │  └───────────────────────────────┘  │
│  └─────┼───────┼────────┘  │    │                                     │
│        │       │           │    └─────────────────────────────────────┘
│        ▼       ▼           │
│  ┌──────────────────────┐  │
│  │  Org PG (多租户)      │  │
│  │  ┌──────┐ ┌──────┐   │  │
│  │  │app_A │ │app_B │   │  │  ← 同一 Org 的 PG 实例
│  │  │schema│ │schema│   │  │    不同 App 用不同 Schema
│  │  └──────┘ └──────┘   │  │
│  └──────────────────────┘  │
│                            │
│  ┌──────────────────────┐  │
│  │  S3 (Per-Org Bucket) │  │
│  │  /org_xxx/           │  │
│  │    /app_A/  ← 前端+文件│  │
│  │    /app_B/           │  │
│  └──────────────────────┘  │
└────────────────────────────┘
```

---

## 三、核心组件详细设计

### 3.1 Per-App 容器模型

每个 Published App 由 **两个容器** 组成：

```
┌─ App Pod ──────────────────────────────────┐
│                                            │
│  ┌── Frontend Container ──────────────┐    │
│  │  Nginx / Caddy                     │    │
│  │  ├── /              → index.html   │    │
│  │  ├── /assets/*      → 静态资源      │    │
│  │  └── /api/*         → proxy_pass   │──┐ │
│  │                        到 Backend    │  │ │
│  └────────────────────────────────────┘  │ │
│                                          │ │
│  ┌── Backend Container ───────────────┐  │ │
│  │  Node.js / Deno                     │◄─┘ │
│  │  ├── /api/data/*    → CRUD (PG)    │    │
│  │  ├── /api/auth/*    → 用户认证      │    │
│  │  ├── /api/files/*   → S3 操作      │    │
│  │  └── /api/agent/*   → 代理到        │───→ Super Agent API
│  │                       Super Agent   │    │
│  └────────────────────────────────────┘    │
│                                            │
└────────────────────────────────────────────┘
```

#### 容器规格

| 组件 | 镜像 | 默认资源 | 说明 |
|------|------|---------|------|
| **Frontend** | `nginx:alpine` 或 `caddy:alpine` | CPU 0.1核 / RAM 64MB | 纯静态文件服务 + 反向代理 |
| **Backend** | `app-host-runtime:latest`（自建） | CPU 0.5核 / RAM 256MB | Node.js 运行时，提供 Data API + Auth + S3 + Agent代理 |

**资源节省考量**：对于极简 App（只有前端、不需要自定义后端逻辑），可以只部署 Frontend 容器，Data API 请求直接代理到 App Host Service 的共享 Data API 服务（见 3.3）。

### 3.2 三种 App 部署模式

```
模式 A — 轻量模式（只有前端容器）
├── 适用：纯展示型 App、内部工具、简单 CRUD
├── Frontend 容器 + 共享 Data API Service
├── 资源占用：~64MB RAM
└── 成本最低

模式 B — 标准模式（前端 + 后端容器）
├── 适用：需要自定义业务逻辑、定时任务、事件钩子
├── Frontend 容器 + Backend 容器
├── 资源占用：~320MB RAM
└── Tenant A大部分场景适用

模式 C — 重型模式（前端 + 后端 + 额外服务）
├── 适用：需要 Redis、专用 PG 扩展（PostGIS/时序库）
├── 标准模式 + Sidecar 容器
├── 资源占用：按需
└── Sentiment Analysis、效果数据仓库等场景
```

### 3.3 App Host Service — 管控面

这是独立于 Super Agent 的**新服务**，负责 App 的全生命周期管理。

```
App Host Service（管控面）
├── App Lifecycle Manager
│   ├── 创建 App → 分配 Schema → 拉起容器 → 配置路由
│   ├── 更新 App → 重新构建 → 滚动更新容器
│   ├── 停止 App → 停容器 → 保留数据
│   └── 删除 App → 停容器 → 删 Schema → 清 S3 prefix
│
├── Shared Data API Service（共享数据服务）
│   ├── 为"轻量模式"App 提供 CRUD
│   ├── 直接操作 Org PG 中对应 App 的 Schema
│   └── 比 per-app backend 容器更省资源
│
├── Tenant Provisioning
│   ├── 新 Org 注册 → 创建 PG 数据库 → 创建 S3 桶
│   ├── Org 下新建 App → 在 Org PG 中创建 Schema → 创建 S3 prefix
│   └── 配置 IAM Policy 限制 S3 访问范围
│
├── Ingress / Routing（Traefik）
│   ├── Traefik 挂载 Docker Socket，自动发现带 labels 的容器
│   ├── 新增/删除 App 容器时路由热生效，零中断
│   ├── URL 格式：{shortId}.app.{platformDomain}
│   └── TLS：平台级通配符证书（见 3.7）
│
├── Monitor & Scaling
│   ├── 容器健康检查
│   ├── 自动扩缩容（基于请求量）
│   └── 资源配额管理（CPU/RAM/存储）
│
└── Agent Bridge（与 Super Agent 通信）
    ├── 内部服务间认证（mTLS 或共享密钥）
    ├── 代理 App 的 Agent API 请求到 Super Agent
    ├── 注入 App 上下文（appId, orgId, userId）
    └── 流量控制和计费
```

### 3.4 多租户 PG 隔离方案

#### 原则

- **一个 Org 一个 PG 数据库实例**
- **一个 App 一个 PG Schema**
- App 的 Backend 容器只能连接自己 Org 的 PG、访问自己的 Schema

#### Schema 命名规则

PG 标识符上限 **63 字节**。UUID 含连字符（`-`）不是合法未引用标识符，因此 Schema 名取 UUID 去 `-` 后的前 12 位 hex：

```
App ID (UUID): 550e8400-e29b-41d4-a716-446655440000
去连字符:       550e8400e29b41d4a716446655440000
取前12位:       550e8400e29b
Schema 名:     app_550e8400e29b      ← 16字符，远低于63字节上限

碰撞概率: 12 hex = 48 bit ≈ 2.8×10^14，同一 Org 下几十个 App 零碰撞风险
```

> 映射关系存 App Host 主库 `app_registry` 表中（schema_name ↔ app_id UUID），不需要从 Schema 名反推。

#### 数据库架构

```
PG 实例: org_{orgShortId}  ← 每个 Org 独立（Org ID 同理取前12位）

org_{orgShortId} 数据库内部:
  ├── Schema: _host      ← 托管服务元数据（不可被 App 访问）
  │   ├── app_registry    (app_id UUID, schema_name, name, status)
  │   ├── app_users       (用户认证表，所有 App 共享)
  │   └── app_audit_log   (审计日志)
  │
  ├── Schema: app_550e8400e29b  ← App A 的数据
  │   ├── schedules       (schedule表)
  │   ├── resources       (媒体资源)
  │   └── ...（App 自定义表）
  │
  ├── Schema: app_3f8a1c07d4b2  ← App B 的数据
  │   ├── customers       (客户表)
  │   ├── proposals       (方案表)
  │   └── ...
  │
  └── Schema: app_...           ...
```

#### PG 连接与权限

```sql
-- 为每个 App 创建专用 PG 角色
CREATE ROLE app_{appId}_role WITH LOGIN PASSWORD '{随机密码}';

-- 只允许访问自己的 Schema
GRANT USAGE ON SCHEMA app_{appId} TO app_{appId}_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app_{appId} TO app_{appId}_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app_{appId} TO app_{appId}_role;

-- 禁止访问其他 Schema
REVOKE USAGE ON SCHEMA app_{otherAppId} FROM app_{appId}_role;
REVOKE USAGE ON SCHEMA _host FROM app_{appId}_role;

-- _host Schema 中的 app_users 表需要受限访问
GRANT SELECT ON _host.app_users TO app_{appId}_role
  WITH CHECK (app_id = '{appId}');  -- 行级安全策略
```

#### Org PG 实例的生命周期

```
新 Org 注册
  → 创建 PG 实例（Docker 或 RDS）
  → 创建 org_{orgId} 数据库
  → 创建 _host Schema
  → 记录连接信息到 App Host Service 的主库

Org 下新建 App
  → 在 Org PG 中创建 app_{appId} Schema
  → 创建 app_{appId}_role 并授权
  → 将连接信息（host/port/db/role/password）注入到 App 的 Backend 容器环境变量

Org 注销
  → 停止所有 App 容器
  → 删除 PG 实例
  → 删除 S3 桶
```

#### 存量 Org 的 PG 怎么办？

```
当前状态：所有 App 的 JSONB 数据在 Super Agent 主库的 app_data 表

迁移策略：
  Phase 1 — 新 Org 直接用新架构
  Phase 2 — 存量 Org 迁移：
    1. 创建 Org PG 实例
    2. 将 app_data 中该 Org 的数据按 collection 拆分到各 App Schema
    3. 创建 PG 角色、注入连接信息
    4. 切流量
    5. 清理主库中的旧数据
```

### 3.5 S3 隔离方案

#### 原则

- **一个 Org 一个 S3 桶**
- **一个 App 一个 prefix**
- App 只能操作自己 prefix 下的对象

#### 桶策略

```
Bucket: org-{orgId}

Prefix 结构:
  /{appId}/
    /frontend/       ← 前端构建产物（HTML/JS/CSS）
    /uploads/        ← 用户上传的文件
    /exports/        ← App 导出的文件（报告、图片等）
    /temp/           ← 临时文件（TTL 自动清理）
```

#### IAM Policy（Per-App）

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListObject"],
      "Resource": [
        "arn:aws:s3:::org-{orgId}/{appId}/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::org-{orgId}"],
      "Condition": {
        "StringLike": {
          "s3:prefix": ["{appId}/*"]
        }
      }
    }
  ]
}
```

#### 文件操作流程

```
App 用户上传文件:
  1. Frontend → Backend: POST /api/files/upload?appId=xxx
  2. Backend 用 App 的 IAM Role 上传到 S3: org-{orgId}/{appId}/uploads/{filename}
  3. 返回签名 URL 给 Frontend
  4. IAM 保证即使 Backend 有 bug，也只能写到自己的 prefix

App 前端资源分发:
  1. App Builder 构建完成后，产物上传到 S3: org-{orgId}/{appId}/frontend/
  2. Frontend 容器启动时从 S3 拉取前端资源
  3. 或者配置 CDN (CloudFront/OSS CDN) 直接回源 S3
```

### 3.6 标识符体系

一个 App 有两种 ID，使用场景不同：

| 标识符 | 格式 | 长度 | 用在哪 |
|--------|------|------|--------|
| **Full UUID** | `550e8400-e29b-41d4-a716-446655440000` | 36字符 | 业务主键、数据库查询、S3 prefix、API参数、与 Super Agent 对齐 |
| **Short ID** | `550e8400e29b` | 12字符 | PG Schema 名、容器名、K8s资源名、DNS标签、Traefik路由 |

```
Full UUID 生成: Super Agent 创建 App 时生成（published_apps.id）
Short ID 生成: Full UUID 去连字符取前12位 hex
映射关系:      App Host 主库 app_registry 表维护
```

**各组件使用的标识符**：

| 组件 | 用 Short ID | 用 Full UUID |
|------|------------|-------------|
| PG Schema 名 | `app_550e8400e29b` | |
| PG Role 名 | `app_550e8400e29b_role` | |
| Docker 容器名 | `app-550e8400e29b-frontend` | |
| Traefik 路由 | `Host(550e8400e29b.app...)` | |
| S3 prefix | | `550e8400-e29b-...-446655440000/` |
| DATABASE_URL | | 查询时用 full UUID 过滤 |
| APP_ID 环境变量 | | 完整 UUID |
| Agent Bridge 调用 | | 传完整 appId 给 Super Agent |

### 3.7 URL 格式与路由

#### URL 格式

```
https://{shortId}.app.{platformDomain}

Phase 1（平台统一定域名）:
  https://550e8400e29b.app.mysuperagent.com  ← Tenant ASchedule Manager
  https://3f8a1c07d4b2.app.mysuperagent.com  ← Tenant ACreative Studio
  https://4d5e6f7a8b9c.app.mysuperagent.com  ← Tenant BCRM

Phase 3（支持租户自带域名）:
  https://ads.alpha.com  ← CNAME → 550e8400e29b.app.mysuperagent.com
```

#### Traefik 路由绑定

App 容器启动时通过 Docker labels 声明路由，Traefik 自动发现：

```yaml
# Frontend 容器的 labels
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.app-550e8400e29b.rule=Host(`550e8400e29b.app.mysuperagent.com`)"
  - "traefik.http.routers.app-550e8400e29b.entrypoints=websecure"
  - "traefik.http.routers.app-550e8400e29b.tls=true"
  - "traefik.http.routers.app-550e8400e29b.tls.certresolver=letsencrypt"
  - "traefik.http.services.app-550e8400e29b.loadbalancer.server.port=80"
```

#### 完整请求链路

```
用户访问 https://550e8400e29b.app.mysuperagent.com
  → DNS: *.app.mysuperagent.com A 记录 → Traefik 服务器
  → TLS: 通配符证书 *.app.mysuperagent.com
  → Traefik: Host 匹配 → 路由到 app-550e8400e29b-frontend 容器
  → Frontend (Nginx):
      /         → 静态文件
      /api/*    → proxy_pass 到 app-550e8400e29b-backend 容器
  → Backend:
      /api/data/*  → 查 org PG 的 app_550e8400e29b schema
      /api/files/* → 操作 s3://org-{orgShortId}/{fullUUID}/uploads/
      /api/agent/* → 代理到 Super Agent Agent Bridge
```

### 3.8 TLS 证书策略

#### Phase 1 — 平台统一定域名 + 单张通配符证书

```
平台持有: mysuperagent.com 的 DNS 控制权

证书: *.app.mysuperagent.com    ← 一张通配符证书覆盖所有租户所有 App
验证方式: Let's Encrypt DNS-01（alidns/cloudflare provider）
自动续期: Traefik 内置 ACME 自动续期
租户操作: 无，零配置即可访问
```

**一张证书覆盖全部**：
```
*.app.mysuperagent.com
  ├── 550e8400e29b.app.mysuperagent.com  (Tenant A-schedule)   ✅
  ├── 3f8a1c07d4b2.app.mysuperagent.com  (Tenant A-创意)   ✅
  ├── 4d5e6f7a8b9c.app.mysuperagent.com  (Tenant B-客户) ✅
  └── 任何新App                           ✅
```

#### Phase 3 — 支持租户自带域名

```
租户想用: ads.alpha.com

步骤:
  1. 租户加 DNS: CNAME ads.alpha.com → 550e8400e29b.app.mysuperagent.com
  2. 租户加 DNS: TXT _acme-challenge.ads.alpha.com → (Let's Encrypt 验证值)
  3. Traefik 自动申请 ads.alpha.com 证书
  4. App 容器增加一条 label:
     "traefik.http.routers.app-550e8400e29b-custom.rule=Host(`ads.alpha.com`)"

每个自定义域名一张独立证书，Let's Encrypt DNS-01 自动续期。
```

---

## 四、App 与 Super Agent 的集成

### 4.1 Agent Bridge — 连接两个服务

App 不直接调用 Super Agent 的 Agent API，而是通过 App Host Service 的 **Agent Bridge** 代理。

```
┌── App Backend Container ──┐
│                           │
│  POST /api/agent/chat     │
│  Body: {                  │
│    agentId: "xxx",        │
│    message: "...",        │
│    context: { ... }       │  ← App 自动注入当前页面上下文
│  }                        │
└────────────┬──────────────┘
             │
             ▼
┌── Agent Bridge ───────────┐
│  1. 验证 App 身份          │
│     (appId + orgId)       │
│  2. 验证 Agent 访问权限    │
│     (该 App 是否绑定了     │
│      这个 Agent)          │
│  3. 注入平台级上下文        │
│     (orgId, scopeId)      │
│  4. 调用 Super Agent API  │
│  5. 流式返回给 App         │
└────────────┬──────────────┘
             │
             ▼
┌── Super Agent ────────────┐
│  POST /api/chat           │
│  (内部服务间调用，mTLS)    │
│  Agent 执行 → 返回结果    │
└───────────────────────────┘
```

### 4.2 认证模型（双JWT）

```
JWT 1 — App 用户 Token（App Host Service 签发）
  ├── sub: app_user_id
  ├── app_id: xxx
  ├── org_id: xxx
  ├── role: viewer | editor | owner
  └── 用于：App 内的 Data API、文件操作

JWT 2 — 平台服务 Token（Super Agent 签发）
  ├── sub: app_host_service
  ├── org_id: xxx
  ├── scope: "app_agent_access"
  └── 用于：Agent Bridge 调用 Super Agent API

流程：
  App 用户 → JWT 1（App Host 签发）→ App Backend
  App Backend → Agent Bridge 用 JWT 1 验证用户身份
  Agent Bridge → 换取 JWT 2（平台 Token）→ 调用 Super Agent
```

### 4.3 Agent 能力白名单

App 不能调用任意 Agent，只能调用管理员绑定的 Agent。

```sql
-- App Host 主库中（不在 Org PG 中）
app_agent_bindings (
  app_id,
  agent_id,           -- Super Agent 中的 Agent ID
  capabilities,       -- 允许的能力：['chat', 'workflow', 'knowledge_search']
  rate_limit,         -- 每分钟调用上限
  created_by,
  created_at
)
```

---

## 五、App Builder 改造

### 5.1 构建流水线变更

```
当前流程（改造前）:
  App Builder 编辑 → 保存到本地 workspace → 同一进程 serve 静态文件

新流程（改造后）:
  App Builder 编辑 → 构建 → 打包产物上传 S3 → 通知 App Host Service → 拉起/更新容器
```

详细步骤：

```
1. 用户在 App Builder 中点击"发布"
2. Super Agent 后端：
   a. 构建 App（npm build）
   b. 生成 Backend 容器配置（根据 App 的数据模型、API 定义）
   c. 将 Frontend 产物上传到: s3://org-{orgId}/{appId}/frontend/
   d. 将 Backend 配置打包为 Docker 镜像（或用通用 runtime + 配置注入）
   e. 调用 App Host Service API: POST /api/apps/{appId}/deploy
3. App Host Service：
   a. 确保 Org PG 中存在 app_{appId} Schema
   b. 执行 Schema 迁移（建表）
   c. 拉起/更新 Frontend + Backend 容器
   d. 配置 Ingress 路由
   e. 返回访问 URL
```

### 5.2 Backend Runtime 设计

不推荐每个 App 都构建独立 Docker 镜像，而是使用**通用 Runtime + 配置注入**。

```
通用 Backend Runtime 容器
├── 基础镜像: node:20-alpine
├── 内置模块:
│   ├── Data API Engine      -- 根据 Schema 定义自动生成 CRUD API
│   ├── Auth Module          -- App 终端用户注册/登录/RBAC
│   ├── File Module          -- S3 上传/下载/签名 URL
│   ├── Agent Proxy          -- 代理到 Super Agent
│   ├── Hook Engine          -- 数据变化事件钩子
│   └── Cron Scheduler       -- App 级定时任务
│
├── 配置注入（环境变量 / 挂载配置文件）:
│   ├── APP_ID               -- 完整 UUID（业务主键）
│   ├── APP_SHORT_ID         -- 12位hex（PG schema名: app_{shortId}）
│   ├── ORG_ID               -- 完整组织 UUID
│   ├── ORG_SHORT_ID         -- 组织短ID（PG数据库名: org_{orgShortId}）
│   ├── DATABASE_URL         -- 指向 Org PG，角色限制在 app_{shortId} schema
│   ├── S3_BUCKET            -- org-{orgShortId}
│   ├── S3_PREFIX            -- {fullUUID}/  （完整UUID作为prefix）
│   ├── AGENT_BRIDGE_URL     -- Agent Bridge 的内部地址
│   ├── AGENT_BRIDGE_TOKEN   -- 服务间认证密钥
│   └── SCHEMA_DEF           -- App 的数据模型定义（JSON，挂载为文件）
│
└── 启动时：
    1. 读取 SCHEMA_DEF
    2. 连接 PG，确保表存在（自动迁移）
    3. 根据 Schema 定义注册 Data API 路由
    4. 启动 HTTP 服务
```

**优势**：
- 所有 App 共用一个 Runtime 镜像，只是配置不同
- 不需要为每个 App 构建镜像
- 更新 Runtime 版本时所有 App 统一升级

**支持自定义逻辑**（模式 B）：

```
当 App 需要自定义后端逻辑时:
  1. App Builder 中定义 "Serverless Functions"（Deno/Node）
  2. 函数代码打包为 JS 文件，挂载到 Backend Runtime
  3. Runtime 启动时加载自定义函数，注册为额外路由
  4. 自定义函数可以访问 Data API Engine 的全部能力
```

---

## 六、部署架构

### 6.1 容器编排决策：Docker 起步，抽象预留 K8s

**决策**：Phase 1 用 Docker（Docker API 动态管理容器），规模上来后切 K8s。

关键设计：容器管理层通过抽象接口隔离，上层业务代码不感知底层编排器。

```typescript
// 容器编排抽象接口
interface ContainerOrchestrator {
  deployApp(appId: string, config: AppDeployConfig): Promise<DeployResult>
  updateApp(appId: string, config: AppDeployConfig): Promise<void>
  stopApp(appId: string): Promise<void>
  removeApp(appId: string): Promise<void>
  getAppStatus(appId: string): Promise<AppStatus>
  scaleApp(appId: string, replicas: number): Promise<void>
}

// Phase 1 实现
class DockerOrchestrator implements ContainerOrchestrator { /* Docker API */ }

// Phase 3 实现（替换即可）
class KubernetesOrchestrator implements ContainerOrchestrator { /* K8s API */ }
```

**为什么 Docker 起步**：
- Tenant A初期 6 个 App、~20 个容器，Docker 绰绰有余
- 运维复杂度低，不需要专职 K8s 运维
- Docker API 动态创建/销毁容器足够可靠
- 精力放在业务场景上比折腾 K8s 更有价值

**什么时候切 K8s**：
- App 数超过 20-50 个
- 需要多机部署
- 需要自动扩缩容
- 接入更多大客户

### 6.2 Docker Compose 部署（Phase 1）

```yaml
# docker-compose.app-host.yml

services:
  # === 管控面 ===
  app-host-api:
    build: ./app-host-service
    environment:
      - DATABASE_URL=postgres://apphost:pwd@app-host-pg:5432/app_host_meta
      - AGENT_PLATFORM_URL=http://super-agent-api:3000
      - S3_ENDPOINT=http://localstack:4566
      - ORCHESTRATOR=docker  # 指定编排器实现
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # 管理 App 容器
    depends_on:
      - app-host-pg

  app-host-pg:
    image: postgres:15
    environment:
      POSTGRES_DB: app_host_meta
    volumes:
      - app-host-pg-data:/var/lib/postgresql/data

  # === Ingress（Traefik，热发现）===
  traefik:
    image: traefik:v3.0
    command:
      - "--providers.docker=true"           # 从 Docker labels 自动发现路由
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.email=admin@mysuperagent.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=alidns"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - letsencrypt-data:/letsencrypt

  # === Org PG 实例由 app-host-api 通过 Docker API 动态创建 ===
  # 不在 compose 中静态定义

volumes:
  app-host-pg-data:
  letsencrypt-data:
```

### 6.3 资源估算（Tenant A场景）

假设Tenant A初期部署 6 个 App：

| 资源 | 规格 | 数量 | 预估成本/月 |
|------|------|------|-----------|
| App Host API（管控面） | 1核2G | 1 | — |
| Org PG（Tenant A专属） | 2核4G + 50GB SSD | 1 | — |
| S3 桶（Tenant A专属） | 按用量 | 1 | 低 |
| App Frontend 容器 | 0.1核64M | 6 | 极低 |
| App Backend 容器 | 0.5核256M | 6 | 低 |
| Ingress | 共享 | 1 | — |
| **合计容器** | | ~19个 | 约 500-1000 元/月（国内云） |

对比 Super Agent 本体（Agent/Workflow/RAG）独立部署，资源完全隔离。

---

## 七、与 Super Agent 的边界

```
Super Agent 负责（不改变）:
  ✅ Agent 管理（创建、配置、对话）
  ✅ 数字人管理
  ✅ 工作流引擎（DAG 编排、执行）
  ✅ Skills 管理
  ✅ RAG 知识库（文档上传、向量化、检索）
  ✅ MCP Server 管理
  ✅ IM Channel 集成
  ✅ Cron 定时任务
  ✅ 用户/组织管理
  ✅ App Builder 编辑器（前端设计态）

App Host Service 负责（新增）:
  ✅ App 容器生命周期管理
  ✅ App 终端用户认证
  ✅ App 数据存储（Per-Org PG）
  ✅ App 文件存储（Per-Org S3）
  ✅ App Ingress 路由
  ✅ Agent Bridge（代理到 Super Agent）
  ✅ App 监控和日志
  ✅ App 级备份恢复

交互方式:
  Super Agent ──publish──→ App Host Service API ──→ 拉起容器
  App Container ──agent request──→ Agent Bridge ──→ Super Agent API
```

---

## 八、实施步骤

| 阶段 | 时间 | 交付物 |
|------|------|--------|
| **Phase 1 — 最小可用（Docker）** | 4-6周 | |
| 1.1 | W1-W2 | App Host Service 核心框架：API + DockerOrchestrator + Traefik Ingress |
| 1.2 | W2-W3 | Per-Org PG 自动化：Docker 创建 PG 容器 / Schema / 角色 |
| 1.3 | W3-W4 | 通用 Backend Runtime：Data API + Auth + S3 |
| 1.4 | W4-W5 | Agent Bridge：App → Super Agent 代理 |
| 1.5 | W5-W6 | Super Agent App Builder 对接：发布改为调 App Host API |
| **Phase 2 — 可生产** | 4-6周 | |
| 2.1 | W7-W8 | Schema Builder UI（可视化数据建模） |
| 2.2 | W8-W10 | 事件钩子 + App 级 Cron |
| 2.3 | W10-W11 | 监控告警 + 日志聚合 |
| 2.4 | W11-W12 | 备份恢复 + 数据迁移工具 |
| **Phase 3 — 规模化（K8s迁移）** | 按需 | |
| 3.1 | — | 实现 KubernetesOrchestrator（替换 DockerOrchestrator） |
| 3.2 | — | 自动扩缩容（HPA） |
| 3.3 | — | 租户自带域名支持 |
| 3.4 | — | Deno Functions 自定义逻辑 |
| 3.5 | — | 多区域部署 |
