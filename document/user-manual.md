# Super Agent Codex 用户使用手册

本文面向平台管理员、业务负责人和普通使用者，说明如何创建 Business Scope、配置 Agent、使用 Chat、运行 Workflow、管理 Skills/MCP，以及控制可用模型。

系统实现与数据边界见 [系统架构](architecture.md)，部署与运维见 [AWS ECS 部署文档](../infra/README.md)。

## 1. 平台概览

Super Agent Codex 用 Business Scope 组织企业 AI 能力。每个 Scope 可以拥有：

- Agent 团队与独立数字分身
- Scope 指令和经验记忆
- Skills、MCP 和知识库
- Chat session 与文件 workspace
- Workflow、Webhook、定时任务和人工审批
- 成员、用户组与访问权限

平台主要入口如下：

| 导航 | 用途 |
| --- | --- |
| Dashboard | 查看 Scope、Agent 和组织概览 |
| Chat | 与 Scope 团队或独立 Agent 对话 |
| Workflow | 设计、生成和执行业务流程 |
| Agents | 查看和配置 Agent |
| Tools | 管理 Skills、MCP 和工具目录 |
| Approvals | 处理 Workflow 人工审批 |
| Projects | 项目看板，可由管理员通过 Features 开启 |
| Knowledge | 文档和知识库，可由管理员通过 Features 开启 |
| Apps | 查看发布的内部应用，可由管理员通过 Features 开启 |
| Settings | 管理成员、模型、API Key、功能开关和外观 |

![Dashboard 示例](imgs/Screenshot%202026-04-01%20at%2015.59.31.png)

## 2. 登录与账号

### 2.1 登录

平台支持两种认证模式，具体由部署配置决定：

- **Local Auth**：使用用户名和密码登录。
- **Amazon Cognito**：跳转到组织的 Cognito 登录页完成认证。

首次部署的 local auth 环境通常会创建管理员账号。管理员应在首次登录后立即修改默认密码。

### 2.2 接受邀请

收到组织邀请后，打开邀请链接 `/invite/:token`：

1. 确认邀请的组织和账号。
2. 登录或完成账号创建。
3. 接受邀请并进入组织。

### 2.3 角色

| 角色 | 权限 |
| --- | --- |
| Owner | 组织所有者，可管理所有设置和成员 |
| Admin | 管理 Scope、Agent、模型、成员和系统配置 |
| Member | 使用被授权的 Scope、Agent、Workflow 和工具 |

Scope 还可以单独配置 viewer、editor、admin 等访问级别。

## 3. Dashboard 与 Business Scope

Business Scope 是平台的主要隔离单元，例如 Marketing、IT Operations、Human Resources。

### 3.1 创建 Business Scope

在 Dashboard 点击 **Create Team**，选择创建方式：

1. **参考 SOP 生成**：由 AI 根据业务领域生成初始 Scope、Agent 和 Skills。
2. **导入 SOP 文档**：上传 PDF、DOCX 或文本文件，系统从现有流程中提取角色和职责。
3. **自然语言创建**：描述业务、团队和目标，由 AI 生成结构化配置。

![创建 Business Scope](imgs/Screenshot%202026-04-01%20at%2016.03.28.png)

生成过程使用当前 Scope 或组织允许的模型。Bedrock GPT 由 Codex/AgentCore 执行；LiteLLM 模型由对应 adapter 执行。生成结果会在保存前进行结构校验。

### 3.2 Scope 访问控制

Scope 支持：

- **Open**：组织成员可见。
- **Restricted**：只有被授权成员可见。

管理员可以：

- 添加或移除 Scope 成员
- 设置 viewer、editor、admin 权限
- 通过用户组分配 Skills 和 MCP 访问
- 查看用户对 Agent 的显式或继承访问来源

### 3.3 Scope 配置

Scope 配置通常包括：

- 名称、描述、图标和颜色
- Scope system prompt
- 默认模型选择
- Agent 团队
- Skills 和 MCP
- Document Groups
- IM channel bindings
- Scope memory

在 Codex/AgentCore 模式下，旧 Claude Code plugin 仅显示兼容状态；未完成 Codex 兼容验证的 plugin 不能新增。需要扩展能力时，优先使用 Skills 或 MCP。

## 4. Agent 与数字分身

### 4.1 Agent 管理

进入 **Agents**，可以按 Scope 筛选并查看：

- 显示名称、角色和头像
- 状态与所属 Scope
- system prompt
- Skills、MCP 和知识权限
- 模型选择

Agent 的模型必须来自管理员允许列表。未授权模型无法通过 API 绕过前端使用。

### 4.2 创建或编辑 Agent

主要字段：

- **Internal Name**：稳定的内部标识。
- **Display Name**：用户可见名称。
- **Role**：职责说明。
- **System Prompt**：专业能力和行为要求。
- **Operational Scope**：业务范围标签。
- **Skills**：可读取和执行的技能包。
- **Model**：该 Agent 的 provider/model 选择。

保存后，平台会把 Agent 转换为 Codex subagent 定义：

```text
.codex/agents/<agent-name>.toml
```

平台生成的 Skills 提示属于派生内容，不会反复写回 Agent system prompt。

### 4.3 数字分身

从 Dashboard 点击 **Create Agent** 进入数字分身向导：

1. **Identity**：头像、名称、职位、背景和沟通风格。
2. **Knowledge**：上传专业文档并创建知识库。
3. **Skills**：选择或跳过初始 Skills。
4. **Publish**：确认配置并创建。

![创建数字分身](imgs/Screenshot%202026-04-01%20at%2016.03.45.png)

## 5. Chat

### 5.1 选择对话目标

进入 **Chat** 后选择：

- Business Scope：与该 Scope 的 Agent 团队对话。
- Independent Agent：直接与数字分身或独立 Agent 对话。

选择 Scope 后，可以在输入框中使用 `@AgentName` 指定 subagent。平台会展示 subagent spawn、wait、tool 和回复事件，而不是悄悄由主 Agent 代答。

### 5.2 选择模型

模型菜单只显示管理员在 **Settings > Models** 中启用并允许的模型：

- Bedrock `openai.gpt-5*`：使用 Codex/AgentCore。
- LiteLLM allowlist：使用配置的 LiteLLM provider。
- Bedrock Claude 不会出现在 Codex 可选列表中。

切换模型时，平台不会错误复用另一 runtime 的 provider thread。可恢复时使用原生 thread resume；无法恢复时使用有限的已持久化历史继续。

### 5.3 发送消息

支持：

- 文本和仅图片消息
- 粘贴图片或上传文件
- `@AgentName` 指定 subagent
- `@文件名` 引用 workspace 文件
- SSE 流式文本和实时工具时间线

Codex 可能以很细的 token delta 返回内容。Backend 会在不延迟工具事件的前提下合并短文本片段，因此中文回复不会每个汉字触发一次 UI 更新。

Chat 展示的是 Agent 回复、工具调用、工具结果和执行状态，不展示模型私有的隐藏推理。

### 5.4 停止生成

点击停止按钮会：

1. 请求 backend 中断当前 provider turn。
2. AgentCore/Codex 发送 `turn/interrupt`。
3. 浏览器停止读取 SSE。

仅关闭页面或网络断开不代表 provider turn 已被停止。

### 5.5 会话与恢复

- 历史 session 显示在左侧面板。
- session 持久化当前 runtime、provider thread、turn 和模型。
- 同一 provider 优先原生 resume。
- thread 丢失或 worker 变化时，平台使用有限历史重新建立 session。
- 不同 runtime 之间切换时不会交叉复用 thread。

### 5.6 Workspace 与产出

![Chat 与 workspace](imgs/Screenshot%202026-04-01%20at%2015.40.18.png)

右侧可切换：

- **Artifacts**：聚焦本次 session 生成的文档、图片、代码和应用。
- **Files**：查看完整 workspace 文件树。

支持：

- 查看和编辑文本文件
- Markdown、HTML、PDF、图片和 XLSX 预览
- 下载生成文件
- 检测并预览 Web App
- 将 workspace 应用发布到内部 Apps

系统配置文件使用 Codex canonical layout：

```text
AGENTS.md
.agents/skills/<skill>/SKILL.md
.codex/agents/<agent>.toml
.codex/config.toml
.codex/hooks.json
.runtime/mcp-servers.json
```

`memories/lessons.md` 只会在 Scope 确实存在经验记忆时生成和引用。

### 5.7 Save to Memory

点击 **Save to Memory**：

1. 系统总结当前 session。
2. 用户可以编辑标题和内容。
3. 保存为 Scope memory。
4. 后续 workspace 会在文件存在时加载该记忆。

### 5.8 Chat Room

Chat Room 支持多个 Agent：

- **Auto**：根据消息内容选择 Agent。
- **Mention**：只有明确 `@AgentName` 时路由。

每条回复会显示实际 speaker。无可用 Agent 或 runtime 失败时，平台返回显式错误，不会用无工具文本静默替代。

## 6. Workflow

进入 **Workflow** 使用可视化编辑器。

![Workflow 编辑器](imgs/Screenshot%202026-04-01%20at%2015.41.39.png)

### 6.1 节点类型

| 节点 | 用途 |
| --- | --- |
| Start | 流程入口与输入变量 |
| Agent | 需要 Agent 推理和工具的任务 |
| Action | 确定性操作、API 或数据处理 |
| Condition | 自动条件分支 |
| Human Approval | 暂停执行，等待人工批准或拒绝 |
| Document | 文档读取、生成或转换 |
| Code Artifact | 代码和应用产出 |
| End | 流程终点 |

人工审批不能用普通 Condition 代替。Workflow Copilot 生成的 plan 和 patch 会经过服务端结构校验后才能应用。

### 6.2 编辑 Workflow

1. 选择 Business Scope。
2. 创建或选择 Workflow。
3. 添加节点并连接执行顺序。
4. 配置 Prompt、变量和节点属性。
5. 保存画布。

也可以在 Copilot 中用自然语言：

- 生成完整 Workflow
- 添加、删除或调整步骤
- 修改标题和布局
- 把明确的人工审核语义转换为 Human Approval

### 6.3 执行模型

当前 V2 执行器使用统一 Agent runtime 驱动一段 Workflow：

- 节点是执行计划和进度边界。
- Agent 保持跨节点上下文。
- Workflow workspace 保存上游产出。
- 进度通过受控 `workflow-progress` MCP 和标准事件上报。
- `step_start`、`step_complete` 和 terminal 事件具有 exactly-once 保护。
- timeout 会中断 provider turn，并把整个 execution 标记为失败。

### 6.4 人工审批与恢复

执行到 Human Approval 时：

1. Workflow 状态变为 paused。
2. 在 **Approvals** 中查看上下文。
3. 批准或拒绝。
4. 批准后从 workspace snapshot 恢复并继续后续 segment。

### 6.5 其他触发方式

- 手动 Run
- Webhook
- Cron schedule
- API Key 调用

管理员应为自动化流程配置明确的 model、超时、权限和外部系统凭据。

## 7. Skills

Skill 是一组可复用的操作方法和领域指令，核心文件为：

```text
.agents/skills/<skill-name>/SKILL.md
```

### 7.1 使用 Skills

在 **Tools** 或 Agent 配置中可以：

- 浏览组织内部和 marketplace Skills
- 安装到组织
- 绑定到 Scope 或 Agent
- 编辑 `SKILL.md`
- 执行安全扫描
- 发布到企业内部目录

![Skills 列表](imgs/Screenshot%202026-04-01%20at%2015.40.32.png)

### 7.2 Carry-forward

Agent 在 session 中对 Skill 的有效修改可以回写平台。平台会：

- 区分组织级与 Scope 级同名 Skill
- 更新已有 Skill 的真实 S3 bucket
- 拒绝部分失败伪装成整体成功
- 避免把平台生成的提示写回业务 prompt

## 8. MCP 与 AgentCore Tools

### 8.1 MCP 类型

进入 **Tools** 或 **Config > MCP** 管理 MCP：

- **stdio**：命令、参数和环境变量。
- **Streamable HTTP**：远程 URL、headers 或 OAuth。

Legacy SSE transport 不属于当前 Codex 原生支持路径；需要先通过兼容 bridge 转为 Streamable HTTP。

### 8.2 MCP 管理

管理员可以：

- 创建、编辑和删除服务器
- 测试连接
- 绑定到 Scope
- 通过用户组控制访问
- 查看生成到 workspace 的 canonical config

```text
.runtime/mcp-servers.json
```

平台同步生成 Codex 项目配置，但 provider、认证和遥测等机器级设置不会写入项目级 `.codex/config.toml`。

### 8.3 Dedicated Browser

AgentCore Browser 用于：

- 打开网页
- 导航和读取页面
- 与 Web Bot Auth 配合访问启用签名的站点

生产部署使用 stack 专属 Browser identifier。模型即使提交共享 identifier，平台代理也会覆盖为专用资源。

### 8.4 Code Interpreter

AgentCore Code Interpreter 用于受控计算和代码执行。它与 Browser 使用独立专用资源，不依赖用户 workspace 的 shell 环境。

## 9. Knowledge

Knowledge 功能开启后，可以：

- 上传文档
- 创建 Document Group
- 绑定到 Scope 或数字分身
- 在 Chat 和 Workflow 中作为检索上下文

知识库负责检索已有文档；Skills 负责规定操作方法；workspace 负责当前 session 的可编辑文件。三者用途不同。

## 10. Projects、Apps 与 Support

这些导航项由 **Settings > Features** 控制：

- **Projects**：项目看板和任务协作。
- **Apps**：运行或发布 workspace 中生成的内部应用。
- **Support**：客服工作台、实时会话、知识和分析。
- **Starred/Showcase**：收藏和展示 session 或应用。

若导航中看不到对应入口，请先让管理员检查 feature toggle。

## 11. IM、Webhook 与 API

### 11.1 IM

平台包含 Slack、Discord、飞书、钉钉、Telegram 等 adapter。实际可用性取决于：

- Bot/App 凭据
- Webhook 校验配置
- Scope 或 Agent binding
- 平台公网回调地址

无 token 或 webhook 的测试 binding 不会被视为可投递配置。发送失败会显式报错。

### 11.2 Webhook

Workflow Webhook 可以让 CRM、工单系统或 CI/CD 触发执行。生产环境应启用签名校验，并限制调用方网络与权限。

### 11.3 API Keys

在 **Settings > API Keys** 创建 Key，并选择权限：

- `workflow:execute`
- `workflow:read`
- `workflow:write`
- `model:invoke`
- `mcp:tools`

Key 只在创建时完整显示。可以配置限速和过期时间。

## 12. 系统设置

进入用户头像菜单中的 **Settings**。

### 12.1 Members

- 邀请成员
- 修改组织角色
- 移除成员
- 查看 pending invitations

### 12.2 Groups

用户组用于批量管理成员，并为 Skills、MCP 或其他资源分配访问权限。

### 12.3 User Access

按用户查看 Agent 访问来源：

- 显式授权
- 创建者权限
- Scope membership
- Open Scope 或公共继承

### 12.4 Token Usage

查看模型 token 和使用趋势。Codex app-server 提供 token 统计但不一定返回美元成本；未知成本不会伪装成免费。

### 12.5 Organization

查看或修改组织名称、slug 和组织信息。部分字段仅 Owner 可修改。

### 12.6 Models

管理员在这里维护模型治理。

#### Amazon Bedrock

当前 Codex 主路径使用：

```text
openai.gpt-5*
```

将需要使用的模型加入 **Allowed Models**，并选择默认模型。

#### LiteLLM

填写：

- Base URL
- API Key
- Default Model
- Allowed Models

管理员可以读取 LiteLLM live catalog 并勾选允许项。Chat、Agent、Scope 和 Workflow 只使用保存后的 allowlist。

#### 重要规则

- Default Model 必须属于 Allowed Models。
- 禁用或无可用模型的 provider 不能设为组织默认。
- 直接提交未授权模型会返回验证错误。
- Bedrock Claude 不会作为 Codex 模型运行；Claude 模型应通过 LiteLLM 配置。

### 12.7 Features

控制 Projects、Knowledge、Apps、Support、Approvals 等可选导航和功能。

### 12.8 Appearance

- Light
- Dark
- Follow System
- 中文或 English

## 13. 常见问题

### Chat 中没有可选模型

请让管理员检查：

1. provider 是否启用。
2. Allowed Models 是否至少包含一个模型。
3. Default Model 是否位于 allowlist。
4. Bedrock 模型是否为 Codex 支持的 `openai.gpt-5*`。
5. LiteLLM Base URL 和 API Key 是否有效。

### Chat 看不到数据

- 强制刷新页面并重新登录。
- 开发环境确认 frontend 使用同源代理，而不是写死远端用户电脑的 `localhost:3001`。
- 检查 `/health/ready`。
- 确认用户拥有 Scope/Agent 访问权限。

### Agent 先读取不存在的 memory

当前版本只在 memory 文件确实存在时生成对应指令。若旧 session 仍出现该问题，重新创建或刷新 workspace，并检查 `AGENTS.md` 与 `memories/` 是否一致。

### 工具调用失败

- 查看 tool result，而不只看 tool start。
- 检查 Scope 是否绑定 MCP。
- 检查用户组访问权限。
- 检查 dedicated Browser/Code Interpreter 是否为 READY。
- 管理员查看 CloudWatch backend 与 AgentCore logs。

### 回复逐字显示

当前 backend 会把细粒度 Codex delta 合并成自然的小段落。若仍逐字显示，请确认 backend 已运行最新 revision，并清理浏览器缓存后新建 session。

### Workspace 修改没有回写

终态前平台必须完成 S3 同步和 carry-forward。若出现失败，Chat 会返回显式错误；管理员应检查 workspace bucket、Skill bucket 和权限，而不是忽略错误继续使用旧配置。

---

本文对应 2026-08-15 的 Codex/AgentCore 架构。界面中的可选模块可能因组织 feature toggles 和权限不同而有所差异。
