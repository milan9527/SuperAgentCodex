# Data Connector 模块设计文档

> Super Agent Platform — 企业级数据连接器架构设计
> 版本: 2.0.0 | 日期: 2026-04-12

---

## 1. 设计背景与核心理念

### 1.1 问题陈述

Super Agent 当前通过 Skills（S3 存储的 SKILL.md）和 MCP Servers（Model Context Protocol）为 Agent 提供外部工具能力。但在企业实际场景中，连接外部系统不仅仅是"有一个 MCP Server"就够了——还需要：

- **Credential 管理**：OAuth tokens、API Keys、数据库连接串等敏感信息的安全存储与生命周期管理
- **连接配置统一管理**：一个 Salesforce 连接 = OAuth Credential + 连接器 Lambda，两者缺一不可
- **连接状态监控**：Token 是否过期？连接是否可用？
- **多租户隔离**：不同组织、不同 Scope 的连接互不可见
- **工具级权限控制**：同一个连接器的不同操作，对不同角色可见性不同
- **在 Chat 和 Workflow 中无缝使用**：Agent 在对话或工作流执行时，能自动获取所需连接的工具

### 1.2 核心公式

```
Data Connector = Credential + Gateway Lambda Target + Cedar 策略 + 连接配置元数据
```

### 1.3 连接器 vs MCP Server：两个独立的功能模块

```
┌─────────────────────────────────────────────────────────────────┐
│  Data Connector（本文档）                                        │
│                                                                 │
│  平台自建的连接器，统一走 AgentCore Gateway                      │
│  Gmail、Salesforce、BigQuery、Redshift、SageMaker...            │
│  预构建 Lambda + Cedar 策略 + Identity Token Vault               │
│  凭证零暴露，工具级权限控制                                      │
│                                                                 │
│  用户入口: Scope 配置页 → "数据连接器" Tab                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  MCP Server（现有功能，不变）                                     │
│                                                                 │
│  用户自行添加的社区 MCP Server（brave-search、puppeteer 等）     │
│  走现有的 Stdio/SSE 模式，凭证通过环境变量注入                    │
│  保持现有逻辑不变，不纳入连接器管理                               │
│                                                                 │
│  用户入口: MCP Servers 面板 / MCP 目录                           │
└─────────────────────────────────────────────────────────────────┘
```

两者是独立的功能模块，用户不需要理解它们的区别——连接器是平台提供的安全连接方案，MCP Server 是社区生态的开放接入。

### 1.4 连接器分类

| 类别 | 示例 | 认证方式 |
|------|------|----------|
| SaaS 应用 | Gmail, Salesforce, Slack, Google Maps | OAuth 2.0 / API Key |
| 数据库 | BigQuery, Redshift, PostgreSQL, MySQL | Service Account / IAM / Connection String |
| AWS 服务 | SageMaker, S3, DynamoDB, Lambda | IAM Role |
| 内部系统 | 企业 ERP, CRM, 自建 API | API Key / OAuth |

---

## 2. 架构总览：AgentCore Gateway 驱动

所有平台连接器统一通过 AgentCore Gateway 路由，这是整个模块的架构基石。

```
┌─────────────────────────────────────────────────────────────────┐
│  Agent (Chat / Workflow)                                         │
│                                                                 │
│  Agent 只持有访问 Gateway 的 JWT token                           │
│  Agent 进程中零下游凭证                                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │ MCP (Streamable HTTP)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  AgentCore Gateway（每个 Organization 一个实例）                  │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Inbound Auth│  │ Cedar Policy│  │ Outbound Auth           │ │
│  │ JWT / SigV4 │  │ 工具级权限  │  │ Identity Token Vault    │ │
│  │ 验证调用者  │  │ 过滤工具列表│  │ 向下游注入凭证          │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
│  Targets:                                                       │
│  ├── Lambda: Gmail Connector        (6 tools)                   │
│  ├── Lambda: Salesforce Connector   (4 tools)                   │
│  ├── Lambda: BigQuery Connector     (5 tools)                   │
│  ├── Lambda: Redshift Connector     (3 tools)                   │
│  ├── Lambda: SageMaker Connector    (3 tools)                   │
│  ├── Lambda: Generic REST Proxy     (dynamic tools)             │
│  └── API Gateway: OpenAPI Auto-Convert (auto-generated tools)   │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
              外部服务 (Gmail API, Salesforce API, BigQuery API...)
```

### 2.1 为什么统一走 Gateway

在前期讨论中，我们深入分析了凭证在运行时的安全问题（详见附录 A）。核心结论是：

- 环境变量注入方式无法避免凭证在 Agent 进程中以明文存在
- AgentCore Gateway 通过 Outbound Auth 在网关层面代理注入凭证，Agent 进程中零下游凭证
- Cedar 策略提供工具级的细粒度权限控制，且在 ENFORCE 模式下未授权工具直接从 list_tools 中消失
- Gateway 是 AWS 托管服务，免去自建 Proxy 的运维负担

---

## 3. 数据模型设计

### 3.1 新增 Prisma Models

```prisma
// ============================================================================
// Credential Vault — 加密存储连接凭证
// ============================================================================
model credential_vault {
  id              String    @id @default(uuid()) @db.Uuid
  organization_id String    @db.Uuid
  name            String    @db.VarChar(255)
  description     String?
  auth_type       String    @db.VarChar(50)
  // auth_type: oauth2, api_key, basic, iam_role, connection_string, service_account

  // 加密存储的凭证数据（AES-256-GCM，KMS 信封加密）
  encrypted_data  String
  kms_key_arn     String?   @db.VarChar(512)
  encrypted_dek   String?

  // OAuth 专用
  oauth_provider    String?   @db.VarChar(100)
  oauth_scopes      String[]  @default([])
  token_expires_at  DateTime? @db.Timestamptz
  refresh_token_enc String?

  // 状态
  status          String    @default("active") @db.VarChar(50)
  last_verified_at DateTime? @db.Timestamptz
  expires_at       DateTime? @db.Timestamptz

  created_by      String?   @db.Uuid
  created_at      DateTime  @default(now()) @db.Timestamptz
  updated_at      DateTime  @default(now()) @updatedAt @db.Timestamptz

  organization    organizations    @relation(fields: [organization_id], references: [id], onDelete: Cascade)
  connectors      data_connectors[]

  @@unique([organization_id, name], name: "unique_credential_name_per_org")
  @@index([organization_id])
  @@index([auth_type])
  @@index([status])
  @@index([token_expires_at])
}

// ============================================================================
// Data Connectors — Gateway Lambda Target + Credential 的绑定实体
// ============================================================================
model data_connectors {
  id                  String    @id @default(uuid()) @db.Uuid
  organization_id     String    @db.Uuid
  name                String    @db.VarChar(255)
  display_name        String    @db.VarChar(255)
  description         String?
  icon                String?
  connector_type      String    @db.VarChar(50)
  // connector_type: saas, database, aws_service, internal_api

  // 关联的凭证
  credential_id       String    @db.Uuid

  // Gateway 相关
  gateway_target_id     String?   @db.VarChar(255)
  gateway_target_arn    String?   @db.VarChar(512)
  identity_provider_arn String?   @db.VarChar(512)

  // 连接器特定配置（非敏感）
  config              Json      @default("{}")
  template_id         String?   @db.VarChar(100)

  // 状态
  status              String    @default("configured") @db.VarChar(50)
  last_health_check   DateTime? @db.Timestamptz
  health_message      String?
  error_count         Int       @default(0)

  // 使用统计
  usage_count         Int       @default(0)
  last_used_at        DateTime? @db.Timestamptz

  created_by          String?   @db.Uuid
  created_at          DateTime  @default(now()) @db.Timestamptz
  updated_at          DateTime  @default(now()) @updatedAt @db.Timestamptz

  organization        organizations    @relation(fields: [organization_id], references: [id], onDelete: Cascade)
  credential          credential_vault @relation(fields: [credential_id], references: [id], onDelete: Restrict)
  scope_connectors    scope_data_connectors[]

  @@unique([organization_id, name], name: "unique_connector_name_per_org")
  @@index([organization_id])
  @@index([connector_type])
  @@index([credential_id])
  @@index([status])
}

// ============================================================================
// Scope ↔ Data Connector 绑定
// ============================================================================
model scope_data_connectors {
  id                String   @id @default(uuid()) @db.Uuid
  business_scope_id String   @db.Uuid
  connector_id      String   @db.Uuid
  assigned_at       DateTime @default(now()) @db.Timestamptz
  assigned_by       String?  @db.Uuid
  scope_config      Json?    @db.JsonB

  connector      data_connectors @relation(fields: [connector_id], references: [id], onDelete: Cascade)

  @@unique([business_scope_id, connector_id], name: "unique_scope_connector")
  @@index([business_scope_id])
  @@index([connector_id])
}

// ============================================================================
// Connector Audit Log
// ============================================================================
model connector_audit_log {
  id              String   @id @default(uuid()) @db.Uuid
  organization_id String   @db.Uuid
  connector_id    String?  @db.Uuid
  credential_id   String?  @db.Uuid
  action          String   @db.VarChar(50)
  actor_id        String?  @db.Uuid
  actor_type      String   @default("user") @db.VarChar(20)
  details         Json     @default("{}")
  ip_address      String?  @db.VarChar(45)
  created_at      DateTime @default(now()) @db.Timestamptz

  @@index([organization_id, created_at(sort: Desc)])
  @@index([connector_id])
  @@index([credential_id])
}
```

---

## 4. Credential 安全架构

### 4.1 信封加密（Envelope Encryption）

凭证在平台侧使用 KMS 信封加密存储，同时同步到 AgentCore Identity Token Vault。

```
┌──────────────────────────────────────────────────────────┐
│  AWS KMS (CMK 永不离开 HSM，支持自动年度轮换)             │
└──────────────┬───────────────────────────────────────────┘
               │ GenerateDataKey / Decrypt
               ▼
┌──────────────────────────────────────────────────────────┐
│  DEK (每个 Credential 唯一，明文仅在内存中，用完即清零)   │
└──────────────┬───────────────────────────────────────────┘
               │ AES-256-GCM
               ▼
┌──────────────────────────────────────────────────────────┐
│  credential_vault.encrypted_data (数据库中始终密文)       │
└──────────────────────────────────────────────────────────┘
               │
               │ 同步
               ▼
┌──────────────────────────────────────────────────────────┐
│  AgentCore Identity Token Vault (AWS 托管 KMS 加密)       │
│  Gateway Outbound Auth 从这里获取凭证，Agent 进程零接触   │
└──────────────────────────────────────────────────────────┘
```

为什么两边都存？
- credential_vault 是平台的管理视图（CRUD、审计、状态监控）
- Token Vault 是运行时的凭证源（Gateway Outbound Auth 直接读取）
- 平台侧加密存储是兜底，即使 Token Vault 不可用也能恢复

### 4.2 安全层级总结

| 层级 | 措施 | 说明 |
|------|------|------|
| 存储层 | KMS 信封加密 + Token Vault | 双重加密存储 |
| 运行时 | Gateway Outbound Auth | Agent 进程中零下游凭证 |
| LLM 隔离 | 两层函数模式 | Token 永不进入 LLM 上下文窗口 |
| 访问控制 | Cedar 策略 | 工具级细粒度权限，ENFORCE 模式下未授权工具不可见 |
| 审计 | CloudTrail + connector_audit_log | 每次凭证访问和工具调用都有记录 |
| 多租户 | KMS EncryptionContext 绑定 org_id | 跨 Organization 无法解密 |
| OAuth | Identity 托管刷新 | 自动 token refresh，过期前续期 |

---

## 5. 后端服务层设计

### 5.1 服务架构

```
backend/src/
├── repositories/
│   ├── credential-vault.repository.ts
│   ├── data-connector.repository.ts
│   └── connector-audit.repository.ts
├── services/
│   ├── credential-vault.service.ts        // 凭证加密存储 + KMS
│   ├── data-connector.service.ts          // 连接器 CRUD + Scope 绑定
│   ├── connector-provisioner.service.ts   // Gateway 自动编排（核心）
│   ├── connector-registry.service.ts      // 连接器模板目录
│   ├── cedar-policy-builder.service.ts    // Cedar 策略生成 + 可视化编辑
│   └── oauth-flow.service.ts              // OAuth 2.0 授权流程
├── routes/
│   ├── connectors.routes.ts
│   └── oauth-callback.routes.ts
├── schemas/
│   └── connector.schema.ts
```

### 5.2 API 设计

```
# Credential Vault
POST   /api/credentials                    # 创建凭证
GET    /api/credentials                    # 列出凭证（脱敏）
PUT    /api/credentials/:id                # 更新凭证
DELETE /api/credentials/:id                # 删除凭证
POST   /api/credentials/:id/verify         # 验证有效性

# Data Connectors
POST   /api/connectors                     # 创建连接器（触发 Gateway 自动编排）
GET    /api/connectors                     # 列出连接器
GET    /api/connectors/:id                 # 获取详情
PUT    /api/connectors/:id                 # 更新
DELETE /api/connectors/:id                 # 删除（自动清理 Gateway Target）
POST   /api/connectors/:id/test            # 测试连接
GET    /api/connectors/:id/audit-log       # 审计日志
PUT    /api/connectors/:id/permissions     # 更新 Cedar 工具权限

# Scope 绑定
POST   /api/scopes/:scopeId/connectors              # 绑定
DELETE /api/scopes/:scopeId/connectors/:connectorId  # 解绑
GET    /api/scopes/:scopeId/connectors               # 列出

# 模板目录
GET    /api/connector-templates                      # 列出所有模板
GET    /api/connector-templates/:templateId           # 模板详情

# OAuth
GET    /api/oauth/:provider/authorize      # 发起授权
GET    /api/oauth/:provider/callback       # 回调
```

### 5.3 连接器自动编排服务（核心）

用户点击"添加连接器"后，`ConnectorProvisionerService` 自动完成所有 Gateway 基础设施操作：

```typescript
// backend/src/services/connector-provisioner.service.ts

export class ConnectorProvisionerService {

  async provisionFromTemplate(
    organizationId: string,
    templateId: string,
    userConfig: Record<string, any>,
    credential: DecryptedCredential,
    scopeId: string,
  ): Promise<DataConnector> {

    const template = this.registry.getTemplate(templateId);

    // 1. 加密存储凭证
    const credentialId = await this.credentialVaultService.encrypt(
      organizationId, credential, template.auth_type,
    );

    // 2. 同步到 AgentCore Identity Token Vault
    const identityProviderArn = await this.syncToTokenVault(
      organizationId, credentialId, template,
    );

    // 3. 确保 Gateway 存在（每个 org 一个，首次自动创建）
    const gatewayId = await this.getOrCreateOrgGateway(organizationId);

    // 4. 注册 Lambda Target（复用已有的预构建 Lambda）
    const lambdaArn = await this.ensureLambdaDeployed(template.id);
    const targetId = await this.registerGatewayTarget(
      gatewayId, template, lambdaArn, identityProviderArn,
    );

    // 5. 配置默认 Cedar 策略（允许 org 内所有用户访问所有工具）
    await this.ensureDefaultCedarPolicy(gatewayId, targetId, organizationId);

    // 6. 创建 data_connectors 记录
    const connector = await this.dataConnectorService.create({
      organizationId, credential_id: credentialId,
      gateway_target_id: targetId,
      identity_provider_arn: identityProviderArn,
      config: userConfig, template_id: templateId,
      ...template.metadata,
    });

    // 7. 绑定到 Scope + 测试连接
    await this.dataConnectorService.bindToScope(connector.id, scopeId);
    await this.testConnection(connector.id, organizationId);

    return connector;
  }
}
```

---

## 6. 预构建 Lambda 连接器池

每种连接器类型对应一个预构建的 Lambda 函数，所有操作写在一个 Lambda 里，通过 Cedar 策略控制哪些操作可见。

```
infra/lambda/connectors/
├── gmail/               # 搜索、读取、发送、回复、标签管理 (6 tools)
│   ├── handler.ts       # ← 已实现，316 行
│   └── tools.json
├── salesforce/          # SOQL 查询、对象 CRUD (4 tools)
│   ├── handler.ts
│   └── tools.json
├── bigquery/            # SQL 查询、表管理 (5 tools)
│   ├── handler.ts
│   └── tools.json
├── redshift/            # SQL 查询 (3 tools)
│   ├── handler.ts
│   └── tools.json
├── sagemaker/           # 端点调用、模型管理 (3 tools)
│   ├── handler.ts
│   └── tools.json
└── generic-rest/        # 通用 REST API 代理 (dynamic tools)
    ├── handler.ts
    └── tools.json
```

同一个 Lambda 可服务多个连接（不同 org 的不同实例），通过 Gateway Target 的 Credential Provider 区分。

---

## 7. Cedar 工具权限管理

### 7.1 职责分离

- **Lambda** 负责"能做什么"——实现所有操作的代码逻辑
- **Cedar** 负责"谁能做什么"——控制哪些操作对哪些调用者可见

Lambda 不写任何权限判断代码。Gateway 在请求到达 Lambda 之前就已经根据 Cedar 策略做了拦截。ENFORCE 模式下，未授权的工具直接从 `list_tools` 结果中消失。

### 7.2 可视化权限编辑器

用户通过界面勾选权限矩阵，平台自动生成 Cedar 策略：

```
┌─────────────────────────────────────────────────────────────────┐
│  Gmail 连接器 — 工具权限                                         │
│                                                                 │
│              搜索邮件  读取邮件  发送邮件  回复邮件  改标签       │
│  ┌─────────┬────────┬────────┬────────┬────────┬────────┐      │
│  │ 全部成员 │   ✅   │   ✅   │   ❌   │   ❌   │   ❌   │      │
│  │ 管理层   │   ✅   │   ✅   │   ✅   │   ✅   │   ✅   │      │
│  │ 销售组   │   ✅   │   ✅   │   ✅   │   ✅   │   ❌   │      │
│  └─────────┴────────┴────────┴────────┴────────┴────────┘      │
│                                                                 │
│  ⛔ 全局禁止规则                                                 │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  ☑ 禁止所有人将邮件移入垃圾箱 (TRASH)               │       │
│  │  [+ 添加禁止规则]                                    │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                 │
│                          [预览 Cedar 策略]  [保存]              │
└─────────────────────────────────────────────────────────────────┘
```

后端将勾选结果翻译为 Cedar 语句：

```typescript
// cedar-policy-builder.service.ts
function buildCedarPolicy(
  gatewayArn: string,
  targetName: string,
  permissions: ToolPermission[],
): string {
  return permissions.map(perm => {
    const action = `AgentCore::Action::"${targetName}___${perm.toolName}"`;
    const resource = `AgentCore::Gateway::"${gatewayArn}"`;
    const when = perm.scopeOrRole !== 'all'
      ? ` when {\n  principal.getTag("scope") like "*${perm.scopeOrRole}*"\n}` : '';
    return `${perm.effect}(\n  principal,\n  action == ${action},\n  resource == ${resource}\n)${when};`;
  }).join('\n\n');
}
```

高级用户可点击"预览 Cedar 策略"查看和直接编辑原始 Cedar 代码。

---

## 8. 在 Chat 和 Workflow 中的集成

### 8.1 Chat 集成

当用户在某个 Scope 下发起 Chat 时，系统将该 Scope 绑定的连接器对应的 Gateway 端点注入到 Agent 的 MCP 配置中：

```
用户发起 Chat
    │
    ▼
chat.service.ts → startSession()
    │
    ├── 加载 Scope 的 Skills（现有逻辑）
    ├── 加载 Scope 的 MCP Servers（现有逻辑）
    ├── 【新增】加载 Scope 的 Data Connectors
    │       │
    │       ▼
    │   获取 Scope 绑定的连接器列表
    │   → 构建 Gateway MCP 端点配置（含 JWT token）
    │   → Agent 通过 Gateway 访问所有连接器工具
    │   → 凭证由 Gateway Outbound Auth 代理注入
    │
    ▼
Agent 会话启动（Agent 进程中零下游凭证）
```

### 8.2 Workflow 集成

#### 模式 A：通过 Agent 节点间接使用

Agent 节点执行时，自动继承其所在 Scope 的连接器配置，与 Chat 逻辑一致。

#### 模式 B：Connector Action 节点（未来扩展）

在 Workflow Canvas 中新增 "Connector" 节点类型，允许直接配置固定的数据操作（如定时从 BigQuery 拉取报表），不需要 AI 推理。

---

## 9. 前端交互设计

### 9.1 连接器管理面板

```
frontend/src/
├── components/
│   ├── ConnectorPanel.tsx          // 管理主面板
│   ├── ConnectorCard.tsx           // 单个连接器卡片
│   ├── ConnectorWizard.tsx         // 创建向导（选模板 → 填凭证 → 测试）
│   ├── CredentialForm.tsx          // 凭证表单（按 auth_type 动态渲染）
│   ├── OAuthConnectButton.tsx      // OAuth 授权按钮
│   ├── ConnectorHealthBadge.tsx    // 连接状态徽章
│   └── CedarPermissionEditor.tsx   // 工具权限矩阵编辑器
├── services/
│   └── connectorService.ts
└── hooks/
    └── useConnectors.ts
```

### 9.2 连接向导（以 Salesforce 为例）

用户只做三件事：填 URL → 点授权 → 看结果。

```
Step 1/3: 填写 Salesforce 实例 URL + API 版本
Step 2/3: 点击"授权连接"按钮，弹窗完成 OAuth
Step 3/3: 自动测试连接，展示可用工具列表
```

背后的 Gateway Target 注册、Credential Provider 创建、Cedar 策略配置全部由 `ConnectorProvisionerService` 自动完成。

### 9.3 自定义连接器

| 方式 | 适用场景 | 复杂度 |
|------|----------|--------|
| 上传 OpenAPI Spec | 有 API 文档的服务 | ⭐⭐ 简单 |
| 通用 REST 代理 | 无 Spec 的简单 API | ⭐⭐⭐ 中等 |
| 高级配置 | 直接编辑 Cedar / Target / Schema | ⭐⭐⭐⭐ 灵活 |

---

## 10. OAuth 2.0 授权流程

```
前端                          后端                         第三方
  │  1. 点击"授权连接"          │                              │
  │ ──────────────────────────>│  2. 生成 state + PKCE        │
  │  3. 返回 authorize URL     │     存入 Redis (TTL=10min)   │
  │ <──────────────────────────│                              │
  │  4. 弹窗打开 authorize URL ─────────────────────────────>│
  │                            │  5. 用户授权，回调            │
  │                            │<─────────────────────────────│
  │                            │  6. code → token             │
  │                            │─────────────────────────────>│
  │                            │  7. access_token + refresh   │
  │                            │<─────────────────────────────│
  │                            │  8. 加密存储 + 同步 Token Vault
  │  9. 授权成功               │                              │
  │ <──────────────────────────│                              │
```

Token 刷新由 AgentCore Identity 托管自动处理。平台侧通过 BullMQ Worker 定期同步状态，确保 credential_vault 中的过期信息与 Token Vault 一致。

---

## 11. 实施路线图

### Phase 1: 基础能力（3 周）
- Prisma schema 新增 3 张表 + migration
- credential-vault.service.ts（KMS 信封加密）
- connector-provisioner.service.ts（Gateway 自动编排）
- CDK: Gateway 实例 + KMS Key + IAM 权限
- 预构建 Gmail + Salesforce Lambda 连接器
- 前端 ConnectorPanel + ConnectorWizard
- 集成到 Chat 会话初始化流程

### Phase 2: 扩展连接器 + 权限管理（2 周）
- 预构建 BigQuery + Redshift + SageMaker Lambda 连接器
- OAuth 2.0 授权流程（Google、Salesforce）
- Cedar 可视化权限编辑器
- 连接健康检查 + 审计日志 UI

### Phase 3: 自定义连接器 + 高级功能（2 周）
- OpenAPI Spec 自动转换
- 通用 REST 代理 Lambda
- Workflow Connector Action 节点
- 高级配置入口（Cedar 原始编辑、Target Schema 修改）

---

## 12. 关键设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| 连接器统一路径 | AgentCore Gateway | 凭证零暴露，工具级权限，托管 OAuth，免运维 |
| 与 MCP Server 的关系 | 独立模块，互不干涉 | 连接器 = 平台安全方案，MCP = 社区开放生态 |
| 凭证存储 | credential_vault + Token Vault 双写 | 平台管理视图 + 运行时凭证源 |
| 加密方案 | KMS Envelope Encryption | 主密钥永不暴露，支持自动轮换 |
| 权限控制 | Cedar 策略 + 可视化编辑器 | 工具级细粒度，普通用户勾选矩阵，高级用户编辑原始 Cedar |
| Lambda 复用 | 同一 Lambda 服务多个连接 | 通过 Target 级 Credential Provider 区分 |
| 配置体验 | 平台自动编排，用户零感知 | 预构建 Lambda 池 + 自动 Target 注册 |
| 自定义连接器 | OpenAPI 自动转换 + REST 代理 | 零代码接入，Gateway 原生支持 |

---

## 附录 A: 凭证运行时安全分析（选择 Gateway 的决策依据）

在设计初期，我们评估了环境变量注入方式的安全风险：

| 风险 | 说明 |
|------|------|
| /proc 泄露 | Linux 上同用户进程可读取 `/proc/<pid>/environ` |
| 日志泄露 | 社区 MCP Server 可能在 debug 日志中打印 env |
| 第三方代码 | npm 依赖可能有恶意代码读取环境变量 |
| LLM 泄露 | Token 进入 LLM 上下文后可能出现在输出中 |

核心结论：无论用什么密钥管理服务（Secrets Manager、Vault、KMS），"最后一公里"的明文暴露在环境变量注入模式下不可避免。AgentCore Gateway 通过在网关层面代理注入凭证，是唯一能做到 Agent 进程零凭证的方案。

> 参考来源：
> - [AgentCore Gateway 核心概念](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.html)
> - [AgentCore Identity 安全博客](https://aws.amazon.com/blogs/security/securing-ai-agents-with-amazon-bedrock-agentcore-identity/)
> - [AgentCore 多层安全实现指南](https://hidekazu-konishi.com/entry/amazon_bedrock_agentcore_implementation_guide_part2_security.html)
> - [Gateway Credential Provider CDK API](https://docs.aws.amazon.com/cdk/api/v2/docs/@aws-cdk_aws-bedrock-agentcore-alpha.GatewayCredentialProvider.html)
> - [Gateway 细粒度访问控制](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/)
