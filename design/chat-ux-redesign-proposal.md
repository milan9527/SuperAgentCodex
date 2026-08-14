# Chat 模块 UX 重设计提案 — 面向非技术用户的对话式交互

> 降低技术门槛，让业务用户像使用 Perplexity 一样自然地与 AI 协作，同时保留高级用户的完整能力。

---

## 1. 问题陈述

当前 Chat 模块存在以下体验问题：

| 问题 | 影响 |
|------|------|
| Workspace 文件树暴露了技术细节（文件夹结构、文件扩展名） | 非技术用户困惑，不知道该关注什么 |
| 多交付物之间的切换依赖文件树导航 | 用户需要"找文件"而不是"看结果" |
| 知识库管理过于工程化 | 用户无法像管理网盘一样灵活组织资料 |
| 缺少对"当前焦点文档"的自动感知 | 右侧预览区不知道该展示什么 |

---

## 2. 设计目标

1. **结果前置** — 用户发出指令后，立即看到产出物，而非文件路径
2. **零学习成本** — 非技术用户无需理解文件系统即可使用
3. **多交付物流畅切换** — 通过对话流中的"查看"按钮在产出物之间切换
4. **双模式兼容** — 简洁模式 + 专业模式，一键切换
5. **知识库网盘化** — 像管理 Google Drive 一样管理知识库

---

## 3. 核心设计：左右分栏 + Artifact 卡片

### 3.1 整体布局

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Header: [Scope 选择器]  [模式切换: 简洁/专业]  [Session 历史]              │
├──────────────────────────────────┬──────────────────────────────────────────┤
│                                  │                                          │
│  左侧：对话流 (Chat Panel)        │  右侧：预览面板 (Preview Panel)           │
│  ─────────────────────────────   │  ────────────────────────────────────    │
│                                  │                                          │
│  [用户消息]                       │  ┌────────────────────────────────────┐  │
│  请帮我生成一份Q3销售分析报告      │  │  📄 Q3销售分析报告.docx             │  │
│                                  │  │  ──────────────────────────────    │  │
│  [AI 回复]                       │  │                                    │  │
│  好的，我已为您生成报告。          │  │  (文档预览内容)                     │  │
│                                  │  │                                    │  │
│  ┌──────────────────────────┐   │  │                                    │  │
│  │ 📄 Q3销售分析报告.docx    │   │  │                                    │  │
│  │ 文件生成完成              │   │  │                                    │  │
│  │         [查看] [下载]     │   │  │                                    │  │
│  └──────────────────────────┘   │  │                                    │  │
│                                  │  │                                    │  │
│  ┌──────────────────────────┐   │  │                                    │  │
│  │ 📊 销售趋势图.png        │   │  │                                    │  │
│  │ 文件生成完成              │   │  │                                    │  │
│  │         [查看] [下载]     │   │  │                                    │  │
│  └──────────────────────────┘   │  │                                    │  │
│                                  │  └────────────────────────────────────┘  │
│                                  │                                          │
│  ┌──────────────────────────┐   │  [Tab: Q3报告 | 销售趋势图 | +]          │
│  │ 💬 输入消息...            │   │                                          │
│  └──────────────────────────┘   │                                          │
│                                  │                                          │
├──────────────────────────────────┴──────────────────────────────────────────┤
│  Footer (optional)                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Artifact 卡片设计（左侧对话流中）

每当 AI 生成一个文件/文档，在对话流中插入一个 **Artifact 卡片**：

```
┌─────────────────────────────────────────────┐
│  📄 icon   文件名称                          │
│            文件类型 · 生成时间                │
│                                             │
│  [查看]  [下载]  [编辑]  [分享]              │
└─────────────────────────────────────────────┘
```

**交互行为：**
- 点击 **[查看]** → 右侧预览面板加载该文件，同时该卡片高亮表示"当前焦点"
- 点击 **[下载]** → 直接下载原始文件
- 点击 **[编辑]** → 右侧切换到编辑模式
- 最新生成的 Artifact 自动在右侧预览（无需用户点击）

### 3.3 右侧预览面板如何感知焦点文档

**焦点文档的确定逻辑（优先级从高到低）：**

1. **用户显式点击** — 用户点击了某个 Artifact 卡片的"查看"按钮
2. **最新生成** — AI 刚生成了新文件，自动切换到该文件预览
3. **AI 引用** — AI 回复中提到了某个已有文件（通过文件名匹配）
4. **上次查看** — 保持上次用户查看的文件

**数据流设计：**

```typescript
interface ArtifactFocusState {
  // 当前焦点文件
  activeArtifactId: string | null
  // 焦点来源（用于 UI 提示）
  focusSource: 'user-click' | 'auto-generated' | 'ai-reference' | 'last-viewed'
  // 所有 session 中的 artifacts
  artifacts: Artifact[]
}

interface Artifact {
  id: string
  name: string           // 显示名称（如"Q3销售分析报告"）
  fileName: string       // 实际文件名
  path: string           // workspace 路径
  type: ArtifactType     // document | spreadsheet | image | code | app
  generatedAt: string    // ISO timestamp
  messageId: string      // 关联的 AI 消息 ID
  status: 'generating' | 'completed' | 'error'
}
```

**前端状态管理：**

```typescript
// ChatContext 中新增 artifact 焦点管理
const [focusedArtifact, setFocusedArtifact] = useState<ArtifactFocusState>({
  activeArtifactId: null,
  focusSource: 'last-viewed',
  artifacts: [],
})

// 当 AI 生成新文件时自动聚焦
useEffect(() => {
  const latestArtifact = artifacts.filter(a => a.status === 'completed').at(-1)
  if (latestArtifact && latestArtifact.id !== focusedArtifact.activeArtifactId) {
    setFocusedArtifact({
      ...focusedArtifact,
      activeArtifactId: latestArtifact.id,
      focusSource: 'auto-generated',
    })
  }
}, [artifacts])
```

---

## 4. 双模式 Workspace

### 4.1 简洁模式（默认，面向非技术用户）

**设计原则：** 只展示"结果"，隐藏"过程"

```
┌─────────────────────────────────────────┐
│  📋 本次会话产出                         │
│  ─────────────────────────────────────  │
│                                         │
│  📄 Q3销售分析报告.docx        [查看]    │
│     2 分钟前生成                         │
│                                         │
│  📊 销售趋势对比图.png         [查看]    │
│     2 分钟前生成                         │
│                                         │
│  📋 行动计划.md                [查看]    │
│     1 分钟前生成                         │
│                                         │
│  ─────────────────────────────────────  │
│  共 3 个文件 · 本次会话                   │
└─────────────────────────────────────────┘
```

**特点：**
- 只显示当前 session 中新生成的文件
- 按时间倒序排列
- 不显示文件夹结构
- 文件名使用用户友好的显示名（非技术路径）
- 文件类型用图标区分，不显示扩展名（除非必要）

### 4.2 专业模式（面向技术用户）

保留现有的 `WorkspaceExplorer` 组件，完整的文件树结构。

### 4.3 模式切换

```
┌─────────────────────────────────────────┐
│  [📋 产出物]  [📁 文件管理]              │
│  ─────────────────────────────────────  │
│  (根据选中的 tab 显示不同内容)            │
└─────────────────────────────────────────┘
```

- 默认显示"产出物"视图（简洁模式）
- 用户可切换到"文件管理"视图（专业模式）
- 记住用户偏好（localStorage）

---

## 5. Perplexity 风格的交互借鉴

### 5.1 借鉴点

| Perplexity 特性 | 我们的适配 |
|----------------|-----------|
| 答案 + 来源分离 | AI 回复文本 + Artifact 卡片分离 |
| 来源引用标注 | 标注"基于知识库文档 X 生成" |
| Follow-up 建议 | 生成后推荐下一步操作（"要我修改格式吗？""需要翻译成英文吗？"） |
| 简洁的结果展示 | 折叠技术细节，只展示关键产出 |
| Pro Search 深度模式 | 类似我们的"专业模式"切换 |

### 5.2 AI 回复结构优化

**当前（技术化）：**
```
我已经在 workspace/output/reports/ 目录下生成了 q3-sales-report.docx 文件。
文件路径：/workspace/output/reports/q3-sales-report.docx
```

**优化后（用户友好）：**
```
已为您生成 Q3 销售分析报告 ✓

┌──────────────────────────────────┐
│ 📄 Q3销售分析报告                 │
│ Word 文档 · 12 页 · 刚刚生成     │
│                                  │
│ 📌 基于：销售数据.xlsx、市场报告   │
│                                  │
│ [查看]  [下载]                    │
└──────────────────────────────────┘

💡 建议下一步：
• 需要我调整报告格式吗？
• 要生成配套的 PPT 演示文稿吗？
• 需要翻译成英文版本吗？
```

---

## 6. 知识库网盘化设计

### 6.1 设计目标

让用户像使用 Google Drive / 百度网盘一样管理知识库，而非像配置"AI 数据源"。

### 6.2 界面布局

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  知识库                                          🔍 搜索文件...  [+ 上传]    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  📁 路径：全部文件 / 销售部 / 2024年报告                    [列表] [网格]     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  ☐  名称                    类型      大小     更新时间     标签         │ │
│  │  ─────────────────────────────────────────────────────────────────────  │ │
│  │  ☐  📁 Q1 报告              文件夹    —       2024-04-01   —           │ │
│  │  ☐  📁 Q2 报告              文件夹    —       2024-07-01   —           │ │
│  │  ☐  📄 年度总结.docx         Word     2.3MB   2024-12-15   #年报       │ │
│  │  ☐  📊 销售数据汇总.xlsx     Excel    1.1MB   2024-12-10   #数据       │ │
│  │  ☐  📋 客户清单.csv          CSV      456KB   2024-11-20   #客户       │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  选中 0 项    [移动] [复制] [删除] [添加标签] [分享]                          │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  💡 AI 建议：检测到 3 个文件内容相似，是否合并？                [查看详情]     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 核心功能

#### 文件夹自由组织
- 用户可自建任意层级的文件夹结构
- 支持拖拽移动文件/文件夹
- 支持批量操作（移动、复制、删除）
- 面包屑导航

#### 标签系统
- 用户可为文件打标签（如 #年报 #客户 #产品）
- 支持按标签筛选
- AI 自动建议标签（基于文件内容）

#### 搜索
- 全文搜索（文件名 + 文件内容）
- 按类型筛选（文档/表格/图片/PDF）
- 按时间范围筛选
- 按标签筛选

#### 版本管理
- 同一文件的多个版本自动保存
- 版本历史查看和回滚
- 显示版本差异

#### 权限与分享
- 文件夹级别的权限控制
- 支持分享给特定用户/用户组
- 公开/私有切换

#### 智能功能
- AI 自动识别文档间的关联关系
- 重复文件检测
- 自动分类建议
- 文件使用频率统计

### 6.4 数据模型扩展

```prisma
// 知识库文件夹结构
model knowledge_folders {
  id              String   @id @default(uuid()) @db.Uuid
  organization_id String   @db.Uuid
  parent_id       String?  @db.Uuid       // null = 根目录
  name            String   @db.VarChar(255)
  path            String   @db.VarChar(1024) // 完整路径，如 "/销售部/2024年报告"
  created_by      String?  @db.Uuid
  created_at      DateTime @default(now()) @db.Timestamptz
  updated_at      DateTime @default(now()) @updatedAt @db.Timestamptz

  parent          knowledge_folders?  @relation("FolderTree", fields: [parent_id], references: [id])
  children        knowledge_folders[] @relation("FolderTree")

  @@unique([organization_id, path])
  @@index([organization_id, parent_id])
}

// 知识库文件元数据（扩展现有 documents 表）
model knowledge_files {
  id              String   @id @default(uuid()) @db.Uuid
  organization_id String   @db.Uuid
  folder_id       String?  @db.Uuid       // 所属文件夹
  document_id     String   @db.Uuid       // 关联到现有 documents 表
  display_name    String   @db.VarChar(255) // 用户友好的显示名
  file_type       String   @db.VarChar(50)
  file_size       BigInt                   // bytes
  tags            String[] @default([])    // 标签数组
  is_starred      Boolean  @default(false) // 收藏
  version         Int      @default(1)
  created_by      String?  @db.Uuid
  created_at      DateTime @default(now()) @db.Timestamptz
  updated_at      DateTime @default(now()) @updatedAt @db.Timestamptz

  @@index([organization_id, folder_id])
  @@index([organization_id, tags], type: Gin)
}

// 文件版本历史
model knowledge_file_versions {
  id              String   @id @default(uuid()) @db.Uuid
  file_id         String   @db.Uuid
  version         Int
  s3_key          String   @db.VarChar(512)
  file_size       BigInt
  change_summary  String?  @db.VarChar(500)
  created_by      String?  @db.Uuid
  created_at      DateTime @default(now()) @db.Timestamptz

  @@index([file_id, version])
}

// 文件夹权限
model knowledge_folder_permissions {
  id              String   @id @default(uuid()) @db.Uuid
  folder_id       String   @db.Uuid
  grantee_type    String   @db.VarChar(20)  // 'user' | 'group' | 'org'
  grantee_id      String   @db.Uuid
  permission      String   @db.VarChar(20)  // 'read' | 'write' | 'admin'
  created_at      DateTime @default(now()) @db.Timestamptz

  @@unique([folder_id, grantee_type, grantee_id])
}
```

### 6.5 API 设计

```
# 文件夹操作
POST   /api/knowledge/folders              — 创建文件夹
GET    /api/knowledge/folders              — 列出文件夹（支持 parentId 参数）
PUT    /api/knowledge/folders/:id          — 重命名/移动文件夹
DELETE /api/knowledge/folders/:id          — 删除文件夹

# 文件操作
POST   /api/knowledge/files/upload         — 上传文件（支持多文件）
GET    /api/knowledge/files                — 列出文件（支持 folderId、tags、search 参数）
PUT    /api/knowledge/files/:id            — 更新文件元数据（重命名、移动、打标签）
PUT    /api/knowledge/files/:id/move       — 移动文件到其他文件夹
DELETE /api/knowledge/files/:id            — 删除文件
POST   /api/knowledge/files/batch          — 批量操作（移动、删除、打标签）

# 搜索
GET    /api/knowledge/search?q=xxx&type=xxx&tags=xxx

# 版本
GET    /api/knowledge/files/:id/versions   — 获取版本历史
POST   /api/knowledge/files/:id/revert/:version — 回滚到指定版本

# 标签
GET    /api/knowledge/tags                 — 获取所有标签（含使用计数）
```

---

## 7. 实现路线图

### Phase 1：Artifact 卡片 + 焦点感知（1-2 周）

- [ ] 定义 `Artifact` 数据结构和 `ArtifactFocusState`
- [ ] 实现 `ArtifactCard` 组件（对话流中的文件卡片）
- [ ] 实现焦点文档自动切换逻辑
- [ ] 右侧预览面板响应焦点变化
- [ ] 后端：AI 生成文件时返回 artifact 元数据

### Phase 2：简洁模式 Workspace（1 周）

- [ ] 实现 `ArtifactListPanel` 组件（简洁模式的产出物列表）
- [ ] 实现模式切换 UI（产出物 / 文件管理 tab）
- [ ] 用户偏好持久化

### Phase 3：AI 回复结构优化（1 周）

- [ ] 优化 AI 回复格式（隐藏技术路径，展示友好名称）
- [ ] 实现"建议下一步"功能
- [ ] 实现知识库来源引用标注

### Phase 4：知识库网盘化（2-3 周）

- [ ] 数据库 schema 迁移（文件夹、标签、版本）
- [ ] 后端 API 实现
- [ ] 前端文件夹浏览器组件
- [ ] 拖拽上传 + 批量操作
- [ ] 标签系统
- [ ] 搜索功能

### Phase 5：高级功能（2 周）

- [ ] 版本历史 UI
- [ ] 文件夹权限管理
- [ ] AI 智能建议（自动标签、重复检测、关联推荐）
- [ ] 网格视图 / 列表视图切换

---

## 8. 竞品参考

| 产品 | 借鉴点 |
|------|--------|
| Perplexity | 结果前置、来源引用、Follow-up 建议 |
| 截图中的产品 | Artifact 卡片 + 查看按钮、左右分栏 |
| Google Drive | 文件夹组织、搜索、分享、版本历史 |
| Notion | 标签系统、灵活的视图切换 |
| ChatGPT Canvas | 右侧编辑面板、实时预览 |

---

## 9. 技术影响评估

### 前端改动
- 新增组件：`ArtifactCard`、`ArtifactListPanel`、`KnowledgeDriveView`
- 修改组件：`Chat.tsx`（布局调整）、`ChatContext.tsx`（新增 artifact 状态）
- 新增页面：重构 `KnowledgeManager.tsx`

### 后端改动
- 新增 API：知识库文件夹/文件 CRUD、搜索、版本管理
- 数据库迁移：新增 3-4 张表
- AI 回复格式：调整 prompt 模板，输出 artifact 元数据

### 不影响的部分
- 现有的 workspace 文件系统（保留为专业模式）
- 现有的 chat streaming 逻辑
- 现有的 scope/agent 选择逻辑

---

## 10. 设计决策记录

| # | 问题 | 决策 |
|---|------|------|
| 1 | 简洁模式是否作为默认？ | **是。** 所有用户默认简洁模式，可随时切换到专业模式。不区分新老用户。 |
| 2 | Artifact 卡片是否支持实时进度？ | **暂不实现。** 当前阶段：文件生成完成后才显示"查看"按钮。进度条作为后续迭代。 |
| 3 | 知识库与 Scope 的关系？ | **知识库独立存在，Scope 通过绑定引用。** 知识库是独立的资源，Scope/Agent 配置时可绑定一个或多个知识库。知识库持续更新时，session 中获取到的始终是最新内容。现有知识库需与 Scope 解耦重构。 |
| 4 | 移动端适配？ | **Responsive 即可。** 不追求移动端完美设计，确保基本可用（左右分栏在窄屏自动堆叠）。 |

---

## 11. 知识库与 Scope 解耦设计

### 11.1 当前问题

现有设计中知识库文档直接挂在 Scope 下，导致：
- 同一份文档无法被多个 Scope 复用
- 知识库无法独立管理和迭代
- 用户心智模型混乱（"我的文档在哪个 Scope 下？"）

### 11.2 目标架构

```
┌──────────────────┐         ┌──────────────────┐
│   知识库 A        │         │   知识库 B        │
│   (销售资料)      │         │   (产品文档)      │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         │  绑定                       │  绑定
         ▼                            ▼
┌──────────────────┐         ┌──────────────────┐
│   Scope X        │         │   Scope Y        │
│   (销售助手)      │◄────────│   (产品顾问)      │
│                  │  也绑定B  │                  │
└──────────────────┘         └──────────────────┘
```

- 知识库是**独立的一级资源**，有自己的 CRUD、文件夹结构、权限
- Scope/Agent 配置中通过 `knowledge_base_ids[]` 绑定一个或多个知识库
- 一个知识库可以被多个 Scope 共享
- 知识库更新后，所有绑定的 Scope 自动获取最新内容

### 11.3 数据模型变更

```prisma
// 知识库（独立一级资源）
model knowledge_bases {
  id              String   @id @default(uuid()) @db.Uuid
  organization_id String   @db.Uuid
  name            String   @db.VarChar(255)
  description     String?  @db.VarChar(1000)
  icon            String?  @db.VarChar(10)   // emoji icon
  status          String   @default("active") @db.VarChar(50)
  document_count  Int      @default(0)
  total_size      BigInt   @default(0)       // bytes
  created_by      String?  @db.Uuid
  created_at      DateTime @default(now()) @db.Timestamptz
  updated_at      DateTime @default(now()) @updatedAt @db.Timestamptz

  @@index([organization_id])
}

// Scope 与知识库的绑定关系（多对多）
model scope_knowledge_bindings {
  id                String   @id @default(uuid()) @db.Uuid
  scope_id          String   @db.Uuid
  knowledge_base_id String   @db.Uuid
  bound_at          DateTime @default(now()) @db.Timestamptz
  bound_by          String?  @db.Uuid

  @@unique([scope_id, knowledge_base_id])
  @@index([scope_id])
  @@index([knowledge_base_id])
}
```

### 11.4 迁移策略

1. 创建 `knowledge_bases` 表
2. 为每个现有 Scope 的知识库文档自动创建一个同名知识库
3. 将现有文档迁移到对应知识库下
4. 创建 `scope_knowledge_bindings` 记录，保持现有绑定关系
5. 前端切换到新的知识库管理界面
6. 废弃旧的 Scope 内嵌知识库 UI

### 11.5 Scope 配置界面变更

Scope 配置页面中，知识库部分从"上传文档"变为"绑定知识库"：

```
┌─────────────────────────────────────────────────────────────┐
│  知识库配置                                                   │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  已绑定的知识库：                                            │
│                                                             │
│  📚 销售资料库          128 个文件 · 最近更新 2小时前  [解绑]  │
│  📚 产品文档库          45 个文件 · 最近更新 1天前     [解绑]  │
│                                                             │
│  [+ 绑定知识库]                                              │
│                                                             │
│  💡 绑定后，该 Scope 下的 Agent 可以检索知识库中的所有文档。   │
│     知识库更新时无需重新配置。                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 12. 知识库规模化能力分析

### 12.1 各环节的规模瓶颈与应对

| 环节 | 百级文档 | 千级文档 | 万级文档 | 应对方案 |
|------|---------|---------|---------|---------|
| 文件列表加载 | 直接返回 | 分页 | 分页 + 虚拟滚动 | API 分页（limit/offset），前端虚拟列表 |
| 文件夹树渲染 | 全量加载 | 全量可行 | 懒加载子目录 | 按需展开，只加载当前层级 |
| 全文搜索 | PG `tsvector` | PG 可应对 | 需专用搜索引擎 | Phase 1 用 PG，万级时引入 OpenSearch |
| 向量化（RAG 索引） | 同步完成 | 异步队列 | 异步 + 增量索引 | 上传时入队，后台 worker 处理 |
| RAG 检索（Agent 查询时） | 全库搜索 | namespace 过滤 | namespace + metadata filter | 按 knowledge_base_id 做向量 namespace 隔离 |
| S3 存储 | 无限 | 无限 | 无限 | S3 本身无瓶颈 |
| 数据库查询 | 无压力 | 索引优化 | 复合索引 + 分区 | 已在 schema 中预设索引 |

### 12.2 关键设计决策（为规模化预埋）

**1. 向量化必须异步 + 增量**

```
用户上传文件 → 写入 S3 + DB 元数据 → 立即返回成功
                                    ↓
                              入队 embedding job
                                    ↓
                        后台 worker 分块 + 向量化
                                    ↓
                          写入向量数据库（带 namespace）
```

- 不阻塞用户操作
- 文件状态：`uploaded` → `indexing` → `indexed` / `index_failed`
- 支持重试失败的 job

**2. 向量 namespace 隔离**

每个知识库有独立的 namespace（即 `knowledge_base_id`），检索时只在绑定的知识库 namespace 内搜索：

```typescript
// Agent 检索时
const results = await vectorStore.search({
  query: userQuestion,
  namespaces: scope.boundKnowledgeBaseIds,  // 只搜绑定的知识库
  topK: 10,
  filter: { status: 'indexed' },
})
```

**3. 列表 API 必须分页**

```typescript
// GET /api/knowledge/files?folderId=xxx&page=1&pageSize=50&sort=updatedAt&order=desc
interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}
```

**4. 搜索分层策略**

- **Phase 1（千级以下）：** PostgreSQL `tsvector` + `GIN` 索引，够用
- **Phase 2（千级以上）：** 引入 OpenSearch，文件上传时同步写入搜索索引
- 前端搜索 API 不变，后端切换实现即可

### 12.3 预估资源消耗（万级文档）

| 资源 | 估算 |
|------|------|
| S3 存储 | ~50GB（假设平均 5MB/文件） |
| PostgreSQL 行数 | ~10K 行（knowledge_files 表） |
| 向量数据库 | ~500K vectors（假设平均 50 chunks/文件） |
| Embedding 成本 | 一次性 ~$50-100（OpenAI ada-002），增量可忽略 |
| 搜索延迟 | <200ms（namespace 过滤后） |

---

## 13. AgentCore 集成路径

### 13.1 问题

AgentCore Runtime 的 session 运行在隔离的 microVM 中，无法直接访问我们的 PostgreSQL 或 S3。Agent 需要一种方式在 runtime 内查询知识库。

### 13.2 集成方案（分阶段）

#### 短期方案：MCP Tool 暴露知识库检索（当前可实现）

将知识库检索封装为一个 MCP tool，Agent 在 runtime 内通过 tool call 查询：

```
┌─────────────────────────────────────────────────────────────┐
│  AgentCore Runtime (microVM)                                 │
│                                                             │
│  Agent ──── tool_call: search_knowledge ────→ MCP Gateway   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                                                      │
                                                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Our Backend (Lambda / API)                                  │
│                                                             │
│  1. 接收查询请求                                             │
│  2. 确定 scope 绑定的 knowledge_base_ids                     │
│  3. 向量检索（namespace 过滤）                               │
│  4. 返回相关文档片段                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Tool 定义：**

```json
{
  "name": "search_knowledge",
  "description": "搜索知识库中的相关文档",
  "parameters": {
    "query": { "type": "string", "description": "搜索查询" },
    "top_k": { "type": "integer", "default": 5 },
    "knowledge_base_ids": { "type": "array", "items": { "type": "string" } }
  }
}
```

**优点：** 无需等待 AgentCore 原生支持，现在就能实现
**缺点：** 每次检索有网络延迟（~200-500ms）

#### 中期方案：AgentCore Gateway Target

通过 AgentCore Gateway 将我们的知识库 API 注册为 target：

- 创建 Gateway，添加 Lambda target 指向我们的检索 API
- Agent runtime 通过 Gateway 调用，享受 AgentCore 的认证和限流
- 无需在 agent 代码中硬编码 API endpoint

#### 长期方案：AgentCore Memory 同步

当 AgentCore Memory 的 semantic search 能力成熟后：

- 将知识库文档同步到 AgentCore Memory（作为 memory records）
- Agent 直接使用 `memory_retrieve_records` 检索
- 利用 AgentCore 原生的向量索引能力

### 13.3 当前实施建议

**先开发知识库本身的完整功能（文件夹管理、标签、搜索、版本），不依赖 AgentCore 集成。**

Agent 侧的集成通过 MCP tool 方式实现，这是一个松耦合的方案：
- 知识库独立演进
- Agent 通过标准 tool call 接口查询
- 后续切换到 Gateway 或 Memory 方案时，只需改后端实现，Agent 侧无感知


---

## 14. 与现有 RAG/Auth 基础设施的衔接

> 基于 commit `f8416e4`（feat: add backend connectivity for RAG and skill API calls）的分析。

### 14.1 现有基础设施（可直接复用）

最新 commit 已经建立了 AgentCore 容器调用后端 API 的完整链路：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AgentCore Runtime (microVM)                                             │
│                                                                         │
│  环境变量:                                                               │
│    API_BASE_URL = "https://api.example.com"                             │
│    AUTH_TOKEN   = "internal.eyJ...payload...sig"                        │
│                                                                         │
│  Agent 执行 skill (knowledge-search.md):                                │
│    curl -s -H "Authorization: Bearer $AUTH_TOKEN" \                     │
│      "$API_BASE_URL/api/rag/search?scope_id=xxx&q=xxx&top_k=5"         │
│                                                                         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ HTTPS
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Backend API                                                             │
│                                                                         │
│  authenticate() 中间件:                                                  │
│    → 识别 "internal.xxx.xxx" 格式                                        │
│    → verifyInternalToken() 验证 HMAC 签名 + 过期时间                     │
│    → 注入 request.user (userId, orgId, role)                            │
│                                                                         │
│  GET /api/rag/search:                                                    │
│    → ragRetrieverService.retrieve(query, scopeId, topK)                 │
│    → 向量相似度搜索 → 返回 JSON results                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**可复用的组件：**

| 组件 | 位置 | 复用方式 |
|------|------|---------|
| 内部 token 生成 | `middleware/auth.ts` → `createToken()` | 知识库 API 使用相同认证机制 |
| 内部 token 验证 | `middleware/auth.ts` → `verifyInternalToken()` | 已集成在 `authenticate` 中间件中 |
| 向量检索 | `services/rag/rag-retriever.service.ts` | 扩展支持 `knowledge_base_ids` 参数 |
| Skill 生成 | `services/workspace-manager.ts` → `buildRagSkillContent()` | 改为传入 knowledge_base_ids |
| 容器环境注入 | `services/agent-runtime-agentcore.ts` | 已自动注入 `backend_api_url` + `backend_api_key` |

### 14.2 需要改造的部分

#### 14.2.1 RAG Retriever 扩展

当前 `RagRetrieverService.retrieve()` 的查询路径：

```
scope_id → scope_document_groups 表 → document_group_ids → document_chunks 表
```

解耦后新增一个方法，支持直接按知识库 ID 查询：

```typescript
// rag-retriever.service.ts — 新增方法

/**
 * Search by knowledge base IDs directly (decoupled from scope).
 * Used when the caller already knows which knowledge bases to search.
 */
async retrieveByKnowledgeBases(
  query: string,
  knowledgeBaseIds: string[],
  topK = 5,
  minSimilarity = 0.5,
): Promise<RAGResult[]> {
  if (knowledgeBaseIds.length === 0) return [];

  // 通过 knowledge_base_document_groups 关联表获取 document_group_ids
  const bindings = await prisma.knowledge_base_document_groups.findMany({
    where: { knowledge_base_id: { in: knowledgeBaseIds } },
    select: { document_group_id: true },
  });

  if (bindings.length === 0) return [];
  const groupIds = [...new Set(bindings.map(b => b.document_group_id))];

  // 复用现有的向量搜索逻辑
  const embedding = await embedText(query);
  const vecLiteral = `[${embedding.join(',')}]`;
  // ... 同现有 retrieve() 逻辑
}
```

#### 14.2.2 RAG 路由扩展

在 `rag.routes.ts` 中新增支持 `knowledge_base_ids` 参数的端点：

```typescript
// rag.routes.ts — 新增或扩展

/** GET /api/rag/search — 扩展支持 knowledge_base_ids 参数 */
// 兼容两种调用方式：
//   1. ?scope_id=xxx (旧方式，通过 scope → document_groups 查找)
//   2. ?knowledge_base_ids=kb1,kb2 (新方式，直接指定知识库)
fastify.get('/search', { preHandler: [authenticate] }, async (request, reply) => {
  const { scope_id, knowledge_base_ids, q, top_k, min_similarity } = request.query;

  if (knowledge_base_ids) {
    // 新路径：直接按知识库 ID 查询
    const ids = knowledge_base_ids.split(',');
    const results = await ragRetrieverService.retrieveByKnowledgeBases(
      q, ids, parseInt(top_k || '5'), parseFloat(min_similarity || '0.5')
    );
    return reply.send({ data: results });
  }

  if (scope_id) {
    // 旧路径：通过 scope 查找绑定的知识库，再查询
    // Phase 1: 保持现有逻辑（scope → document_groups）
    // Phase 2: 改为 scope → scope_knowledge_bindings → knowledge_bases → document_groups
    const results = await ragRetrieverService.retrieve(q, scope_id, ...);
    return reply.send({ data: results });
  }

  return reply.status(400).send({ error: 'scope_id or knowledge_base_ids required' });
});
```

#### 14.2.3 Skill 生成改造

`buildRagSkillContent()` 改为传入知识库 ID 列表而非 scope_id：

```typescript
// workspace-manager.ts — 改造

private buildRagSkillContent(backendUrl: string, knowledgeBaseIds: string[]): string {
  const kbParam = knowledgeBaseIds.join(',');
  // ...
  if (isRemote) {
    lines.push(
      '```bash',
      `curl -s -H "Authorization: Bearer $AUTH_TOKEN" \\`,
      `  "${backendUrl}/api/rag/search?knowledge_base_ids=${kbParam}&q={URL_ENCODED_QUERY}&top_k=5"`,
      '```',
    );
  }
  // ...
}
```

Session 创建时，从 scope 的绑定关系获取知识库 ID：

```typescript
// workspace provisioning 中
const bindings = await prisma.scope_knowledge_bindings.findMany({
  where: { scope_id: scope.id },
  select: { knowledge_base_id: true },
});
const knowledgeBaseIds = bindings.map(b => b.knowledge_base_id);

if (knowledgeBaseIds.length > 0) {
  const ragSkillContent = this.buildRagSkillContent(backendUrl, knowledgeBaseIds);
  await writeFile(ragSkillPath, ragSkillContent, 'utf-8');
}
```

### 14.3 数据模型补充

在第 11.3 节的模型基础上，新增知识库与 document_groups 的关联：

```prisma
// 知识库包含哪些 document groups（一个知识库可以有多个 group）
model knowledge_base_document_groups {
  id                String   @id @default(uuid()) @db.Uuid
  knowledge_base_id String   @db.Uuid
  document_group_id String   @db.Uuid
  added_at          DateTime @default(now()) @db.Timestamptz

  @@unique([knowledge_base_id, document_group_id])
  @@index([knowledge_base_id])
  @@index([document_group_id])
}
```

这样 document_groups 作为底层存储单元保持不变，知识库是上层的逻辑组织单元。

### 14.4 迁移路径（渐进式，不破坏现有功能）

```
Phase A: 新增表 + 新增 API（不改现有逻辑）
─────────────────────────────────────────────
1. 创建 knowledge_bases 表
2. 创建 scope_knowledge_bindings 表
3. 创建 knowledge_base_document_groups 表
4. 新增 retrieveByKnowledgeBases() 方法
5. RAG 路由支持 knowledge_base_ids 参数
6. 现有 scope_id 路径继续工作（不动）

Phase B: 数据迁移（自动化脚本）
─────────────────────────────────────────────
7. 为每个有 document_groups 的 scope 创建同名知识库
8. 将 scope_document_groups 记录复制到 knowledge_base_document_groups
9. 创建 scope_knowledge_bindings 记录

Phase C: 切换调用路径
─────────────────────────────────────────────
10. buildRagSkillContent() 改用 knowledge_base_ids
11. 前端知识库管理界面上线
12. Scope 配置页面改为"绑定知识库"

Phase D: 清理（确认稳定后）
─────────────────────────────────────────────
13. 废弃 scope_document_groups 表（或保留为兼容层）
14. 移除旧的 scope 内嵌知识库 UI
```

### 14.5 总结

最新 commit 提供的 RAG API + 内部 token 认证机制是知识库解耦的**完美基础设施**。我们不需要重新设计认证和检索的底层，只需要：

1. 在 retriever 层新增按 `knowledge_base_ids` 查询的方法
2. 在路由层扩展参数支持
3. 在 workspace provisioning 时从 scope 绑定关系获取知识库 ID
4. 渐进式迁移数据，不破坏现有功能
