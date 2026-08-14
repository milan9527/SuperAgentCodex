# Super Agent Infra — 部署指南

## 概述

本项目提供三种部署方式：

- **ECS 一键部署**（推荐）：`deploy-full-ecs.sh` 使用 ECS Fargate 运行后端，无需 SSH/EC2，约 15-20 分钟
- **EC2 一键部署**：`deploy-full.sh` 使用 EC2 实例运行后端，需要 SSH Key，约 20-30 分钟
- **分步部署**：手动执行 CDK、`deploy.sh`、AgentCore 各阶段

### 架构（ECS 模式）

```
用户 → CloudFront → S3 (前端静态文件)
                  → ALB → ECS Fargate (API /api/*, WebSocket /ws/*)
                              → Node.js 后端 (port 3000)
                              → RDS PostgreSQL
                              → ElastiCache Redis
                              → Bedrock AgentCore Runtime (容器化 Agent)
```

### 架构（EC2 模式）

```
用户 → CloudFront → S3 (前端静态文件)
                  → EC2 Nginx (API /api/*, WebSocket /ws/*)
                       → Node.js 后端 (port 3000)
                       → RDS PostgreSQL
                       → ElastiCache Redis
                       → Bedrock AgentCore Runtime (容器化 Agent)
```

## 前置条件

> ⚠️ **部署脚本必须在 ARM64 (AWS Graviton / Apple Silicon) 机器上运行。**
> 后端 ECS 任务和 AgentCore Runtime 都要求 `linux/arm64` 镜像，AgentCore Runtime **只接受 ARM64**。在 ARM 主机上为原生构建，速度快且可靠。
> 推荐在一台 **Graviton EC2 实例**（如 `t4g` / `c7g` / `m7g`，Amazon Linux 2023 或 Ubuntu）上执行部署。
>
> 在 x86_64 主机上，脚本会自动配置 QEMU（`tonistiigi/binfmt`）做交叉构建，但**明显更慢且偶发不稳定**，不推荐用于正式部署。脚本会在推送后校验 AgentCore 镜像确为 arm64，架构不符会报错退出。

| 工具 | 用途 | ECS 模式 | EC2 模式 |
|------|------|:--------:|:--------:|
| **ARM64 (Graviton) 构建主机** | 构建 arm64 镜像（AgentCore 仅支持 ARM64） | ✅ | ✅ |
| AWS CLI v2 | 基础设施操作 | ✅ | ✅ |
| Node.js 22+ | 前端构建 | ✅ | ✅ |
| Docker (含 buildx) | 后端 + AgentCore 容器构建 | ✅ | ✅ |
| SSM Session Manager 插件 | SSH 隧道 | — | ✅ |
| EC2 Key Pair | SSH 访问 | — | ✅ |

确认 AWS 身份与构建主机架构：

```bash
aws sts get-caller-identity
uname -m   # 期望 aarch64 / arm64（Graviton）；x86_64 需 QEMU 交叉构建（不推荐）
```

## ECS 一键部署（推荐）

ECS 模式使用 Fargate 运行后端容器，无需管理 EC2 实例、SSH Key 或 Nginx。
前端始终通过 S3 + CloudFront 提供服务，**无需自定义域名**——CloudFront 会分配一个默认的 `https://xxxx.cloudfront.net` 域名（自动 HTTPS，无需 ACM 证书或 Route53）。

### 用法

```bash
./infra/scripts/deploy-full-ecs.sh --stack <名称> --region <区域>
```

只需指定 stack 名称和区域即可，其余全部自动完成（引擎版本、镜像架构、数据库迁移与 seed 都由脚本处理）。

### 示例

```bash
cd /path/to/super-agent

# 基础用法：全新部署到 us-east-1
./infra/scripts/deploy-full-ecs.sh --stack SuperAgentDev1 --region us-east-1

# 换个区域 / 用另一个 stack 名（不同 stack 资源完全隔离）
./infra/scripts/deploy-full-ecs.sh --stack SuperAgentProd --region us-west-2
```

部署完成后，脚本会打印访问地址（CloudFront 默认域名），用 `admin@example.com` / `admin123` 登录。

### 可选参数

```bash
--stack <name>          # Stack 名称（默认 SuperAgent），不同 stack 完全隔离
--region <region>       # AWS Region（默认 us-west-2）
--bedrock-ak <key>      # 跨账号 Bedrock 凭证（可选）
--bedrock-sk <secret>   # 跨账号 Bedrock 凭证（可选）
--skip-cdk              # 跳过基础设施（已有 stack 时用）
--skip-agentcore        # 跳过 AgentCore 容器部署
--skip-frontend         # 跳过前端构建
--skip-backend          # 跳过后端构建
```

### ECS 部署流程（4 个阶段）

**Phase 1: CDK Deploy**
- 脚本自动探测当前区域可用的引擎版本（RDS PostgreSQL 16.x、ElastiCache Redis 7.x），避免硬编码版本在某些区域不可用
- 创建 VPC Security Groups、ECS Cluster、ALB
- RDS PostgreSQL、ElastiCache Redis
- S3 桶（Avatar、Skills、Workspace、Frontend）
- CloudFront（默认 `*.cloudfront.net` 域名，无需 ACM/Route53）
- IAM Roles（ECS Task Execution + Task Role，含 Bedrock 调用与模型列举权限）
- ECS Service（初始 desiredCount=0，等待真实镜像）

**Phase 2: Backend Deploy**
- 构建后端 Docker 镜像（ARM64）→ 推送到 ECR
- 从 SecretsManager 获取 RDS 凭证
- 通过 ECS run-task 执行 Prisma 迁移 + 数据库 seed（幂等，可重复执行）
- 注册 ECS Task Definition（含所有环境变量）
- 更新 ECS Service → 等待服务稳定
- 首次部署自动创建 admin 用户：`admin@example.com` / `admin123`

**Phase 3: Frontend Deploy**
- 构建前端（Vite）→ S3 sync + CloudFront 失效

**Phase 4: AgentCore Setup**
- 创建 ECR 仓库，构建推送 AgentCore ARM64 Docker 镜像（脚本会校验推送镜像确为 arm64，AgentCore Runtime 仅支持 ARM64）
- 创建 IAM Execution Role（Bedrock、S3、ECR、Browser、Code Interpreter 权限）
- 创建 Bedrock AgentCore Runtime（使用 global inference profile）
- 更新 ECS Task Definition 启用 AgentCore 模式

> 在 x86 主机上部署时，脚本会自动配置 QEMU（`tonistiigi/binfmt`）以交叉构建 ARM64 镜像；在 ARM 主机（如 Apple Silicon、Graviton）上则原生构建。

### ECS 部署完成后

部署结束时脚本会打印 App URL（形如 `https://xxxx.cloudfront.net`），使用 `admin@example.com` / `admin123` 登录。

> CloudFront 首次分发全球生效约需 5-15 分钟。

查看后端日志（日志组名含 stack 名，小写）：

```bash
aws logs tail /super-agent/<stack名小写>/ecs-backend --region <region> --follow
```

> **重要**：首次登录后请立即修改 admin 密码。

### ECS 增量部署

```bash
# 只部署代码（跳过 CDK 和 AgentCore）
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd --skip-cdk --skip-agentcore

# 只更新后端
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd --skip-cdk --skip-agentcore --skip-frontend

# 只更新前端
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd --skip-cdk --skip-agentcore --skip-backend
```

---

## EC2 一键部署

### 带自定义域名（CloudFront CDN）

需要 Route53 托管的域名和 EC2 Key Pair：

```bash
aws ec2 describe-key-pairs --query "KeyPairs[].KeyName" --region us-west-2
```

执行部署：

```bash
cd /path/to/super-agent

./infra/scripts/deploy-full.sh ~/Downloads/my-key.pem \
  --stack SuperAgentProd \
  --region us-west-2 \
  --domain app.example.com \
  --hosted-zone-id Z01234567890ABC
```

### EC2 可选参数

```bash
--stack <name>          # Stack 名称（默认 SuperAgent），不同 stack 完全隔离
--region <region>       # AWS Region（默认 us-west-2）
--bedrock-ak <key>      # 跨账号 Bedrock 凭证（可选）
--bedrock-sk <secret>   # 跨账号 Bedrock 凭证（可选）
--skip-cdk              # 跳过基础设施（已有 stack 时用）
--skip-agentcore        # 跳过 AgentCore 容器部署
--skip-frontend         # 跳过前端构建
--skip-backend          # 跳过后端构建
```

### EC2 部署流程（3 个阶段）

**Phase 1: CDK Deploy**
- 创建 VPC Security Groups、EC2 (t4g.small ARM64)、EIP
- RDS PostgreSQL 16.6、ElastiCache Redis 7.1
- S3 桶（Avatar、Skills、Workspace、Frontend）
- CloudFront + ACM 证书 + Route53 ALIAS
- IAM Role（EC2 + AgentCore）
- 等待 EC2 UserData 完成（安装 Node.js、Nginx、PostgreSQL client 等）

**Phase 2: Code Deploy**（调用 `deploy.sh`）
- 从 SecretsManager 获取 RDS 凭证，生成 `.env`
- 构建前端（Vite）→ rsync 到 EC2 + S3 sync + CloudFront 失效
- 编译后端（tsc）→ rsync 到 EC2 → npm ci → prisma migrate → seed → 重启
- 首次部署自动创建 admin 用户：`admin@example.com` / `Admin1234!`

**Phase 3: AgentCore Setup**
- 创建 ECR 仓库，构建推送 ARM64 Docker 镜像
- 创建 IAM Execution Role（Bedrock、S3、ECR、Browser、Code Interpreter 权限）
- 创建 Bedrock AgentCore Runtime
- 更新 EC2 `.env` 启用 AgentCore 模式

### EC2 部署完成后

访问 `https://app.example.com`，使用 `admin@example.com` / `Admin1234!` 登录。

> **重要**：首次登录后请立即修改 admin 密码。

## 增量部署

全量部署完成后，日常代码更新不需要重建基础设施：

```bash
# 只部署代码（跳过 CDK 和 AgentCore）
./infra/scripts/deploy-full.sh ~/Downloads/my-key.pem \
  --stack SuperAgentProd --skip-cdk --skip-agentcore

# 或直接用 deploy.sh
./infra/scripts/deploy.sh ~/Downloads/my-key.pem --stack SuperAgentProd

# 只更新前端
./infra/scripts/deploy.sh ~/Downloads/my-key.pem --stack SuperAgentProd --skip-backend

# 只更新后端
./infra/scripts/deploy.sh ~/Downloads/my-key.pem --stack SuperAgentProd --skip-frontend
```

## 多环境隔离

每个 `--stack` 名称创建完全独立的资源（EC2、RDS、Redis、S3、CloudFront）：

```bash
# 生产环境
./infra/scripts/deploy-full.sh ~/key.pem --stack SuperAgentProd --domain app.example.com --hosted-zone-id Z0XXX

# 测试环境
./infra/scripts/deploy-full.sh ~/key.pem --stack SuperAgentTest --domain test.example.com --hosted-zone-id Z0XXX
```

S3 桶名、SecretsManager secret 名、ElastiCache 集群名都以 stack 名为前缀，不会冲突。

## CI/CD（GitHub Actions）

项目包含 `.github/workflows/deploy-test.yml`，push 到 main 自动部署测试环境。

### 配置 GitHub Secrets

```bash
./infra/scripts/setup-github-secrets.sh ~/Downloads/my-key.pem --repo owner/repo
```

自动配置：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`EC2_KEY_PAIR_NAME`、`EC2_SSH_PRIVATE_KEY`。

另需手动添加（如使用 CDN）：`TEST_DOMAIN_NAME`、`TEST_HOSTED_ZONE_ID`。

### Pipeline 流程

1. **Build & Test** — 编译前后端 + 运行测试
2. **CDK Deploy** — 部署/更新测试 Stack（`SuperAgentTest`）
3. **Deploy Application** — 通过 SSM 部署代码到 EC2
4. **Smoke Test** — 健康检查 + 前端可达性验证

## 模型来源配置（在界面中设置）

模型来源直接在应用界面配置，**无需 SSH、无需部署脚本、无需改环境变量**。以管理员登录后进入 **Settings → Models（设置 → 模型来源）**。

默认已内置一个组织默认来源：**Amazon Bedrock**（模型 `global.anthropic.claude-opus-4-8`）。

### 添加 LiteLLM 网关（接入第三方模型，如 Kimi、GLM 等）

1. Settings → Models → **Add Provider（添加来源）**
2. **Type** 选择 **LiteLLM Gateway**
3. 填写：
   - **Name**：显示名称（如 `Corp LiteLLM`）
   - **Base URL**：网关地址（如 `https://litellm.example.com`）
   - **API Key**：网关密钥（仅写入、不回显；编辑时留空表示保留原值）
   - **Model ID**：要使用的模型 ID（**必填**，如 `claude-opus-4.8`）——对话中直接使用该指定模型，不会列出网关的全部模型
4. 保存后，可对该来源：**启用/停用**、**设为组织默认（★）**、**编辑**、**删除**

### 添加 / 编辑 Amazon Bedrock 来源

Type 选择 **Amazon Bedrock** 时，**Model ID** 会自动列出当前区域可用的 Bedrock 模型（点 **Refresh** 刷新）供选择；无需 Base URL / API Key（使用平台自身的 AWS 凭证）。

**支持 Claude 与非 Claude 模型**：直连 Bedrock 来源不仅支持 Anthropic/Claude，也支持 **Amazon Nova、DeepSeek、Meta Llama、OpenAI gpt-oss、Kimi** 等 Bedrock 托管模型。运行时会自动为非 Claude 模型切换到兼容路径（见下文"模型统一兼容"）。

> 少数模型的注意事项：**推理型模型**（如 DeepSeek R1、Kimi K2 Thinking）在 Bedrock 上不支持工具调用；由于 Agent 会话总是携带工具，代理会自动去掉工具重试一次（可回答，但无工具能力）。**Llama 3.3** 会把工具调用当成普通文本返回（不推荐做 Agent）；**Llama 4** 则原生支持工具，推荐用于 Agent 场景。

### 使用非 Bedrock 模型（OpenAI 直连 / DeepSeek 直连等）

不在 Bedrock 上托管的模型，通过 **LiteLLM 网关来源** 接入（见上文），由网关翻译到各家原生 API。

> 生效范围：启用的来源会出现在对话框的模型选择器中；组织默认来源用于未显式指定模型时的兜底。切换默认来源即改变全局默认模型。

## 模型统一兼容（架构）

Agent 运行时本质是 **Claude Code CLI**，它**只会说 Anthropic Messages 协议**（请求带 `metadata`、`cachePoint`、`thinking` 等字段）。不同模型对这套协议的接受度不同——Bedrock 上的 Claude 全接受，而 Nova / DeepSeek / Llama 会拒绝 `metadata`、`cachePoint`、`thinking`，且 `max_tokens` 上限各异。统一兼容靠服务端的**路由 + 协议翻译 + 能力裁剪**实现，客户端（CLI）无需改动。

```
Claude Code CLI ──(Anthropic Messages)──▶ [路由]
                                            ├─ Anthropic 模型         → Bedrock 直连（原生可用）
                                            ├─ 其他 Bedrock 托管模型  → 内置代理 /v1/messages → Bedrock Converse（能力裁剪）
                                            └─ 非 Bedrock 模型        → 外部 LiteLLM 网关 → 各家原生 API
```

**第 1 层 · 路由决策**（`backend/src/services/agent-runtime-agentcore.ts`）
逐请求判断：`provider == bedrock` 且模型非 Anthropic（`isAnthropicBedrockModel()`）时，改道到后端自带的 `/v1/messages` 代理（把 `provider` 视作 `litellm`，`base_url` 指向后端公网地址 `AGENTCORE_BACKEND_API_URL`，用内部服务令牌鉴权）；Claude 模型走 Bedrock 直连的快速路径。

**第 2 层 · Anthropic → Converse 代理**（`backend/src/routes/llm-proxy.routes.ts` + `backend/src/services/llm-proxy/`）
`/v1/messages` 把 Anthropic 协议转换成 **Bedrock Converse**（Bedrock 的统一 API，一套 schema 覆盖 Nova / DeepSeek / Llama 等）。转换器里的**能力裁剪门**是通用性的关键（`openai-to-bedrock.ts`）：
- `isAnthropicModel()` 拦住 Claude 专属字段 → 非 Anthropic 模型**不注入** `cachePoint`（提示缓存）与 `thinking`（扩展思考）
- `MODEL_MAX_OUTPUT_TOKENS` 按模型钳制 `max_tokens`（如 Nova 8192）
- **无工具回退**：模型拒绝 `tools` 时（如 DeepSeek R1），自动去掉工具重试一次
- 代理接受容器传来的**内部服务令牌**（`internal.*`，授予 `model:invoke`），无需单独发放 API Key

**第 3 层 · 外部 LiteLLM 网关**（非 Bedrock 模型）
容器路径相同（`ANTHROPIC_BASE_URL` 指向网关），由网关做同样的协议翻译。若网关上的推理模型报 `does not support parameters: ['tools']`，在**网关端**配置 `litellm_settings: drop_params: true` 即可。

> 依赖的部署配置（`deploy-full-ecs.sh` 与 CDK 已内置）：ECS 任务注入 `AGENTCORE_BACKEND_API_URL`（容器回调地址），CloudFront 增加 `/v1/*` 行为把 LLM 代理请求转发到 ALB。

## 运维

### 查看日志

**ECS 模式：**

```bash
# CloudWatch Logs（推荐；日志组名含 stack 名，小写）
aws logs tail /super-agent/<stack名小写>/ecs-backend --region <region> --follow

# 或通过 ECS Exec 进入容器
TASK_ARN=$(aws ecs list-tasks --cluster <cluster-name> --service-name <service-name> --region <region> --query "taskArns[0]" --output text)
aws ecs execute-command --cluster <cluster-name> --task $TASK_ARN --container backend --interactive --command "/bin/sh" --region <region>
```

**EC2 模式：**

```bash
# 通过 SSM 连接
aws ssm start-session --target <InstanceId> --region us-west-2

# 后端日志
tail -f /opt/super-agent/logs/backend.log
tail -f /opt/super-agent/logs/backend-error.log

# Nginx 日志
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

日志也会自动推送到 CloudWatch Logs（`/super-agent/backend`、`/super-agent/nginx-*`）。

### 重启服务

**ECS 模式：**

```bash
# 强制新部署（拉取最新镜像）
aws ecs update-service --cluster <cluster-name> --service <service-name> --force-new-deployment --region <region>

# 等待稳定
aws ecs wait services-stable --cluster <cluster-name> --services <service-name> --region <region>
```

**EC2 模式：**

```bash
sudo systemctl restart backend
sudo systemctl status backend
```

### 环境变量

**ECS 模式：** 环境变量在 ECS Task Definition 中管理。更新方式：

```bash
# 重新运行 deploy 脚本（会注册新 task definition 并更新 service）
./infra/scripts/deploy-full-ecs.sh --stack <StackName> --skip-cdk --skip-frontend
```

**EC2 模式：** 生产环境变量在 `/opt/super-agent/.env`（systemd EnvironmentFile）。
`deploy.sh` 的合并策略是"已有值不覆盖"，手动添加的变量不会被后续部署覆盖。

### AgentCore ↔ Claude 模式切换

```bash
# 切换到 Claude 模式（EC2 子进程）
sed -i 's/^AGENT_RUNTIME=agentcore/AGENT_RUNTIME=claude/' /opt/super-agent/.env
sudo systemctl restart backend

# 切回 AgentCore 模式
sed -i 's/^AGENT_RUNTIME=claude/AGENT_RUNTIME=agentcore/' /opt/super-agent/.env
sudo systemctl restart backend
```

### 更新 AgentCore 容器

```bash
cd agentcore
docker buildx build --platform linux/arm64 \
  -t <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/super-agent-agentcore:latest \
  --load .
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/super-agent-agentcore:latest

# 通知 AgentCore 拉取新镜像（⚠️ --environment-variables 是全量替换，必须传完整）
# 注意：ANTHROPIC_MODEL 必须使用 global inference profile（跨区域可用）
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <runtime-id> \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<ECR_URI>:latest"}}' \
  --role-arn "arn:aws:iam::<ACCOUNT_ID>:role/super-agent-agentcore-role-<StackName>" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --environment-variables '{"CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_MODEL":"global.anthropic.claude-opus-4-6-v1","AWS_REGION":"<REGION>","WORKSPACE_S3_REGION":"<REGION>"}' \
  --region <REGION>
```

> **模型 ID 注意事项**：
> - 使用 `global.anthropic.*` 前缀的 inference profile（所有区域可用）
> - 不要使用 `us.anthropic.*`（仅 US 区域）或裸模型名（如 `claude-sonnet-4-6`）
> - 可用 `aws bedrock list-inference-profiles --region <region>` 查看当前区域支持的 profile

## 销毁环境

```bash
cd infra

# EC2 模式
npx cdk destroy -c stackName=SuperAgentProd --region us-west-2 --force

# ECS 模式
npx cdk destroy -c stackName=SuperAgentProd -c deployTarget=ecs --region us-west-2 --force
```

CDK destroy 后需要手动清理：

```bash
# Avatar 和 Skills 桶（removalPolicy=RETAIN，CDK 不删）
aws s3 rb s3://<avatar-bucket-name> --force
aws s3 rb s3://<skills-bucket-name> --force

# ECR 仓库
aws ecr delete-repository --repository-name super-agent-agentcore --force --region <REGION>
aws ecr delete-repository --repository-name super-agent-backend --force --region <REGION>  # ECS 模式

# AgentCore 资源（不在 CDK 管理范围）
aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id <id> --region <REGION>
aws iam delete-role-policy --role-name super-agent-agentcore-role-<StackName> --policy-name agentcore-permissions-<StackName>
aws iam delete-role --role-name super-agent-agentcore-role-<StackName>
```

## 已知注意事项

- **Bedrock 模型 ID**：必须使用 `global.anthropic.*` inference profile（如 `global.anthropic.claude-opus-4-8`），不要使用 `us.anthropic.*`（仅 US 区域）或裸 Anthropic API 名称。ECS 默认模型来源为 Amazon Bedrock + `global.anthropic.claude-opus-4-8`
- **引擎版本自动探测**：RDS PostgreSQL / ElastiCache Redis 版本不硬编码，脚本部署前查询当前区域实际可用的版本再传给 CDK（避免"某版本在该区域不可用"导致创建失败）
- **无自定义域名**：默认使用 CloudFront 分配的 `*.cloudfront.net` 域名，无需 ACM 证书或 Route53；CloudFront 首次全球生效约 5-15 分钟
- **ECS 模式 — Prisma 迁移 + seed**：由于 RDS 不可公网访问，迁移与 seed 通过 ECS run-task 在 VPC 内执行；seed 幂等，重复部署不会重复插入；`prisma.config.ts` 中的 `dotenv/config` 在生产镜像中不可用，部署脚本会自动重写配置
- **ECS 模式 — 初始 desiredCount=0**：CDK 创建 ECS Service 时使用占位镜像，desiredCount 设为 0 避免健康检查失败；部署脚本推送真实镜像后设为 1
- **EC2 UserData 耗时**：首次创建 EC2 约需 3-5 分钟完成 bootstrap，`deploy-full.sh` 会自动等待
- **CloudFront Origin**：ECS 模式直接使用 ALB DNS 作为 origin（无占位符）；EC2 模式使用占位符，`deploy-full.sh` 会自动替换
- **`DnsValidatedCertificate` 废弃警告**：CDK 会输出 deprecation warning，功能正常，未来版本需迁移到 `acm.Certificate`
- **S3 桶 RETAIN 策略**：Avatar 和 Skills 桶设为 RETAIN，CDK destroy 不会删除，需手动清理
- **所有资源同 VPC**：ECS tasks、RDS、ElastiCache、ALB 必须在同一 VPC 内，安全组规则控制互访
