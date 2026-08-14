# App Backend 数据层设计：InsForge 开源自托管方案

> Super Agent Platform — App Marketplace 后端数据能力演进
> 版本: 1.0.0 | 日期: 2026-05-06

---

## 1. 设计背景与问题陈述

### 1.1 现状

App Marketplace 中的 app 目前是纯前端静态 bundle（HTML/CSS/JS），通过 `app_data` 表提供了一个基于 JSONB 的轻量数据存储 API。但这个方案存在根本性局限：

- **无隔离**：所有 app 共享同一个 PostgreSQL 实例的同一张表
- **无独立认证**：app 没有自己的用户体系，只能继承平台 org 级别的 auth
- **无实时能力**：只有 REST 轮询，无 WebSocket/Realtime
- **无文件存储**：app 无法上传和管理文件
- **无 Serverless 逻辑**：app 无法运行后端代码
- **无 Agent 原生访问**：Scope Agent / Digital Twin 无法结构化地读写 app 数据

### 1.2 目标

让每个 published app 能够拥有**独立的、安全的、可被 Agent 访问的后端实例**，支撑真实业务数据的承载。

### 1.3 核心公式

```
App Backend = InsForge Project (PostgreSQL + Auth + Storage + Functions + Realtime + MCP)
```

---

## 2. 技术选型：为什么是 InsForge 开源版

### 2.1 选型对比

| 维度 | InsForge (自托管) | Supabase (自托管) | 自建 per-app schema |
|------|------------------|-------------------|-------------------|
| Agent 原生支持 | ✅ MCP Server 内置 | ❌ 需额外开发 | ❌ 完全自建 |
| 多 project 隔离 | ✅ 原生 Docker 隔离 | ⚠️ 容器更重 (~10+) | ⚠️ 只有 schema 级别 |
| 全功能 BaaS | ✅ DB+Auth+Storage+Functions+Realtime | ✅ 同等能力 | ❌ 逐个自建 |
| 容器开销 | ~5-6 容器/project | ~10+ 容器/project | 0（共享） |
| 开源协议 | Apache 2.0 | Apache 2.0 | N/A |
| 学习曲线 | 低（为 agent 设计） | 中 | 高 |
| 社区成熟度 | 较新 (2025) | 成熟 (2020+) | N/A |

### 2.2 选择 InsForge 的决定性因素

1. **MCP Server 内置**：每个 project 自带 MCP endpoint，Scope Agent 和 Digital Twin 可以直接通过 MCP 协议操作数据库、存储、认证，无需额外开发适配层
2. **为 Agent 设计的语义层**：schema、权限、日志都以结构化方式暴露给 agent，agent 能自主理解和操作
3. **轻量多 project**：Docker Compose 原生支持多实例，端口隔离，资源可控
4. **完全数据主权**：所有数据在我们自己的基础设施上，满足企业合规要求

---

## 3. 架构总览


### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Super Agent Platform                                                    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Frontend                                                        │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐     │    │
│  │  │ App Builder  │  │ Marketplace  │  │ App Runtime (iframe)│     │    │
│  │  │ (创建 app)   │  │ (浏览/安装)  │  │ (运行 app)         │     │    │
│  │  └──────────────┘  └──────────────┘  └───────────────────┘     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Backend (Fastify)                                               │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  InsForge Orchestrator Service (新增)                     │   │    │
│  │  │  - Project 生命周期管理 (create/pause/restore/destroy)    │   │    │
│  │  │  - 端口分配与注册                                         │   │    │
│  │  │  - 健康检查与自动恢复                                     │   │    │
│  │  │  - Agent MCP 连接管理                                     │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  现有 App Routes + App Data Routes (保留，作为轻量选项)   │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  InsForge Project Pool (Docker Host / ECS)                       │    │
│  │                                                                  │    │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │    │
│  │  │ Project-001   │  │ Project-002   │  │ Project-003   │       │    │
│  │  │ ┌───────────┐ │  │ ┌───────────┐ │  │ ┌───────────┐ │       │    │
│  │  │ │PostgreSQL │ │  │ │PostgreSQL │ │  │ │PostgreSQL │ │       │    │
│  │  │ │Auth       │ │  │ │Auth       │ │  │ │Auth       │ │       │    │
│  │  │ │Storage    │ │  │ │Storage    │ │  │ │Storage    │ │       │    │
│  │  │ │Functions  │ │  │ │Functions  │ │  │ │Functions  │ │       │    │
│  │  │ │MCP Server │ │  │ │MCP Server │ │  │ │MCP Server │ │       │    │
│  │  │ └───────────┘ │  │ └───────────┘ │  │ └───────────┘ │       │    │
│  │  └───────────────┘  └───────────────┘  └───────────────┘       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                    ↑                                     │
│  ┌─────────────────────────────────┼───────────────────────────────┐    │
│  │  Agent Layer                    │                                │    │
│  │                                 │                                │    │
│  │  Scope Agent ─────── MCP ───────┤                                │    │
│  │  Digital Twin Agent ─ MCP ───────┤                                │    │
│  │  App Builder Agent ── MCP ───────┘                                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 InsForge Project 内部组件

每个 InsForge project 是一个 Docker Compose stack，包含：

| 组件 | 技术 | 端口 (相对) | 职责 |
|------|------|------------|------|
| App Server | Node.js/Express | :7130 | 主入口、API 路由、MCP Server |
| PostgreSQL | PostgreSQL 15+ | :5432 | 关系数据库 |
| PostgREST | PostgREST | :5440 | 自动生成 REST API |
| Auth | 自研 JWT | :7131 | 用户认证、会话管理 |
| Storage | S3 兼容 | - | 文件存储 |
| Deno Runtime | Deno | :7133 | Serverless Functions |
| Realtime | WebSocket | - | 实时数据推送 |

---

## 4. 数据模型设计


### 4.1 新增 Prisma Model

```prisma
// ============================================================================
// App Backend Instances — InsForge Project 映射
// ============================================================================
model app_backend_instances {
  id                String   @id @default(uuid()) @db.Uuid
  app_id            String   @db.Uuid
  org_id            String   @db.Uuid
  
  // InsForge Project 信息
  project_name      String                          // docker compose project name
  provider          String   @default("insforge")   // "insforge" | "builtin" | "custom"
  status            String   @default("provisioning") // provisioning | active | paused | error | destroyed
  
  // 网络配置
  host              String   @default("localhost")  // InsForge 实例的 host
  port_postgres     Int                             // PostgreSQL 端口
  port_app          Int                             // App Server 端口 (主入口)
  port_auth         Int                             // Auth 服务端口
  port_deno         Int                             // Deno Functions 端口
  port_postgrest    Int                             // PostgREST 端口
  
  // 访问凭证 (加密存储)
  api_key           String                          // InsForge project API key
  db_connection_url String?                         // 直连 PostgreSQL 的 URL (加密)
  
  // 资源配额
  instance_type     String   @default("nano")       // nano|micro|small|medium|large
  storage_used_mb   Float    @default(0)
  storage_limit_mb  Float    @default(500)
  db_size_mb        Float    @default(0)
  db_limit_mb       Float    @default(500)
  
  // MCP 连接信息
  mcp_endpoint      String?                         // MCP Server URL for agents
  
  // 生命周期
  last_active_at    DateTime?  @db.Timestamptz
  paused_at         DateTime?  @db.Timestamptz
  error_message     String?
  
  created_at        DateTime @default(now()) @db.Timestamptz
  updated_at        DateTime @default(now()) @updatedAt @db.Timestamptz

  // Relations
  app               published_apps @relation(fields: [app_id], references: [id], onDelete: Cascade)
  organization      organizations  @relation(fields: [org_id], references: [id], onDelete: Cascade)

  @@unique([app_id])
  @@index([org_id])
  @@index([status])
  @@index([last_active_at])
}
```

### 4.2 published_apps 表扩展

```prisma
// 在 published_apps model 中新增字段
model published_apps {
  // ... 现有字段 ...
  
  // 新增：后端类型标识
  backend_type      String   @default("builtin")    // "builtin" | "insforge" | "custom"
  backend_instance  app_backend_instances?           // 关联的 InsForge 实例
}
```

---

## 5. InsForge Orchestrator Service 设计


### 5.1 核心接口

```typescript
// backend/src/services/insforge-orchestrator.ts

export interface InsForgeProjectConfig {
  projectName: string
  instanceType: 'nano' | 'micro' | 'small' | 'medium' | 'large'
  region?: string  // 预留，当前默认 local
}

export interface InsForgeProjectInfo {
  id: string
  appId: string
  projectName: string
  status: 'provisioning' | 'active' | 'paused' | 'error' | 'destroyed'
  accessHost: string       // http://{host}:{port_app}
  apiKey: string
  mcpEndpoint: string      // MCP Server URL
  ports: {
    postgres: number
    app: number
    auth: number
    deno: number
    postgrest: number
  }
}

export interface InsForgeOrchestrator {
  /**
   * 为一个 app 创建新的 InsForge project
   * 1. 分配端口
   * 2. 生成 .env 文件
   * 3. 启动 Docker Compose stack
   * 4. 等待健康检查通过
   * 5. 记录到数据库
   */
  provisionProject(appId: string, orgId: string, config: InsForgeProjectConfig): Promise<InsForgeProjectInfo>

  /**
   * 暂停不活跃的 project（停止容器，保留数据卷）
   * 触发条件：超过 N 天无访问
   */
  pauseProject(projectId: string): Promise<void>

  /**
   * 恢复已暂停的 project
   * 重新启动容器，挂载原有数据卷
   */
  restoreProject(projectId: string): Promise<InsForgeProjectInfo>

  /**
   * 彻底销毁 project（删除容器 + 数据卷）
   * 需要二次确认，不可逆
   */
  destroyProject(projectId: string): Promise<void>

  /**
   * 获取 project 的 MCP 连接配置（给 Agent 使用）
   */
  getAgentMcpConfig(projectId: string): Promise<McpServerConfig>

  /**
   * 健康检查
   */
  healthCheck(projectId: string): Promise<HealthStatus>

  /**
   * 获取 project 资源使用情况
   */
  getUsage(projectId: string): Promise<UsageMetrics>
}
```

### 5.2 端口分配策略

```typescript
/**
 * 端口分配器
 * 
 * 策略：从 BASE_PORT 开始，每个 project 占用 PORTS_PER_PROJECT 个连续端口
 * 已释放的端口段可以被回收复用
 */
const INSFORGE_BASE_PORT = 10000
const PORTS_PER_PROJECT = 10  // 留余量给未来扩展

interface PortAllocation {
  postgres: number    // base + 0
  postgrest: number   // base + 1
  app: number         // base + 2
  auth: number        // base + 3
  deno: number        // base + 4
  // base + 5~9 预留
}

function allocatePorts(slotIndex: number): PortAllocation {
  const base = INSFORGE_BASE_PORT + (slotIndex * PORTS_PER_PROJECT)
  return {
    postgres: base,
    postgrest: base + 1,
    app: base + 2,
    auth: base + 3,
    deno: base + 4,
  }
}
```

### 5.3 Project 生命周期状态机

```
                    ┌──────────────┐
                    │              │
         create     │ provisioning │
        ─────────► │              │
                    └──────┬───────┘
                           │ health check pass
                           ▼
                    ┌──────────────┐
              ┌────│              │◄────┐
   restore    │    │    active    │     │  auto-restore
   ─────────► │    │              │     │  (on access)
              │    └──────┬───────┘     │
              │           │             │
              │           │ idle > N days
              │           ▼             │
              │    ┌──────────────┐     │
              └────│              │─────┘
                   │    paused    │
                   │              │
                   └──────┬───────┘
                          │ explicit destroy
                          ▼
                   ┌──────────────┐
                   │              │
                   │  destroyed   │
                   │              │
                   └──────────────┘

  任何状态 ──── error ────► ┌───────┐
                            │ error │ (可 retry → provisioning)
                            └───────┘
```

### 5.4 Docker Compose 模板管理

```
super-agent-impl/
├── insforge/                          # 新增目录
│   ├── docker-compose.template.yml    # InsForge 基础模板
│   ├── .env.template                  # 环境变量模板
│   ├── projects/                      # 运行时生成的 project 配置
│   │   ├── proj-001/
│   │   │   ├── docker-compose.yml
│   │   │   ├── .env
│   │   │   └── data/                  # 数据卷挂载点
│   │   ├── proj-002/
│   │   └── ...
│   └── scripts/
│       ├── provision.sh               # 创建 project 脚本
│       ├── pause.sh                   # 暂停脚本
│       ├── restore.sh                 # 恢复脚本
│       └── health-check.sh            # 健康检查脚本
```

---

## 6. App Publish 流程改造


### 6.1 用户流程

```
┌─────────────────────────────────────────────────────────────────┐
│  App Builder 完成构建                                            │
│                                                                  │
│  用户点击 "Publish"                                              │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Step 1: 基本信息 (现有)                                 │    │
│  │  - App 名称、描述、图标、分类                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Step 2: 后端配置 (新增)                                 │    │
│  │                                                          │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │  选择后端类型:                                    │    │    │
│  │  │                                                  │    │    │
│  │  │  ○ 无后端 (纯前端 app)                           │    │    │
│  │  │                                                  │    │    │
│  │  │  ○ 内置轻量存储 (现有 app_data)                  │    │    │
│  │  │    适合简单的 key-value 存储需求                   │    │    │
│  │  │    免费，无需额外配置                              │    │    │
│  │  │                                                  │    │    │
│  │  │  ● InsForge 全功能后端 (推荐)                    │    │    │
│  │  │    独立 PostgreSQL + Auth + Storage + Functions   │    │    │
│  │  │    支持 Agent 通过 MCP 直接访问                   │    │    │
│  │  │    实例规格: [nano ▼]                             │    │    │
│  │  │                                                  │    │    │
│  │  │  ○ 自定义 API (BYO)                             │    │    │
│  │  │    连接已有的外部后端服务                          │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Step 3: 发布 (现有 + 增强)                              │    │
│  │  - 如果选了 InsForge → 先 provision project              │    │
│  │  - 将 InsForge SDK config 注入到 app bundle              │    │
│  │  - 发布 app                                              │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 后端 API 变更

```typescript
// POST /api/apps/publish-from-workspace (增强)
interface PublishRequest {
  session_id: string
  folder_path: string
  name: string
  status: 'preview' | 'published'
  
  // 新增字段
  backend_type?: 'none' | 'builtin' | 'insforge' | 'custom'
  backend_config?: {
    instance_type?: 'nano' | 'micro' | 'small' | 'medium' | 'large'
    // custom 类型时需要
    custom_api_url?: string
    custom_api_key?: string
  }
}

// 响应增强
interface PublishResponse {
  id: string
  name: string
  version: string
  access_url: string
  
  // 新增
  backend?: {
    type: 'builtin' | 'insforge' | 'custom'
    status: 'active' | 'provisioning'
    access_host?: string   // InsForge project URL
    api_key?: string       // InsForge API key (前端 SDK 用)
    mcp_endpoint?: string  // Agent MCP 连接点
  }
}
```

### 6.3 App Runtime SDK 注入

当 app 选择 InsForge 后端时，publish 流程会自动在 app 的 HTML 中注入配置：

```html
<!-- 自动注入到 app 的 index.html -->
<script>
  window.__SUPER_AGENT_APP_CONFIG__ = {
    appId: "uuid-of-app",
    backend: {
      type: "insforge",
      host: "http://localhost:10002",  // InsForge App Server
      apiKey: "project-api-key",
      authHost: "http://localhost:10003",
    }
  };
</script>
<script src="/api/apps/sdk/insforge-client.js"></script>
```

SDK 提供的能力：

```typescript
// insforge-client.js — 自动注入的轻量 SDK
const AppBackend = {
  // 数据库操作 (通过 PostgREST)
  db: {
    from(table: string): QueryBuilder,
    rpc(functionName: string, params: object): Promise<any>,
  },
  
  // 认证
  auth: {
    signUp(email: string, password: string): Promise<User>,
    signIn(email: string, password: string): Promise<Session>,
    signOut(): Promise<void>,
    getUser(): User | null,
  },
  
  // 文件存储
  storage: {
    upload(bucket: string, path: string, file: File): Promise<string>,
    download(bucket: string, path: string): Promise<Blob>,
    list(bucket: string, prefix?: string): Promise<FileInfo[]>,
    delete(bucket: string, path: string): Promise<void>,
  },
  
  // 实时订阅
  realtime: {
    subscribe(table: string, callback: (payload: any) => void): Subscription,
    unsubscribe(subscription: Subscription): void,
  },
  
  // Serverless Functions
  functions: {
    invoke(name: string, body?: object): Promise<any>,
  },
}
```

---

## 7. Agent 数据访问层设计


### 7.1 Agent 访问模式

Scope Agent 和 Digital Twin Agent 通过 InsForge 内置的 MCP Server 访问 app 数据：

```
┌──────────────────┐         ┌──────────────────────────────────┐
│  Scope Agent     │         │  InsForge Project (CRM App)      │
│                  │  MCP    │                                   │
│  "查看本月新增   │ ──────► │  MCP Server (:7130/mcp)          │
│   客户数据"      │         │    ├── list-tables               │
│                  │         │    ├── query-database             │
│                  │         │    ├── insert-record              │
│                  │         │    ├── update-record              │
│                  │         │    ├── manage-schema              │
│                  │         │    ├── list-storage-files         │
│                  │         │    ├── invoke-function            │
│                  │         │    └── fetch-docs                 │
└──────────────────┘         └──────────────────────────────────┘
```

### 7.2 Agent MCP 配置动态生成

当 Agent 需要访问某个 app 的数据时，平台动态生成 MCP 配置：

```typescript
// backend/src/services/agent-mcp-resolver.ts

/**
 * 根据 agent 的 scope 和权限，动态生成可访问的 InsForge MCP 配置列表
 */
export async function resolveAgentMcpConfigs(
  agentId: string,
  scopeId: string,
  orgId: string
): Promise<McpServerConfig[]> {
  
  // 1. 查找该 scope 下所有有 InsForge 后端的 app
  const apps = await prisma.published_apps.findMany({
    where: {
      org_id: orgId,
      business_scope_id: scopeId,
      backend_type: 'insforge',
    },
    include: { backend_instance: true },
  })
  
  // 2. 为每个 app 生成 MCP 配置
  return apps
    .filter(app => app.backend_instance?.status === 'active')
    .map(app => ({
      name: `app-backend-${app.id}`,
      displayName: `${app.name} 数据`,
      transport: 'streamable-http',
      url: `http://${app.backend_instance!.host}:${app.backend_instance!.port_app}/mcp`,
      headers: {
        'X-API-Key': app.backend_instance!.api_key,
        'X-Agent-Id': agentId,
        'X-Org-Id': orgId,
      },
    }))
}
```

### 7.3 权限控制

```typescript
// Agent 对 app 数据的访问权限模型
interface AgentAppPermission {
  agentId: string
  appId: string
  permissions: {
    database: 'read' | 'read_write' | 'admin'
    storage: 'read' | 'read_write' | 'none'
    functions: 'invoke' | 'none'
    auth: 'read_users' | 'manage_users' | 'none'
  }
}

// 权限矩阵示例
const DEFAULT_PERMISSIONS = {
  scope_agent: {
    database: 'read_write',   // 可以读写业务数据
    storage: 'read',          // 可以读取文件
    functions: 'invoke',      // 可以调用 functions
    auth: 'read_users',       // 可以查看用户列表
  },
  digital_twin: {
    database: 'read_write',   // 代表用户操作数据
    storage: 'read_write',    // 可以上传文件
    functions: 'invoke',      // 可以触发业务逻辑
    auth: 'none',             // 不能管理用户
  },
  app_builder: {
    database: 'admin',        // 可以修改 schema
    storage: 'read_write',    // 完全文件权限
    functions: 'invoke',      // 可以部署和调用
    auth: 'manage_users',     // 可以配置认证
  },
}
```

### 7.4 典型 Agent 使用场景

**场景 1：Scope Agent 日常巡检**
```
Scope Agent (每日 9:00 触发):
  1. 通过 MCP 连接 CRM App 的 InsForge project
  2. query-database: SELECT * FROM customers WHERE created_at > yesterday
  3. query-database: SELECT status, COUNT(*) FROM orders GROUP BY status
  4. 分析数据，生成日报
  5. 如发现异常 → 通知用户
```

**场景 2：Digital Twin 自动审批**
```
Digital Twin Agent (实时监听):
  1. 订阅 Approval App 的 InsForge realtime: requests 表 INSERT 事件
  2. 收到新审批请求
  3. query-database: 获取请求详情
  4. 根据预设规则判断
  5. update-record: 更新 status = 'approved' / 'rejected'
  6. 如无法判断 → 升级给人类
```

**场景 3：App Builder Agent 初始化数据模型**
```
App Builder Agent (创建 app 时):
  1. 用户描述: "做一个客户管理系统"
  2. Agent 通过 MCP 连接新创建的 InsForge project
  3. manage-schema: CREATE TABLE customers (id, name, email, phone, ...)
  4. manage-schema: CREATE TABLE interactions (id, customer_id, type, ...)
  5. 生成前端代码，使用 InsForge SDK 连接后端
  6. 发布 app
```

---

## 8. 资源管理与成本控制


### 8.1 实例规格定义

| 规格 | CPU | 内存 | 存储 | 适用场景 |
|------|-----|------|------|---------|
| nano | 0.25 vCPU | 512MB | 500MB DB + 1GB Storage | 开发/测试、个人工具 |
| micro | 0.5 vCPU | 1GB | 1GB DB + 5GB Storage | 小型内部工具 |
| small | 1 vCPU | 2GB | 5GB DB + 10GB Storage | 团队协作 app |
| medium | 2 vCPU | 4GB | 20GB DB + 50GB Storage | 部门级业务 app |
| large | 4 vCPU | 8GB | 100GB DB + 200GB Storage | 企业核心业务 |

### 8.2 自动 Pause 策略

```typescript
// 定时任务：每小时检查一次
async function autoManageProjects() {
  const now = new Date()
  
  // 1. 超过 7 天无访问的 project → pause
  const idleProjects = await prisma.app_backend_instances.findMany({
    where: {
      status: 'active',
      last_active_at: { lt: subDays(now, 7) },
    },
  })
  
  for (const project of idleProjects) {
    await orchestrator.pauseProject(project.id)
    // 通知 app owner
    await notifyOwner(project, 'paused_due_to_inactivity')
  }
  
  // 2. 超过 30 天 paused 且无 agent 订阅的 → 提醒是否销毁
  const longPausedProjects = await prisma.app_backend_instances.findMany({
    where: {
      status: 'paused',
      paused_at: { lt: subDays(now, 30) },
    },
  })
  
  for (const project of longPausedProjects) {
    await notifyOwner(project, 'consider_destroy')
  }
}
```

### 8.3 Auto-Restore（按需唤醒）

当 app 被访问或 agent 尝试连接时，自动恢复 paused 的 project：

```typescript
// 中间件：拦截对 paused project 的访问
async function autoRestoreMiddleware(appId: string): Promise<InsForgeProjectInfo> {
  const instance = await prisma.app_backend_instances.findUnique({
    where: { app_id: appId },
  })
  
  if (!instance) throw new Error('No backend instance')
  
  if (instance.status === 'paused') {
    // 自动恢复，用户等待 ~10-30 秒
    return await orchestrator.restoreProject(instance.id)
  }
  
  if (instance.status === 'active') {
    // 更新最后活跃时间
    await prisma.app_backend_instances.update({
      where: { id: instance.id },
      data: { last_active_at: new Date() },
    })
  }
  
  return instance as InsForgeProjectInfo
}
```

### 8.4 资源使用监控

```typescript
// GET /api/apps/:appId/backend/usage
interface BackendUsageResponse {
  database: {
    size_mb: number
    limit_mb: number
    tables_count: number
    rows_count: number
  }
  storage: {
    used_mb: number
    limit_mb: number
    files_count: number
  }
  compute: {
    function_invocations_today: number
    function_invocations_month: number
  }
  network: {
    egress_mb_today: number
    egress_mb_month: number
  }
  status: 'healthy' | 'warning' | 'critical'
  warnings: string[]  // e.g. ["Database usage at 80%"]
}
```

---

## 9. 部署架构


### 9.1 单机部署（开发/小规模）

```
┌─────────────────────────────────────────────────────────┐
│  EC2 Instance (m5.2xlarge: 8C/32G)                      │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │  Super Agent Backend (主进程)                   │     │
│  │  - Fastify API Server                          │     │
│  │  - InsForge Orchestrator                       │     │
│  │  - 直接调用 docker compose CLI                  │     │
│  └────────────────────────────────────────────────┘     │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │  Docker Engine                                  │     │
│  │                                                 │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐       │     │
│  │  │Project-1 │ │Project-2 │ │Project-3 │ ...   │     │
│  │  │(5 容器)  │ │(5 容器)  │ │(5 容器)  │       │     │
│  │  └──────────┘ └──────────┘ └──────────┘       │     │
│  └────────────────────────────────────────────────┘     │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │  EBS Volumes                                    │     │
│  │  /data/insforge/proj-001/  (PostgreSQL data)    │     │
│  │  /data/insforge/proj-002/  (PostgreSQL data)    │     │
│  │  /data/insforge/storage/   (S3 compatible)      │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

容量估算（单机）：
- 8C/32G 可同时运行 ~15-20 个 nano 级别的 active project
- 加上 pause 机制，可管理 100+ 个 project（大部分 paused）

### 9.2 集群部署（中大规模）

```
┌─────────────────────────────────────────────────────────────────┐
│  ECS Cluster / K8s                                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Control Plane                                            │   │
│  │  - Super Agent Backend (多副本)                           │   │
│  │  - InsForge Orchestrator (leader election)                │   │
│  │  - 通过 ECS API / K8s API 管理 project 容器              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Worker Nodes                                             │   │
│  │                                                           │   │
│  │  Node-1 (8C/32G)        Node-2 (8C/32G)                  │   │
│  │  ┌──────┐ ┌──────┐     ┌──────┐ ┌──────┐               │   │
│  │  │Proj-1│ │Proj-2│     │Proj-3│ │Proj-4│               │   │
│  │  └──────┘ └──────┘     └──────┘ └──────┘               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Shared Services                                          │   │
│  │  - RDS (Super Agent 主数据库)                             │   │
│  │  - S3 (InsForge Storage 后端)                             │   │
│  │  - EFS (PostgreSQL 数据持久化)                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 网络架构

```
┌─────────────────────────────────────────────────────────────┐
│  VPC                                                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Public Subnet                                       │    │
│  │  - ALB (Super Agent Frontend + API)                  │    │
│  │  - NAT Gateway                                       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Private Subnet                                      │    │
│  │  - Super Agent Backend                               │    │
│  │  - InsForge Projects (所有容器)                      │    │
│  │  - 内网通信，不暴露到公网                             │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Data Subnet                                         │    │
│  │  - RDS (主数据库)                                    │    │
│  │  - EFS (InsForge 数据卷)                             │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

访问路径:
  App 前端 → ALB → Super Agent Backend → (proxy) → InsForge Project
  Agent → 内网直连 → InsForge Project MCP Server
```

---

## 10. 安全设计


### 10.1 隔离模型

```
┌─────────────────────────────────────────────────────────────┐
│  隔离层级                                                    │
│                                                              │
│  Level 1: Organization 隔离                                  │
│  - 每个 org 的 InsForge projects 互不可见                    │
│  - API 请求必须携带有效的 org-scoped token                   │
│                                                              │
│  Level 2: Project 隔离 (容器级)                              │
│  - 每个 project 是独立的 Docker network                      │
│  - 容器间通过 project-specific network 通信                  │
│  - 不同 project 的容器无法互相访问                           │
│                                                              │
│  Level 3: 数据隔离                                           │
│  - 每个 project 有独立的 PostgreSQL 实例                     │
│  - 独立的文件存储 namespace                                  │
│  - 独立的认证用户池                                          │
│                                                              │
│  Level 4: Agent 权限隔离                                     │
│  - Agent 只能访问其 scope 下的 app 后端                      │
│  - 每次 MCP 连接需要验证 agent 权限                          │
│  - 所有 agent 操作有审计日志                                 │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 凭证管理

```typescript
// 凭证存储策略
interface CredentialStorage {
  // InsForge API Key — 存储在 Super Agent 的 credential vault
  apiKey: {
    storage: 'credential_vault'  // 使用现有的 credential vault 模块
    encryption: 'AES-256-GCM'
    rotation: 'manual'           // 用户可手动轮换
  }
  
  // PostgreSQL 连接串 — 仅 Orchestrator 内部使用
  dbConnectionUrl: {
    storage: 'credential_vault'
    encryption: 'AES-256-GCM'
    access: 'orchestrator_only'  // 不暴露给前端或 agent
  }
  
  // Agent 访问 Token — 短期 JWT
  agentToken: {
    type: 'JWT'
    lifetime: '10m'              // 10 分钟有效期
    refresh: 'on_demand'         // 每次 agent 请求时重新签发
    claims: ['agent_id', 'org_id', 'app_id', 'permissions']
  }
}
```

### 10.3 审计日志

所有 Agent 对 InsForge project 的操作都记录审计日志：

```typescript
interface AgentDataAccessLog {
  id: string
  timestamp: Date
  agent_id: string
  agent_type: 'scope_agent' | 'digital_twin' | 'app_builder'
  app_id: string
  project_id: string
  operation: string        // e.g. "query-database", "insert-record"
  details: {
    table?: string
    query?: string         // 脱敏后的查询
    rows_affected?: number
    duration_ms: number
  }
  result: 'success' | 'denied' | 'error'
  denial_reason?: string
}
```

---

## 11. 实施路线图


### Phase 1: 基础设施搭建（1-2 周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| Fork InsForge 仓库，验证本地 Docker Compose 部署 | 验证报告 | P0 |
| 设计并实现端口分配器 | port-allocator.ts | P0 |
| 创建 Docker Compose 模板 + .env 模板 | insforge/templates/ | P0 |
| 实现 InsForge Orchestrator 核心（provision/destroy） | insforge-orchestrator.ts | P0 |
| 数据库 migration：app_backend_instances 表 | prisma migration | P0 |
| 健康检查 + 基础监控 | health-check service | P1 |

### Phase 2: Publish 流程集成（1-2 周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| 前端：后端选择器 UI 组件 | BackendSelector.tsx | P0 |
| 后端：publish API 增强（支持 backend_type） | apps.routes.ts 改造 | P0 |
| InsForge SDK 注入逻辑 | sdk-injector.ts | P0 |
| App Runtime 代理层（前端访问 InsForge 的 proxy） | app-proxy middleware | P0 |
| Pause/Restore 生命周期管理 | orchestrator 增强 | P1 |
| 资源使用监控 UI | BackendUsage.tsx | P1 |

### Phase 3: Agent 数据访问层（2-3 周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| Agent MCP 配置动态解析器 | agent-mcp-resolver.ts | P0 |
| Agent 权限模型实现 | agent-app-permissions | P0 |
| Scope Agent 集成测试（读写 app 数据） | 集成测试 | P0 |
| Digital Twin 实时订阅能力 | realtime-bridge | P1 |
| App Builder Agent 自动建表能力 | schema-builder integration | P1 |
| 审计日志系统 | audit-logger | P1 |

### Phase 4: 生产化加固（2-3 周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| 自动 Pause/Restore 策略 | auto-lifecycle service | P1 |
| 备份/恢复机制 | backup-manager | P1 |
| 集群部署方案（ECS/K8s） | 部署文档 + IaC | P2 |
| 资源配额告警 | quota-alerting | P2 |
| 数据迁移工具（builtin → insforge） | migration-tool | P2 |
| 性能压测 + 调优 | 压测报告 | P2 |

---

## 12. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| InsForge 开源版功能不完整 | 高 | 中 | 提前 fork 验证；必要时贡献 PR 或自行补充 |
| 单机容器数过多导致资源争抢 | 中 | 中 | 严格的 resource limits + auto-pause + 集群扩展 |
| Docker Compose 管理复杂度 | 中 | 低 | 封装为 Orchestrator service，对上层透明 |
| InsForge 版本升级兼容性 | 中 | 低 | 锁定版本；升级前在 staging 验证 |
| Agent 误操作破坏数据 | 高 | 低 | 权限控制 + 审计日志 + 定期备份 + 操作确认机制 |
| 端口冲突 | 低 | 低 | 端口分配器统一管理 + 启动前检测 |

---

## 13. 与现有系统的兼容性

### 13.1 向后兼容

- 现有的 `app_data` API 保持不变，作为 `backend_type: "builtin"` 的实现
- 已发布的 app 默认 `backend_type: "builtin"`，不受影响
- 新发布的 app 可以选择升级到 InsForge 后端

### 13.2 数据迁移路径

```
builtin (app_data) → InsForge

步骤:
1. 创建 InsForge project
2. 根据 app_data 中的 collection 结构，在 InsForge 中创建对应的表
3. 批量导入 JSONB 数据到 PostgreSQL 表
4. 更新 app 的 backend_type 为 "insforge"
5. 更新 app 前端代码，切换到 InsForge SDK
6. 验证数据完整性
7. 清理旧的 app_data 记录
```

### 13.3 与 AgentCore Gateway 的关系

```
AgentCore Gateway (现有)          InsForge MCP (新增)
├── 外部 SaaS 连接器              ├── App 内部数据访问
│   (Salesforce, Gmail...)        │   (每个 app 的 PostgreSQL)
├── 统一凭证管理                   ├── 独立认证体系
├── Cedar 策略控制                 ├── Agent 权限矩阵
└── Lambda Target                 └── 直连 MCP Server

两者互补：
- Gateway 负责连接外部世界
- InsForge MCP 负责 app 内部数据
- Agent 可以同时使用两者
```

---

## 14. 开放问题

1. **InsForge 开源版是否支持共享 PostgreSQL？** 如果支持，小规模部署可以多个 project 共享一个 PG 实例（schema 隔离），降低资源开销
2. **InsForge MCP Server 的权限粒度** 是否支持 table-level 或 column-level 的访问控制？需要验证
3. **Realtime 的 WebSocket 连接管理** 当 project 被 pause 后，已建立的 WebSocket 连接如何优雅断开？
4. **多区域部署** 如果未来需要跨区域，InsForge project 的数据同步策略是什么？
5. **计费模型** 如果平台对外提供服务，如何基于 InsForge 的资源使用量向用户收费？

---

## 15. 参考资料

- [InsForge GitHub](https://github.com/InsForge/insforge) — Apache 2.0 开源
- [InsForge 官方文档](https://docs.insforge.dev)
- [InsForge MCP Server](https://github.com/InsForge/insforge-mcp)
- [InsForge Self-Hosting Guide](https://docs.insforge.dev/platform/self-hosting)
- [InsForge Functions Architecture](https://docs.insforge.dev/core-concepts/functions/architecture)


---

## 16. 用户交互流程详解

### 16.1 场景一：App 创建者通过 App Builder 构建并发布带后端的 App

#### Phase A: Agent 构建 App（与现有流程一致）

```
用户在 Chat 中: "帮我做一个客户管理系统，要能增删改查客户信息，支持文件上传"

1. App Builder Agent 生成前端代码 (React/HTML)
2. WorkspaceActions 检测到 index.html → 显示 Preview/Publish 按钮

（这一步和现在完全一样，没有变化）
```

#### Phase B: 用户点击 "Publish" — 弹出增强版发布对话框

```
┌───────────────────────────────────────────────────────────────┐
│                                                                │
│  📦 发布应用                                                   │
│                                                                │
│  应用名称: [客户管理系统        ]                               │
│  分类:     [工具 ▼]                                            │
│  描述:     [管理客户信息的 CRM 工具...]                         │
│                                                                │
│  ─────────────────────────────────────────────────────────    │
│                                                                │
│  🗄️ 后端数据服务                                               │
│                                                                │
│  你的应用需要存储和管理数据吗？                                  │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  ○ 无后端                                                │  │
│  │    纯展示型应用，不需要存储数据                            │  │
│  │                                                          │  │
│  │  ○ 轻量存储                                              │  │
│  │    简单的 JSON 文档存储，适合配置、笔记类应用              │  │
│  │    ✓ 免费  ✓ 即时可用  ✗ 无独立用户体系                  │  │
│  │                                                          │  │
│  │  ● 全功能后端 (InsForge)                        推荐 ⭐  │  │
│  │    独立数据库 + 用户认证 + 文件存储 + 实时同步             │  │
│  │    ✓ 独立 PostgreSQL  ✓ 用户注册/登录                    │  │
│  │    ✓ 文件上传  ✓ Agent 可直接访问数据                     │  │
│  │                                                          │  │
│  │    实例规格: [nano (开发/测试) ▼]                          │  │
│  │                                                          │  │
│  │    ⚡ 预计创建时间: 30-60 秒                               │  │
│  │                                                          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│              [取消]                    [🚀 发布]               │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

#### Phase C: 后端 Provisioning（用户等待页面）

用户选择 "全功能后端" 并点击发布后，显示进度：

```
┌───────────────────────────────────────────────────────────────┐
│                                                                │
│  🔄 正在创建应用后端...                                        │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  ✅ 分配资源                                            │   │
│  │  ✅ 创建数据库                                          │   │
│  │  ✅ 配置认证服务                                        │   │
│  │  🔄 启动服务中...                                       │   │
│  │  ○ 健康检查                                             │   │
│  │  ○ 注入 SDK 配置                                        │   │
│  │  ○ 发布应用                                             │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  预计剩余时间: ~20 秒                                          │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

#### Phase D: 发布成功

```
┌───────────────────────────────────────────────────────────────┐
│                                                                │
│  ✅ 应用发布成功！                                             │
│                                                                │
│  客户管理系统 v1.0.0                                           │
│                                                                │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  后端信息                                            │     │
│  │  类型: InsForge 全功能后端                           │     │
│  │  状态: 🟢 运行中                                     │     │
│  │  数据库: PostgreSQL (0 MB / 500 MB)                  │     │
│  │  存储: 0 MB / 1 GB                                   │     │
│  │  Agent 访问: ✅ 已启用                                │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                                │
│  [打开应用]  [查看后端面板]  [返回 Marketplace]                │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

---

### 16.2 场景二：App 创建者发布后，用 Agent 配置数据模型

发布成功后，用户回到 Chat 继续对话：

```
用户: "帮我在后端创建客户表，字段包括姓名、电话、邮箱、公司、备注、创建时间"

App Builder Agent 执行:
  1. 检测到该 session 关联的 app 有 InsForge 后端
  2. 通过 MCP 连接该 app 的 InsForge project
  3. 执行 manage-schema:
     CREATE TABLE customers (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name TEXT NOT NULL,
       phone TEXT,
       email TEXT,
       company TEXT,
       notes TEXT,
       created_at TIMESTAMPTZ DEFAULT now()
     );
  4. 回复用户: "已创建 customers 表，包含以下字段..."

用户: "再加一个客户跟进记录表，关联到客户"

Agent 执行:
  1. manage-schema: CREATE TABLE follow_ups (...)
  2. 同时更新前端代码，添加跟进记录的 UI
  3. 回复: "已创建 follow_ups 表并更新了前端界面"

用户: "帮我插入一些测试数据"

Agent 执行:
  1. insert-record: 插入 5 条示例客户数据
  2. 回复: "已插入 5 条测试数据，你可以预览看看效果"
```

---

### 16.3 场景三：App 使用者从 Marketplace 安装并使用 App

#### 浏览 Marketplace

App 卡片上显示后端能力标签：`[全功能后端]` `[PostgreSQL]` `[可 Agent 访问]`

点击进入详情页：

```
┌───────────────────────────────────────────────────────────────┐
│  客户管理系统 v1.0.0                                           │
│  ⭐⭐⭐⭐☆ (4.2) · 128 次使用 · by 张三                       │
│                                                                │
│  功能:                                                         │
│  - 客户信息增删改查                                            │
│  - 跟进记录管理                                                │
│  - 文件附件上传                                                │
│                                                                │
│  后端能力: 🗄️ PostgreSQL · 🔐 用户认证 · 📁 文件存储           │
│  Agent 集成: ✅ Scope Agent 可读写数据                          │
│                                                                │
│  [▶️ 启动应用]   [🔀 Fork 一份]                                │
└───────────────────────────────────────────────────────────────┘
```

#### App 运行时

App 在 iframe 中加载，SDK 自动连接 InsForge 后端，用户无感知：

```
数据流:
  App 前端 → InsForge SDK → InsForge PostgREST API → PostgreSQL

用户操作 "新增客户":
  1. 前端表单收集数据
  2. SDK 调用: AppBackend.db.from('customers').insert({...})
  3. InsForge PostgREST 写入 PostgreSQL
  4. 如果有其他用户在线 → Realtime 推送更新
```

---

### 16.4 场景四：Scope Agent 自动巡检 App 数据

```
触发: 每日定时 / 用户手动询问 / 数据变化事件

用户: "帮我看看 CRM 里这周新增了多少客户，有没有异常"

Scope Agent 执行流程:

  1. Agent 识别到用户提到 "CRM" → 匹配到 "客户管理系统" app

  2. 平台通过 agent-mcp-resolver 动态加载该 app 的 MCP 配置:
     {
       name: "crm-app-backend",
       url: "http://localhost:10002/mcp",
       headers: { "X-API-Key": "..." }
     }

  3. Agent 通过 MCP 执行查询:
     → query-database:
       SELECT COUNT(*) as new_customers
       FROM customers
       WHERE created_at > now() - interval '7 days'

     → query-database:
       SELECT date_trunc('day', created_at) as day, COUNT(*)
       FROM customers
       WHERE created_at > now() - interval '7 days'
       GROUP BY day ORDER BY day

  4. Agent 分析结果并回复:

     "本周 CRM 新增 23 位客户，日均 3.3 位。
      周三有一个峰值（8 位），可能是市场活动带来的。
      整体趋势正常，没有发现异常。

      按公司分布:
      - ABC科技: 5 位
      - XYZ集团: 3 位
      - 其他: 15 位

      需要我生成详细报告吗？"
```

---

### 16.5 场景五：Digital Twin Agent 自动处理业务

```
前提: 用户有一个 "费用审批" app，配置了 Digital Twin 自动审批规则

触发: 有人在审批 app 中提交了一笔报销申请

Digital Twin 执行流程:

  1. InsForge Realtime 推送事件:
     { table: "expense_requests", type: "INSERT", record: {...} }

  2. Digital Twin 收到事件，通过 MCP 查询详情:
     → query-database:
       SELECT * FROM expense_requests WHERE id = 'xxx'

     结果: { amount: 350, category: "交通", submitter: "李明",
             description: "客户拜访打车费" }

  3. Agent 根据预设规则判断:
     规则: 交通类 < 500 元 → 自动批准
     判定: 350 < 500 ✅

  4. Agent 通过 MCP 更新记录:
     → update-record:
       UPDATE expense_requests
       SET status = 'approved',
           approved_by = 'digital_twin',
           approved_at = now(),
           approval_note = '符合自动审批规则: 交通类<500元'
       WHERE id = 'xxx'

  5. 审批 app 的 Realtime 推送更新 → 提交人看到 "已批准"

  6. Digital Twin 记录操作日志，通知用户:
     "已自动批准李明的报销申请 (¥350 交通费)，符合预设规则。"

  ─────────────────────────────────────────────────────────────

  异常场景: 如果金额 > 500 或类别不在规则内

  Agent 通知用户:
    "收到一笔新的报销申请需要你审批:
     提交人: 王芳
     金额: ¥2,800
     类别: 设备采购
     描述: 采购外接显示器

     超出自动审批范围，需要你手动决定。
     [批准] [拒绝] [查看详情]"
```

---

### 16.6 场景六：App 后端管理面板（App Owner 视角）

用户从 Marketplace → 我的应用 → 客户管理系统 → 后端管理：

```
┌───────────────────────────────────────────────────────────────┐
│                                                                │
│  🗄️ 后端管理 — 客户管理系统                                    │
│                                                                │
│  状态: 🟢 运行中    规格: nano    运行时间: 12 天              │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  📊 资源使用                                             │  │
│  │                                                          │  │
│  │  数据库:  ████████░░░░░░░░░░░░  42 MB / 500 MB (8%)    │  │
│  │  存储:    ██░░░░░░░░░░░░░░░░░░  120 MB / 1 GB (12%)    │  │
│  │  今日请求: 1,247 次                                      │  │
│  │  本月 Functions 调用: 3,891 次                           │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  🗃️ 数据表                                               │  │
│  │                                                          │  │
│  │  customers        │ 156 行  │ 最后写入: 2 小时前         │  │
│  │  follow_ups       │ 423 行  │ 最后写入: 30 分钟前        │  │
│  │  attachments      │ 89 行   │ 最后写入: 1 天前           │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  🤖 Agent 访问记录 (最近)                                │  │
│  │                                                          │  │
│  │  09:00 Scope Agent    query-database  customers  ✅      │  │
│  │  09:01 Scope Agent    query-database  follow_ups ✅      │  │
│  │  14:30 Digital Twin   update-record   follow_ups ✅      │  │
│  │  14:30 Digital Twin   insert-record   follow_ups ✅      │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  操作:                                                         │
│  [升级规格]  [暂停后端]  [备份数据]  [查看日志]  [⚠️ 销毁]     │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

---

### 16.7 场景七：Paused App 被访问时的自动恢复

```
前提: "客户管理系统" 已经 7 天没人用，被自动 pause

用户从 Marketplace 点击 "启动应用":

┌───────────────────────────────────────────────────────────────┐
│                                                                │
│  ⏳ 正在唤醒应用后端...                                        │
│                                                                │
│  该应用因长时间未使用已暂停，正在恢复中                         │
│  预计等待: 10-30 秒                                            │
│                                                                │
│  [████████████░░░░░░░░]  60%                                   │
│                                                                │
│  ✅ 数据库已恢复                                               │
│  ✅ 认证服务已启动                                             │
│  🔄 等待健康检查...                                            │
│                                                                │
└───────────────────────────────────────────────────────────────┘

恢复完成后 → 自动跳转到 app 界面，数据完整保留
```

---

### 16.8 交互流程总结

| 角色 | 触发点 | 交互方式 | 感知到的变化 |
|------|--------|---------|-------------|
| App 创建者 | Publish 时 | 多一步"后端选择" | 等待 30-60 秒 provisioning |
| App 创建者 | 发布后 | Chat 中让 Agent 建表/插数据 | Agent 直接操作后端 |
| App 使用者 | 启动 app | 无感知（SDK 自动连接） | app 有真实数据了 |
| App 使用者 | 访问 paused app | 等待 10-30 秒恢复 | 短暂 loading |
| App Owner | 管理后端 | 后端管理面板 | 看到资源使用、Agent 访问记录 |
| Scope Agent | 定时/用户触发 | MCP 直连查询 | 能读写 app 数据 |
| Digital Twin | 数据变化事件 | MCP + Realtime 订阅 | 能自动处理业务 |

**核心设计原则：对 app 使用者尽量无感知，复杂度留给平台和 Agent 层处理。用户只需要在 publish 时多做一个选择，之后一切自动化。**