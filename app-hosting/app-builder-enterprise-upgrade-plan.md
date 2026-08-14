# App Builder 企业级增强方案

> **目标**: 让 App Builder 能造出支撑企业级 AIGC 等真实业务场景的健壮应用
> **日期**: 2026-05-15 | **基于**: Super Agent 代码审计

---

## 一、现状审计：五大缺陷

### 1.1 认证鉴权 — 半成品

| 环节 | 现状 | 问题 |
|------|------|------|
| **HTML入口** | `authenticate` 中间件校验 JWT | 正常 |
| **非HTML资源（JS/CSS/图片）** | 无认证，靠 UUID 不可猜测性 | 知道 appId 就能下载源码、提取内嵌密钥 |
| **Data API** | `authenticate` + `org_id` 过滤 | 正常 |
| **App 终端用户鉴权** | 无 | 只有"平台用户"概念，没有"App 最终用户"概念 |
| **App 级别公开/私密** | 无 | 所有 App 对组织内所有人可见，无法控制外部访问 |

**代码证据**:
- `apps.routes.ts:917-926` — 非 HTML 资源直接 serve，无 auth check
- `appData.routes.ts:42` — CRUD 用 `authenticate` 但只认平台用户身份
- 无 `app_users` 表、无 App 级登录注册

### 1.2 后端存储 — 共享实例无隔离

| 层面 | 现状 | 问题 |
|------|------|------|
| **基础模式 (JSONB)** | 所有 App 数据在主 PG 的 `app_data` 表 | 虽然有 `org_id` 过滤，但共享一个 PG 实例、一个表、一个连接池。数据量大后互相影响性能 |
| **InsForge 模式** | Per-App PG Schema（`app_{uuid}`） | **架构已有但未实现**：Docker Compose 未交付、Deno Functions 是 stub、Auth Service 未实现。`INSFORGE_ENABLED=false` 是默认值 |
| **数据迁移** | 无 | 基础模式 → InsForge 模式没有迁移路径 |
| **备份恢复** | 无 App 级别备份 | 只能整体 PG dump，无法单独恢复某个 App 的数据 |

### 1.3 文件存储 — 基本可用但缺管理

| 层面 | 现状 | 问题 |
|------|------|------|
| **S3 路径** | `${orgId}/${timestamp}-${fileName}` | Org 级隔离，非 App 级 |
| **权限校验** | 校验文件 key 以 orgId 开头 | 合理但粒度粗 |
| **App 级文件管理** | 无 | 没有按 App 维度的文件列表、配额、生命周期管理 |
| **CDN/签名 URL** | 无 | 所有文件通过 API 代理访问，性能和成本都不理想 |

### 1.4 智能体问答体验 — 未标配

| 层面 | 现状 | 问题 |
|------|------|------|
| **Agent 对话组件** | `ChatRoom` 组件存在 | 但它只存在于平台内部页面，不能嵌入 Published App |
| **App 内嵌 Agent** | 无标准方案 | Published App 是 iframe sandbox，无法直接调用平台的 Agent API |
| **AI Widget** | 无 | 没有可拖入 App 的标准 AI 对话浮窗/面板组件 |
| **上下文传递** | 无 | Agent 无法感知当前 App 页面的数据上下文（比如"正在查看哪个客户的需求"） |

### 1.5 数据建模能力 — 太弱

| 能力 | 基础模式 | InsForge 模式 |
|------|---------|--------------|
| 关系定义 | 无（纯 JSONB 文档） | 有（完整 PG）但未实现 |
| Schema 校验 | 无 | 无 |
| 关联查询 | 无 | 无（虽然 PG 支持，但未暴露给 App） |
| 聚合管道 | 有限（sum/avg/count） | 未实现 |
| 触发器/钩子 | 无 | 未实现 |

---

## 二、增强方案总览

```
┌──────────────────────────────────────────────────────┐
│                增强后的 App Builder                    │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │  Layer 1: App Runtime Shell（新增）          │     │
│  │  ├── 终端用户认证（App User Auth）           │     │
│  │  ├── AI 对话 Widget（标配嵌入）              │     │
│  │  ├── 页面上下文传递给 Agent                  │     │
│  │  └── App 级文件管理 + 签名URL                │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │  Layer 2: Data Layer（重构）                 │     │
│  │  ├── Schema 定义 + 校验                      │     │
│  │  ├── 关联关系 + 级联操作                      │     │
│  │  ├── 视图 + 聚合管道                          │     │
│  │  └── 事件钩子（写入后触发工作流）             │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │  Layer 3: Backend Service（补齐InsForge）    │     │
│  │  ├── 独立 PG 实例（与主库隔离）              │     │
│  │  ├── Deno Functions 运行时                    │     │
│  │  ├── 定时任务（App级Cron）                    │     │
│  │  └── Webhook 出站                             │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │  Layer 4: 安全加固                           │     │
│  │  ├── 全资源签名URL                            │     │
│  │  ├── App 级 RBAC（Owner/Editor/Viewer）      │     │
│  │  ├── 数据加密（字段级）                       │     │
│  │  └── 操作审计日志                             │     │
│  └─────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

---

## 三、逐项详细方案

### 3.1 App 终端用户认证体系

#### 问题
当前只有"平台用户"（Super Agent 的 organization member）概念。App 面向的最终用户（比如Tenant A的客户、外部合作方）没有身份体系。

#### 方案

**3.1.1 双层认证模型**

```
┌─────────────────────────────────────────┐
│  Platform Auth（已有）                    │
│  ├── 平台管理员、组织成员                  │
│  ├── JWT (Cognito / 内置Auth)            │
│  └── 用于：管理后台、App Builder编辑器    │
│                                          │
│  App Auth（新增）                         │
│  ├── App 终端用户                         │
│  ├── 认证方式（按App配置选择）：           │
│  │   ├── 匿名访问（公开App）              │
│  │   ├── 邀请码 / 注册码                  │
│  │   ├── 用户名密码（App内置注册）         │
│  │   ├── OAuth（微信/企微/飞书登录）       │
│  │   └── SSO（对接企业IdP）               │
│  ├── App 级 RBAC: Owner / Editor / Viewer │
│  └── 用于：Published App 运行时           │
└─────────────────────────────────────────┘
```

**3.1.2 数据模型**

新增表：

```sql
-- App 用户表
app_users (
  id, app_id, org_id,
  email, phone, display_name,
  auth_provider,        -- 'anonymous' | 'password' | 'wechat' | 'wecom' | 'feishu' | 'sso'
  auth_provider_id,     -- 外部ID
  role,                 -- 'owner' | 'editor' | 'viewer'
  status,               -- 'active' | 'invited' | 'disabled'
  last_login_at,
  created_at
)

-- App 用户会话
app_sessions (
  id, app_user_id, app_id,
  token_hash, expires_at,
  ip_address, user_agent
)

-- App 访问策略
app_access_policies (
  id, app_id,
  access_mode,          -- 'public' | 'invite' | 'register' | 'sso'
  allowed_domains,      -- 邮箱域名白名单
  max_users,
  registration_fields   -- 注册时需要填的字段（JSON）
)
```

**3.1.3 API 变更**

```
POST   /api/apps/:appId/auth/register     -- 终端用户注册
POST   /api/apps/:appId/auth/login        -- 终端用户登录
POST   /api/apps/:appId/auth/logout       -- 终端用户登出
POST   /api/apps/:appId/auth/invite       -- 邀请用户（Owner操作）
GET    /api/apps/:appId/auth/me           -- 获取当前App用户信息
PATCH  /api/apps/:appId/auth/users/:uid   -- 修改用户角色/状态
```

**3.1.4 对 Data API 的影响**

现有 Data API 加 `app_user_id` 校验：

```typescript
// 现在的过滤
where: { app_id: appId, org_id: request.user!.orgId }

// 增强后
where: {
  app_id: appId,
  org_id: request.user!.orgId,
  // 可选：加行级权限过滤
  // created_by: request.appUser!.userId  // Viewer只能看自己的数据
}
```

---

### 3.2 后端存储隔离

#### 问题
- 基础模式：所有 App 的 JSONB 在主 PG 的同一个表里
- InsForge 模式：架构设计好但未实现
- 无论哪种模式，都与 Super Agent 主库共享 PG 实例

#### 方案

**3.2.1 三级存储策略**

```
级别 1 — 共享 JSONB（轻量App，现状不变）
  ├── 继续用主 PG 的 app_data 表
  ├── 加 collection 级配额限制
  └── 适合：简单CRUD、轻量表单、内部工具

级别 2 — 隔离 Schema（中等App，补齐实现）
  ├── 同一个 PG 实例，独立 Schema
  ├── Schema: app_{uuid}
  ├── 完整建表能力、关联、索引
  ├── 适合：需要关系型查询的业务（Schedule Manager、项目跟踪）

级别 3 — 独立实例（重型App，新增）
  ├── 独立 PG 实例（Docker 或 RDS）
  ├── 完全隔离，不影响主库
  ├── 适合：数据量大、查询复杂、高并发（Sentiment Analysis、Ad Analytics DW）
  └── 通过 MCP 暴露给 Agent
```

**3.2.2 Schema Builder（新增）**

为 App Builder 增加可视化数据建模能力：

```
数据建模面板（新 UI）
├── 定义表（Table）
│   ├── 字段名、类型（text/number/boolean/date/json/relation）
│   ├── 约束（必填/唯一/默认值/校验规则）
│   └── 索引
├── 定义关联（Relation）
│   ├── 一对多 / 多对一 / 多对多
│   ├── 级联删除策略
│   └── 自动创建关联字段
├── 定义视图（View）
│   ├── 列表视图（含过滤/排序/分页）
│   ├── 看板视图
│   ├── 日历视图
│   └── 图表视图
└── 数据预览 + 测试
```

**3.2.3 API 增强**

```
-- Schema 管理
GET    /api/apps/:appId/schema                    -- 获取App的完整Schema
POST   /api/apps/:appId/schema/tables             -- 创建表
PATCH  /api/apps/:appId/schema/tables/:table      -- 修改表结构
DELETE /api/apps/:appId/schema/tables/:table      -- 删除表

-- 关联查询（新增）
GET    /api/apps/:appId/data/:table?include=related_table   -- 带关联查询
POST   /api/apps/:appId/data/:table?expand=true             -- 展开嵌套

-- 聚合管道（增强）
POST   /api/apps/:appId/data/:table/aggregate
{
  "pipeline": [
    { "$match": { "status": "active" } },
    { "$group": { "_id": "$channel", "total": { "$sum": "$budget" } } },
    { "$sort": { "total": -1 } },
    { "$limit": 10 }
  ]
}
```

---

### 3.3 文件存储增强

#### 方案

**3.3.1 App 级文件隔离**

```
S3 路径规范（增强）
  基础模式：{orgId}/apps/{appId}/{timestamp}-{fileName}
  级别隔离：每个App有独立的路径前缀

App 文件管理 API（新增）
  POST   /api/apps/:appId/files          -- 上传文件
  GET    /api/apps/:appId/files          -- 列出文件
  GET    /api/apps/:appId/files/:fileId  -- 获取签名URL
  DELETE /api/apps/:appId/files/:fileId  -- 删除文件

签名 URL（新增）
  ├── S3 预签名 URL，有效期可配置（默认15分钟）
  ├── 替代现有的 API 代理方式，前端直接访问 S3
  └── 减少后端带宽压力，降低延迟
```

**3.3.2 配额管理**

```sql
-- App 级配额
app_quotas (
  app_id,
  storage_bytes,        -- 文件存储上限
  storage_used,         -- 已使用
  records_limit,        -- 数据记录数上限
  records_used,         -- 已使用
  api_calls_per_day,    -- API 日调用上限
  api_calls_today       -- 今日已调用
)
```

---

### 3.4 智能体问答标配嵌入

这是让 App 从"静态页面"变成"智能应用"的关键。

#### 方案

**3.4.1 AI Widget 组件（新组件）**

App Builder 拖拽面板中增加一个标准组件：**AI Chat Widget**

```
┌─────────────────────────────────┐
│  App 页面                        │
│  ┌──────────────────────────┐   │
│  │  业务内容区               │   │
│  │  （表格、表单、看板等）    │   │
│  └──────────────────────────┘   │
│                     ┌─────────┐ │
│                     │ AI 助手  │ │  ← 可拖入的 AI Widget
│                     │ ┌─────┐ │ │
│                     │ │对话区│ │ │
│                     │ └─────┘ │ │
│                     │ ┌─────┐ │ │
│                     │ │输入框│ │ │
│                     │ └─────┘ │ │
│                     └─────────┘ │
└─────────────────────────────────┘
```

**3.4.2 Widget 能力**

| 能力 | 说明 |
|------|------|
| **上下文注入** | Widget 自动将当前页面的数据上下文（当前查看的记录、筛选条件等）注入到 Agent 的 System Prompt |
| **Agent 绑定** | 每个 Widget 可绑定一个特定的 Agent（如"Tenant A客户顾问"） |
| **动作执行** | Agent 回复中可包含可执行动作（如"帮你创建一条schedule记录"、"发送邮件给客户"） |
| **模式切换** | 支持浮窗模式（右下角）和面板模式（侧边栏） |

**3.4.3 技术实现**

```
App iframe 运行时
  ├── postMessage → 父页面（平台 Shell）
  │   ├── 消息类型：chat_message / page_context / action_request
  │   └── 携带当前页面数据上下文
  └── 父页面 → Agent API
      ├── 调用 Super Agent 的 /api/chat 接口
      ├── 注入 pageContext 作为 System Prompt 的一部分
      └── 流式响应通过 postMessage 回传给 App iframe
```

**3.4.4 上下文注入协议**

```json
{
  "type": "page_context",
  "appId": "xxx",
  "page": "/customers/123",
  "data": {
    "currentRecord": {
      "id": "123",
      "customer_name": "Acme Corp",
      "budget": 500000,
      "status": "requirements_gathering"
    },
    "filters": {
      "industry": "FMCG"
    }
  }
}
```

Agent 收到后可做出上下文感知的回复："当前客户 Acme Corp 的预算是50万，状态为需求采集中，建议推荐 Channel-2 Business 的 Q3 档期..."

---

### 3.5 事件钩子与工作流联动

让 App 的数据变化能触发 Agent 工作流。

#### 方案

```sql
-- App 事件钩子
app_hooks (
  id, app_id,
  event,          -- 'record.created' | 'record.updated' | 'record.deleted'
  table_name,     -- 监听的表/collection
  condition,      -- 触发条件（JSON，可选）
  workflow_id,    -- 触发的工作流
  payload_mapping -- 数据映射（将记录字段映射到工作流变量）
)
```

**示例**：

```
配置：当 media_schedule 表新增记录时 → 触发"schedule审核"工作流

1. App 用户在Schedule Manager页面创建新schedule
2. Data API 写入记录后，检查 app_hooks
3. 命中 hook → 启动工作流
4. 工作流：
   → Agent 检查schedule冲突
   → 条件判断：有冲突？
     ├─ 是 → 发通知给media主管
     └─ 否 → 自动确认 + 通知相关负责人
```

---

### 3.6 安全加固

#### 3.6.1 全资源签名URL

```
现状：
  GET /api/apps/:appId/static/bundle.js  ← 无认证，任何人可访问

增强后：
  GET /api/apps/:appId/static/bundle.js?sig={签名}&exp={过期时间}
  ├── 服务端生成签名 URL，有效期 1 小时
  ├── 每次加载 App 时刷新签名
  ├── 静态资源走 CDN（CloudFront / 阿里云CDN）
  └── 无签名请求直接 403
```

#### 3.6.2 App 级审计日志

```sql
app_audit_log (
  id, app_id, org_id,
  actor_type,       -- 'platform_user' | 'app_user' | 'agent' | 'system'
  actor_id,
  action,           -- 'data.create' | 'data.read' | 'data.update' | 'data.delete' | 'file.upload' | 'auth.login'
  resource_type,    -- 'record' | 'file' | 'user'
  resource_id,
  details,          -- JSON
  ip_address,
  created_at
)
```

#### 3.6.3 敏感字段加密

```
App Schema 中标记敏感字段：
  {
    "field": "phone",
    "type": "text",
    "encrypted": true  ← 标记
  }

存储时自动 AES-256 加密，读取时解密。
Agent 检索时只能看到掩码（138****1234）。
```

---

## 四、优先级排序与实施建议

### P0 — 不做就没法上线（必须优先）

| 序号 | 工作项 | 工作量 | 价值 |
|------|--------|--------|------|
| 1 | **全资源签名URL** | 1-2周 | 关闭当前最大的安全漏洞 |
| 2 | **App 级 RBAC + 终端用户认证** | 3-4周 | Tenant A的 App 面向外部客户使用，必须有独立身份体系 |
| 3 | **AI Chat Widget 组件** | 2-3周 | 这是"智能应用"区别于"普通网页"的核心，也是Tenant A最看重的卖点 |
| 4 | **上下文注入协议** | 1-2周 | 配合 AI Widget，让 Agent 能感知 App 数据上下文 |

### P1 — 不做就做不了复杂业务（第二批）

| 序号 | 工作项 | 工作量 | 价值 |
|------|--------|--------|------|
| 5 | **Schema Builder（可视化数据建模）** | 4-6周 | Schedule Manager等关系型业务的基础 |
| 6 | **关联查询 API** | 2-3周 | 配合 Schema Builder |
| 7 | **事件钩子（数据变化触发工作流）** | 2-3周 | 自动化业务流程的基础 |
| 8 | **App 级文件管理 + 配额** | 1-2周 | 创意素材管理的基础 |

### P2 — 锦上添花（后续迭代）

| 序号 | 工作项 | 工作量 | 价值 |
|------|--------|--------|------|
| 9 | **InsForge Docker 完整实现** | 4-6周 | 为重型 App 提供独立 PG 实例 |
| 10 | **Deno Functions 运行时** | 3-4周 | App 内自定义服务端逻辑 |
| 11 | **App 级审计日志** | 1-2周 | 企业合规要求 |
| 12 | **敏感字段加密** | 1-2周 | 数据安全增强 |
| 13 | **App 级 Cron 定时任务** | 1-2周 | App 内的定时数据处理 |

---

## 五、对Tenant A场景的支撑评估（增强后）

| 场景 | 增强前 | 增强后（P0+P1完成） | 差距 |
|------|--------|---------------------|------|
| **智能客服** | Agent对话 ✅ / App管理 ❌ | 客户需求采集App + AI Widget + 终端用户认证 | 基本可支撑 |
| **创意内容制作** | Agent文案 ✅ / 海报App ❌ | Creative ManagerApp + AI Widget + 文件管理 | 基本可支撑 |
| **Sentiment Monitoring** | Agent分析 ✅ / 看板 ❌ | sentiment看板App + 事件钩子 + 关联查询 | 需配合自建数据服务 |
| **媒体资源管理** | RAG查询 ✅ / scheduleApp ❌ | Schema Builder建关系表 + Schedule ManagerApp + 事件钩子 | P1完成后可支撑 |
| **项目全流程** | 工作流 ✅ / 看板 ❌ | 项目看板App + 事件钩子联动工作流 | 基本可支撑 |
| **知识库+数字人** | 完全可用 ✅ | 不需要 App Builder | 无差距 |

**结论**: P0 + P1 完成后，App Builder 可以支撑 5/6 个场景的应用构建。Sentiment Analysis看板因时序数据特性仍建议自建独立服务。

---

## 六、架构决策建议

### 6.1 InsForge 做不做？

**建议：暂缓全面实现，走实用路线。**

理由：
- 当前 InsForge 需要 Docker Compose 部署完整 BaaS 栈，运维复杂度高
- Tenant A的需求核心是 Agent + 简单数据管理，不是完整 BaaS
- 与其补齐 InsForge（4-6周），不如把 Schema Builder 做好（更通用、ROI 更高）

**替代方案**：在主 PG 中用 Schema 隔离（InsForge Level 2），不搞独立实例。95% 的 App 用共享 Schema 就够了。

### 6.2 App Builder vs 自建服务的选择标准

```
如果 App 满足以下条件 → 用 App Builder
  ├── 数据结构简单（<10张表）
  ├── 无复杂关联查询
  ├── 无实时数据推送需求
  ├── 无高并发写入（<100 QPS）
  └── 需要 AI 对话能力（AI Widget 标配）

如果 App 有以下特征 → 自建独立服务 + MCP
  ├── 时序数据分析（sentiment趋势）
  ├── 高并发事务（实时schedule锁定）
  ├── 复杂计算（ad placement效果归因）
  └── 需要连接多个外部系统
```

### 6.3 给Tenant A的交付节奏建议

| 时间 | 交付内容 |
|------|---------|
| **第1月** | 部署平台 + P0 安全加固 + AI Widget MVP + 4个数字人Agent上线 |
| **第2月** | P0 完善（终端用户认证）+ Creative ManagerApp + 客户需求App 上线 |
| **第3月** | P1 Schema Builder + Schedule ManagerApp + 事件钩子 |
| **第4月** | sentiment看板（自建服务） + 项目全流程 App |
| **第5-6月** | 全场景联调 + 优化 + P2 按需迭代 |
