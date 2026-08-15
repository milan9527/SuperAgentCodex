# Super Agent Codex

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![AWS](https://img.shields.io/badge/AWS-AgentCore%20%2B%20Bedrock-FF9900?logo=amazon-web-services&logoColor=white)](https://aws.amazon.com/bedrock/agentcore/)

Super Agent Codex 是一个企业级、多租户、多智能体协作平台。它把业务域、Agent、Skills、MCP 工具、知识库和 Workflow 组织成可执行的 AI 工作空间，让业务团队可以通过 Chat 或可视化流程完成持续性的知识工作。

当前主架构以 Codex app-server 为核心执行协议，并在 AWS 上通过 Amazon Bedrock AgentCore 承载隔离运行时。

## 文档入口

- [用户使用手册](document/user-manual.md)
- [系统架构](document/architecture.md)
- [AWS ECS 部署与运维](infra/README.md)
- [Claude Agent SDK 到 Codex 的迁移规范](codex-sdk-migration/MIGRATION_SPEC.md)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| Business Scope | 按业务领域隔离 Agent、知识、Skills、MCP、Workflow 和访问权限 |
| Chat | SSE 流式对话、会话恢复、图片输入、文件工作区、工具时间线和停止执行 |
| Multi-Agent | `@mention` 指定 subagent，展示 spawn、wait、tool 和最终回复事件 |
| Workflow | 可视化流程、AI Copilot、人工审批、Webhook、定时任务和实时执行进度 |
| Skills | 使用标准 `SKILL.md` 组织可复用能力，并支持组织级与 Agent 级绑定 |
| MCP | 支持 stdio 和 Streamable HTTP MCP，并在 workspace 中生成可审计配置 |
| AgentCore Tools | 使用专用 Browser、Web Bot Auth 和 Code Interpreter 资源 |
| Workspace | 使用 Codex 原生布局，Agent 创建的业务文件可同步到 S3 并回写平台 |
| Model Governance | 管理员维护 provider 与模型 allowlist，Chat 不能绕过允许列表 |
| Enterprise Controls | 多租户、组织成员、Scope 权限、API Key、审计日志和可观测性 |

## 模型与运行时

模型不是按全局开关选择运行时，而是每次调用根据管理员配置进行路由。

| 管理员配置 | 执行路径 | 说明 |
| --- | --- | --- |
| Amazon Bedrock `openai.gpt-5*` | Codex app-server；生产环境使用 AgentCore | 原生 Responses 路径，支持工具、图片、thread resume 和 workspace |
| LiteLLM allowlist 中的模型 | Claude Agent SDK adapter | 用于管理员明确允许的 Claude 或其他 LiteLLM 模型 |
| Bedrock `anthropic.*` | 拒绝 | 不会把 Bedrock Claude 伪装成 Codex 模型，也不会静默 fallback |

Chat、Agent 和 Workflow 只展示 **Settings > Models** 中允许使用的模型。LiteLLM live catalog 仅供管理员配置 allowlist，不会直接暴露给普通用户。

## 架构概览

```mermaid
flowchart LR
    U[Web / IM / API] --> CF[CloudFront]
    CF --> FE[S3 Frontend]
    CF --> ALB[Application Load Balancer]
    ALB --> API[ECS Fargate Backend]

    API --> DB[(RDS PostgreSQL)]
    API --> REDIS[(ElastiCache Redis)]
    API --> S3[(S3: workspace / skills / avatars)]

    API --> ROUTER{Invocation runtime router}
    ROUTER -->|Bedrock openai.gpt-5*| AC[Bedrock AgentCore Runtime]
    AC --> CODEX[Codex app-server]
    CODEX --> BR[Bedrock OpenAI Responses]
    CODEX --> TOOLS[Dedicated Browser and Code Interpreter]

    ROUTER -->|LiteLLM allowlist| CLAUDE[Claude Agent SDK adapter]
    CLAUDE --> LLM[LiteLLM Gateway]
```

详细的请求时序、workspace 生命周期、数据边界和部署拓扑见 [系统架构](document/architecture.md)。

## Codex Workspace

平台只生成 Codex canonical layout，不再为新会话创建 `CLAUDE.md` 或 `.claude/`：

```text
workspace/
├── AGENTS.md
├── .agents/
│   └── skills/<skill-name>/SKILL.md
├── .codex/
│   ├── agents/<agent-name>.toml
│   ├── config.toml
│   └── hooks.json
├── .runtime/
│   └── mcp-servers.json
├── memories/                 # 仅在存在记忆时生成
└── app/                      # Agent 生成的应用或业务文件
```

平台安全 hook、路径校验和 S3 同步层会共同限制 workspace 外写入。AgentCore 终态只会在 workspace 同步成功后返回。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Frontend | React 19、Vite、TypeScript、Tailwind CSS、React Router、XY Flow |
| Backend | Fastify 5、TypeScript、Prisma 7、PostgreSQL、Redis、BullMQ |
| Agent Runtime | Codex CLI/app-server `0.146.0`、Amazon Bedrock AgentCore |
| Alternate Runtime | Claude Agent SDK，通过 LiteLLM provider 调用 |
| AI Provider | Amazon Bedrock OpenAI Responses、管理员配置的 LiteLLM Gateway |
| Storage | Amazon S3 workspace、skills、avatars、frontend buckets |
| Infrastructure | AWS CDK、ECS Fargate ARM64、ALB、CloudFront、RDS、ElastiCache、ECR |
| Observability | CloudWatch Logs，可选 Langfuse |

## 本地开发

### 前置条件

- Node.js `>=20.19`
- npm
- Docker 与 Docker Compose
- PostgreSQL 15+ 与 Redis 7+，或使用项目 Compose 服务
- 运行真实 Codex 时，需要可访问 Bedrock OpenAI Responses 模型的 AWS 凭据
- AgentCore 容器构建需要 `linux/arm64`；x86 主机可使用 Docker buildx/QEMU

### 1. 启动 PostgreSQL 与 Redis

```bash
cd backend
docker compose up -d postgres redis
```

### 2. 启动 Backend

```bash
cd backend
cp .env.example .env
```

至少设置：

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/super_agent?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
AWS_REGION=us-east-1
AGENT_RUNTIME=codex
```

安装依赖、初始化数据库并启动：

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npx tsx prisma/seed.ts
npx tsx prisma/seed-local-auth.ts
npm run dev
```

Backend 默认地址：`http://localhost:3001`

Readiness：`http://localhost:3001/health/ready`

### 3. 启动 Frontend

```bash
cd frontend
cp .env.example .env
npm ci
npm run dev
```

Frontend 默认地址：`http://localhost:5173`。开发模式默认使用同源 `/api`、`/v1` 和 `/ws` 代理，因此也适用于 IDE 端口转发。

### 4. 配置模型

使用管理员账号登录后进入 **Settings > Models**：

1. 启用或创建 Amazon Bedrock provider。
2. 将 `openai.gpt-5.4` 加入允许模型，并设为默认模型。
3. 如需使用 Claude 模型，添加 LiteLLM provider，从 live catalog 中勾选允许模型。

未加入 allowlist 的模型即使绕过前端直接提交，也会在 runtime 启动前被后端拒绝。

## 测试与质量门禁

```bash
# Backend
cd backend
npm run build
npm test
npm run codex:schema:check

# Frontend
cd frontend
npm run build
npm test

# AgentCore
cd agentcore
npm run build
npm test

# Infrastructure
cd infra
npm run build
npx cdk synth -c stackName=SuperAgentCodex -c enableCdn=true -c deployTarget=ecs
```

真实 Codex 与 AgentCore 审计脚本位于 `backend/scripts/`，包括本地 app-server、图片、MCP、thread resume、sandbox、Browser、Code Interpreter 和取消恢复测试。

## AWS 部署

推荐使用 ECS 主线：

```bash
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentCodex \
  --region us-east-1
```

部署脚本使用 immutable 镜像，创建新的 AgentCore Runtime，并且不会更新或删除已有 Runtime。数据库 migration、seed、ECS readiness 或 Runtime READY 任一失败都会中止发布。

完整参数、增量发布、资源检查和故障恢复见 [部署文档](infra/README.md)。
