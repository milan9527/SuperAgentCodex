# App Host POC — Floci 本地部署方案

> **目标**: 用 Floci 在本地完整模拟 AWS EKS + S3 + IAM + RDS，零成本验证 App Host 架构。
> **日期**: 2026-05-16

---

## 一、为什么用 Floci

| 对比 | 直接 AWS EKS | Floci 本地模拟 |
|------|-------------|---------------|
| **成本** | ~$135/月（EKS控制面$73 + EC2$61） | $0 |
| **部署时间** | 15-20 分钟创建集群 | `docker compose up` 24ms 启动 |
| **清理** | `cdk destroy` 等待 10+ 分钟 | `docker compose down -v` 秒级 |
| **网络** | 需要公网访问 | 纯本地 localhost |
| **迭代速度** | 构建推 ECR → 部署 → 等待 Pull | 本地镜像直接用 |
| **K8s 兼容** | 原生 EKS | k3s（CNCF 认证的 K8s 发行版） |

**结论**: POC 和开发阶段用 Floci，生产部署用真实 AWS EKS。CDK 代码同一套。

---

## 二、Floci 支持的服务（POC 需要的）

| POC 需要的 AWS 服务 | Floci 支持 | 说明 |
|-------------------|-----------|------|
| **EKS** | ✅ k3s 真实数据平面 | `kubectl` 直接连接，标准 K8s API |
| **S3** | ✅ 完整支持 | 3 个租户桶，presigned URL，版本控制 |
| **IAM** | ✅ Users/Roles/Policies | IRSA（Pod 级 IAM 角色） |
| **RDS** | ✅ 真实 PG Docker 容管 | 可选：用 Floci RDS 替代 K8s 内 PG StatefulSet |
| **EC2** | ✅ VPC/Subnet/SG | 模拟网络拓扑 |
| **KMS** | ✅ 加密/解密 | 租户数据加密 |

---

## 三、本地部署架构

```
Docker Desktop (Windows)
└── docker-compose up
    │
    ├── floci                          ← AWS 模拟器 (port 4566)
    │   ├── EKS (k3s data plane)       ← kubectl 连接
    │   ├── S3 (3 个租户桶)
    │   ├── IAM (roles + policies)
    │   └── KMS (数据加密)
    │
    ├── traefik                        ← Ingress Controller
    │   └── 路由 {shortId}.app.localhost → 对应 App
    │
    ├── app-host-api                   ← 管控面 API
    │   └── 连接 floci 的 EKS + S3
    │
    └── (App 容器由 EKS/k3s 调度)       ← 不在 compose 里静态定义
        ├── alpha/schedule-app (nginx + runtime)
        ├── beta/crm-app (nginx + runtime)
        └── gamma/dashboard-app (nginx + runtime)
```

### 关键区别 vs 真实 AWS 部署

| 组件 | 真实 AWS | Floci 本地 |
|------|---------|-----------|
| EKS 控制面 | AWS 托管 | Floci 模拟 |
| K8s 数据平面 | EC2 t3.medium × 2 | k3s 容器 |
| S3 | 真实 S3 桶 | Floci S3（本地存储） |
| IAM IRSA | AWS IAM + OIDC | Floci IAM（模拟） |
| PG | RDS 或 K8s StatefulSet | Floci RDS（真 PG 容器）或 K8s StatefulSet |
| 域名 | Route53 + LoadBalancer | localhost + Traefik |
| 证书 | ACM / Let's Encrypt | 不需要（HTTP） |

---

## 四、部署步骤

### 4.1 前提

- Docker Desktop（已有）
- `kubectl`（Docker Desktop 自带）
- `aws` CLI（用于与 Floci 的 AWS API 交互）

### 4.2 启动 Floci

```bash
cd poc

# Floci 首次会拉取镜像 (~90MB)
docker compose -f docker-compose.floci.yml up -d floci

# 等待就绪
curl -s http://localhost:4566/_localstack/health | head -5

# 配置 kubectl 连接 Floci 的 EKS/k3s
# (Floci 会暴露 kubeconfig，具体方式待验证其 EKS API)
```

### 4.3 创建 AWS 资源（S3 + IAM）

```bash
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test

# 创建 3 个租户 S3 桶
aws s3 mb s3://app-host-alpha-a1b2c3d4e5f6
aws s3 mb s3://app-host-beta-7a8b9c0d1e2f
aws s3 mb s3://app-host-gamma-3a4b5c6d7e8f

# 创建 IAM 角色（给 App Runtime Pod 用）
aws iam create-role --role-name app-runtime-alpha \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect":"Allow","Principal":{"Service":"pods.eks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam put-role-policy --role-name app-runtime-alpha \
  --policy-name S3Access \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::app-host-alpha-a1b2c3d4e5f6/*"]}]
  }'

# 同理创建 beta 和 gamma 的角色
```

### 4.4 部署 K8s 资源

```bash
# 获取 Floci EKS 的 kubeconfig（待验证具体命令）
# 可能是：
aws eks update-kubeconfig --name app-host-poc --endpoint http://localhost:4566

# 部署基础设施
kubectl apply -f k8s/infra/traefik.yaml
kubectl apply -f k8s/infra/app-host-api.yaml

# 部署 3 个租户
kubectl apply -f k8s/tenants/tenant-alpha.yaml
kubectl apply -f k8s/tenants/tenant-beta.yaml
kubectl apply -f k8s/tenants/tenant-gamma.yaml
```

### 4.5 验证

```bash
# 查看 Pod 状态
kubectl get pods --all-namespaces

# 访问 App
# http://550e8400e29b.app.localhost:8080  — Tenant ASchedule Manager
# http://4d5e6f7a8b9c.app.localhost:8080  — Tenant BCRM
# http://9a0b1c2d3e4f.app.localhost:8080  — Tenant C数据看板

# 测试 S3 隔离
aws s3 ls s3://app-host-alpha-a1b2c3d4e5f6/
```

---

## 五、需要新增/修改的文件

| 文件 | 动作 | 说明 |
|------|------|------|
| `docker-compose.floci.yml` | **新建** | Floci + Traefik + App Host API 的 compose 文件 |
| `scripts/setup-floci-aws.sh` | **新建** | 用 AWS CLI 在 Floci 上创建 S3 桶和 IAM 角色 |
| `scripts/deploy-local-floci.sh` | **新建** | 一键部署：启动 Floci → 创建 AWS 资源 → 部署 K8s |
| `services/runtime/src/files.ts` | **修改** | S3 endpoint 指向 Floci（`http://floci:4566`） |
| `k8s/tenants/*.yaml` | **修改** | S3 endpoint 环境变量加上 Floci 地址 |
| `README.md` | **修改** | 补充 Floci 部署方式 |

---

## 六、双路径部署策略

```
本地开发/POC 验证:
  docker compose up (Floci) → kubectl apply → 验证架构
  成本: $0
  适合: 架构验证、快速迭代、演示

生产部署:
  cdk deploy → 创建真实 EKS + S3 + IAM
  构建镜像 → 推 ECR → kubectl apply
  成本: ~$135/月
  适合: 真实业务运行、客户演示、性能测试

共享代码:
  ├── CDK (TypeScript)     → 同一套，生产部署用
  ├── K8s manifests (YAML) → 同一套
  ├── App Host API         → 同一套代码，环境变量不同
  └── App Runtime          → 同一套代码，S3 endpoint 环境变量不同
```

---

## 七、风险与待验证项

| 项 | 风险 | 应对 |
|----|------|------|
| Floci EKS (k3s) 的 kubeconfig 获取方式 | 需要确认 Floci EKS 如何暴露 kubeconfig | 查文档或 GitHub Issues |
| IRSA 在 Floci 中的行为 | IAM Role for Service Account 可能有差异 | POC 阶段可简化为直接传密钥 |
| Floci EKS 是否支持 Traefik IngressRoute CRD | k3s 默认用 Traefik，但 CRD 版本可能不同 | 验证后调整 |
| S3 presigned URL 在 Floci 中的兼容性 | URL 格式可能不同 | Runtime 的 files.ts 已支持自定义 endpoint |
| Docker Desktop Windows 上 k3s 嵌套容器 | Docker-in-Docker 可能有性能问题 | 监控资源使用 |
