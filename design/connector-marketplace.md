# Connector Marketplace — 社区可插拔连接器系统设计

> 让社区贡献者打包一个 .zip，管理员一键安装，平台自动部署。

---

## 1. 连接器包格式（Connector Package Format）

社区贡献者提交的是一个标准 zip 文件，内部结构：

```
gmail.connector.zip
├── manifest.json        # 元数据 + 配置 schema（必须）
├── setup-guide.md       # 用户配置指引（必须）
├── tools.json           # MCP 工具定义（必须）
├── handler.js           # Lambda handler（编译后的 JS，必须）
├── node_modules/        # 依赖（可选，如果 handler 有外部依赖）
├── icon.png             # 连接器图标（可选，否则用 manifest.icon emoji）
└── README.md            # 开发者文档（可选）
```

关键约束：
- `handler.js` 必须是编译后的 JS（不是 TS），因为 Lambda 直接运行
- 如果有 `node_modules/`，打包时必须包含（Lambda 不会 npm install）
- 总包大小限制 50MB（Lambda 部署包限制）
- `manifest.json` 必须符合 v1 schema（平台会校验）

## 2. 安装流程

```
管理员上传 gmail.connector.zip
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 校验                                                │
│                                                             │
│  - 解压到临时目录                                            │
│  - 验证 manifest.json schema                                │
│  - 验证 handler.js 存在且可解析                              │
│  - 验证 tools.json 格式                                     │
│  - 检查包大小 < 50MB                                        │
│  - 检查是否与已安装的连接器 ID 冲突                           │
│  - 安全扫描：检查 handler.js 中是否有可疑的网络调用           │
│                                                             │
│  → 校验失败：返回错误详情                                    │
│  → 校验通过：展示预览（名称、描述、工具列表、权限需求）       │
└─────────────────────────────────────────────────────────────┘
         │ 管理员确认安装
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: 部署 Lambda                                         │
│                                                             │
│  - 将 handler.js + node_modules 打包为 Lambda 部署包         │
│  - 创建 Lambda 函数:                                         │
│    connector-{org_id_short}-{connector_id}                  │
│  - 配置 Lambda 执行角色（最小权限）                           │
│  - 设置超时、内存、环境变量                                   │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: 注册 Gateway Target                                 │
│                                                             │
│  - 从 tools.json 读取工具定义                                │
│  - 注册为 Gateway Target（Lambda 类型）                      │
│  - 配置默认 Cedar 策略                                       │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: 存储元数据                                          │
│                                                             │
│  - manifest.json 存入 installed_connectors 表                │
│  - setup-guide.md 存入 S3                                   │
│  - 原始 zip 存入 S3（用于卸载后重装）                        │
│  - 连接器出现在目录中，可供 Scope 绑定                       │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据模型

```prisma
// 已安装的连接器包（区别于 data_connectors 实例）
model installed_connector_packages {
  id              String   @id @default(uuid()) @db.Uuid
  organization_id String   @db.Uuid
  connector_id    String   @db.VarChar(100)  // manifest.id
  version         String   @db.VarChar(50)
  name            String
  icon            String?
  category        String   @db.VarChar(50)
  manifest        Json                       // 完整 manifest.json
  lambda_arn      String?  @db.VarChar(512)  // 部署后的 Lambda ARN
  gateway_target_id String? @db.VarChar(255)
  s3_package_key  String?  @db.VarChar(512)  // 原始 zip 在 S3 的位置
  s3_guide_key    String?  @db.VarChar(512)  // setup-guide.md 在 S3 的位置
  status          String   @default("active") @db.VarChar(50)
  installed_by    String?  @db.Uuid
  installed_at    DateTime @default(now()) @db.Timestamptz
  updated_at      DateTime @default(now()) @updatedAt @db.Timestamptz

  @@unique([organization_id, connector_id], name: "unique_installed_connector")
  @@index([organization_id])
  @@index([status])
}
```

## 4. 安全模型

社区代码运行在 Lambda 中，安全边界：

| 层级 | 措施 |
|------|------|
| 代码隔离 | Lambda 函数级隔离，每个连接器独立函数 |
| 网络隔离 | Lambda 默认无 VPC 访问，只能访问公网 API |
| 权限最小化 | Lambda 执行角色只有 CloudWatch Logs 权限，无 S3/DB 访问 |
| 凭证隔离 | 凭证通过 Gateway Outbound Auth 注入，Lambda 代码无法访问其他连接器的凭证 |
| 超时限制 | Lambda 超时 30 秒，防止恶意长时间运行 |
| 包大小限制 | 50MB，防止滥用存储 |
| 安装审核 | 管理员手动确认安装，可查看工具列表和权限需求 |
| 卸载清理 | 卸载时删除 Lambda + Gateway Target + S3 包 |

## 5. 连接器市场（未来扩展）

当社区连接器足够多时，可以建一个公共市场：

```
┌─────────────────────────────────────────────────────────────┐
│  Connector Marketplace                                       │
│                                                             │
│  🔍 Search connectors...                                     │
│                                                             │
│  [Official]  [Community]  [Database]  [SaaS]  [AWS]         │
│                                                             │
│  📧 Gmail              ☁️ Salesforce         🗺️ Google Maps │
│  ★★★★★ (142)          ★★★★☆ (89)           ★★★★★ (203)    │
│  Official · v1.2.0     Official · v1.0.0    Official · v1.1 │
│  [Install]             [Install]            [Install]       │
│                                                             │
│  📊 Airtable           🎫 Jira              📱 Twilio       │
│  ★★★★☆ (34)           ★★★☆☆ (21)           ★★★★☆ (56)     │
│  Community · v0.9.0    Community · v1.0.0   Community · v1.2│
│  by @john_dev          by @jane_ops         by @sms_team    │
│  [Install]             [Install]            [Install]       │
└─────────────────────────────────────────────────────────────┘
```

市场的后端可以是一个独立的 S3 bucket + DynamoDB 索引：
- 贡献者上传 zip 到公共 bucket
- 审核通过后加入索引
- 平台从索引拉取列表，管理员一键安装

## 6. 贡献者开发流程

```bash
# 1. 从模板创建新连接器
cp -r connector-packages/_template connector-packages/my-connector

# 2. 编辑 manifest.json（定义配置 schema）
# 3. 编写 setup-guide.md（用户指引）
# 4. 定义 tools.json（MCP 工具）
# 5. 实现 handler.ts（Lambda 逻辑）

# 6. 本地测试
cd connector-packages/my-connector
npm run build          # ts → js
npm run test           # 单元测试
npm run package        # 打包为 .connector.zip

# 7. 提交到市场或直接上传到平台
```

提供一个 CLI 工具 `super-agent-connector-cli`：

```bash
# 初始化新连接器项目
npx super-agent-connector init my-connector

# 校验 manifest
npx super-agent-connector validate

# 本地模拟 Gateway 调用测试
npx super-agent-connector test --tool gmail_search --input '{"query":"from:boss"}'

# 打包
npx super-agent-connector package
# → my-connector.connector.zip

# 发布到市场（需要 API Key）
npx super-agent-connector publish --api-key xxx
```

## 7. 与现有架构的关系

```
connector-packages/          ← 平台内置的连接器（随代码部署）
    ├── gmail/
    ├── salesforce/
    └── ...

installed_connector_packages  ← 管理员通过 UI 安装的社区连接器（存 DB + S3）
    ├── airtable (zip in S3, Lambda deployed)
    ├── jira (zip in S3, Lambda deployed)
    └── ...

ConnectorRegistryService      ← 统一加载两个来源，合并为一个目录
    ├── loadBuiltIn()         ← 从 connector-packages/ 目录
    └── loadInstalled()       ← 从 installed_connector_packages 表
```

前端和其他服务不需要区分连接器是内置的还是社区安装的——`ConnectorRegistryService` 统一提供目录。
