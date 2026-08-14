# Auth 联邦认证方案：Super Agent ↔ InsForge 用户体系打通

> **目标**: 平台用户（Super Agent 组织成员）无缝访问 App，无需在 InsForge 重复注册。
> **日期**: 2026-05-20

---

## 一、问题背景

当前存在两套独立的用户体系：

| 体系 | 管理方 | 用户类型 | 认证方式 |
|------|--------|---------|---------|
| **Super Agent Auth** | 平台 | 组织管理员、成员 | Cognito / 内置 JWT |
| **InsForge Auth** | 每个租户的 InsForge 实例 | App 终端用户（外部客户） | 邮箱密码 / OAuth |

**痛点**：平台管理员想查看 App 数据时，需要在 InsForge 里再注册一个账号，体验割裂。

---

## 二、设计原则

1. **不合并用户表** — 两套体系各自独立，通过 JWT 信任建立联邦关系
2. **InsForge 尽量零改动** — 它是第三方项目，改了不好升级
3. **渐进式实施** — 从 POC 到生产不需要推翻重来
4. **最小权限** — 平台用户访问 App 时，权限不超过其平台角色

---

## 三、用户身份来源

```
┌─────────────────────────────────────────────────────────────────┐
│  身份来源                                                        │
│                                                                 │
│  来源 1: Super Agent 平台用户（组织成员）                          │
│    → 已有账号，登录平台后获得 Platform JWT                         │
│    → 访问 App 时，Platform JWT 被 InsForge 信任                   │
│    → 自动映射为 InsForge 的 authenticated/project_admin 角色      │
│                                                                 │
│  来源 2: App 终端用户（外部客户/合作方）                           │
│    → 通过 InsForge Auth 注册/登录                                 │
│    → 获得 InsForge JWT                                           │
│    → 只能访问特定 App 的数据                                      │
│                                                                 │
│  来源 3: Agent（MCP 调用）                                        │
│    → 使用 API Key                                                │
│    → 映射为 project_admin 角色（绕过 RLS）                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、分阶段实施方案

### Phase 1 — 共享 JWT Secret（POC 阶段）

**原理**: Super Agent 和 InsForge 使用同一个 JWT Secret，Super Agent 签发的 JWT 天然能被 InsForge 的 PostgREST 验证。

```
Super Agent 签发 JWT:
  {
    "sub": "user_abc123",
    "org_id": "org_xxx",
    "role": "authenticated",    ← PostgREST 识别此 claim
    "email": "zhang@company.com",
    "iss": "super-agent"
  }

InsForge PostgREST 配置:
  PGRST_JWT_SECRET = {与 Super Agent 相同的 secret}

验证流程:
  1. 平台用户带 Platform JWT 访问 InsForge API
  2. PostgREST 用共享 secret 验证签名 → 通过
  3. 提取 role = "authenticated" → 授予对应权限
  4. 用户可以读写 App 数据
```

**实现方式**:

```yaml
# docker-compose.floci.yml 中对齐 JWT Secret
environment:
  # Super Agent 后端
  - JWT_SECRET=shared-platform-secret-change-in-prod

  # InsForge (同一个 secret)
  - JWT_SECRET=shared-platform-secret-change-in-prod

  # PostgREST (同一个 secret)
  - PGRST_JWT_SECRET=shared-platform-secret-change-in-prod
```

**优点**:
- 零代码改动，只需配置对齐
- PostgREST 天然支持 JWT role claim
- 立即可用

**缺点**:
- Secret 泄露影响面大（两个系统共用）
- 无法区分"平台用户"和"App 用户"的 JWT 来源
- 不支持 Secret 轮换（需要同时更新两边）

---

### Phase 2 — JWKS 联邦验证（生产早期）

**原理**: Super Agent 暴露 JWKS（JSON Web Key Set）公钥端点，InsForge 配置信任该公钥。两套系统各自管理自己的密钥。

```
Super Agent 暴露公钥:
  GET https://platform.example.com/.well-known/jwks.json
  → 返回 RSA/EC 公钥

InsForge 配置信任:
  trusted_issuers:
    - issuer: "super-agent"
      jwks_uri: "http://super-agent-api:3000/.well-known/jwks.json"
    - issuer: "insforge"
      secret: "{本地 JWT Secret}"

验证流程:
  1. 收到 JWT → 检查 iss (issuer) claim
  2. iss = "super-agent" → 从 JWKS 获取公钥验证
  3. iss = "insforge" → 用本地 secret 验证
  4. 验证通过 → 提取 role → 授权
```

**实现方式**:

需要在 InsForge 前加一个轻量验证中间件（或 PostgREST 的 `pre-request` hook）：

```typescript
// auth-middleware.ts (放在 InsForge 前的 reverse proxy 中)
async function verifyToken(token: string): Promise<JWTPayload> {
  const header = decodeHeader(token);
  const payload = decodePayload(token);

  if (payload.iss === 'super-agent') {
    // 用 JWKS 公钥验证
    const publicKey = await fetchJWKS('http://super-agent-api:3000/.well-known/jwks.json', header.kid);
    return verify(token, publicKey);
  } else {
    // 用本地 secret 验证
    return verify(token, process.env.JWT_SECRET);
  }
}
```

**优点**:
- 标准 OIDC/OAuth2 模式
- 密钥独立管理，互不影响
- 支持密钥轮换

**缺点**:
- 需要 Super Agent 实现 JWKS 端点
- InsForge 原生不支持多 issuer（需要中间件或 fork）

---

### Phase 3 — Auth Gateway（生产推荐）

**原理**: 在 InsForge 前部署一个 Auth Gateway，负责统一验证所有来源的凭证，然后换发 InsForge 本地 JWT 透传给后端。InsForge 本身零改动。

```
┌──────────────────────────────────────────────────────────────┐
│  Auth Gateway（新增薄服务）                                    │
│                                                              │
│  输入:                                                        │
│    ├── Platform JWT (来自 Super Agent)                        │
│    ├── InsForge JWT (来自 App 终端用户)                       │
│    ├── API Key (来自 Agent MCP)                              │
│    └── 企业 SSO Token (来自企微/飞书)                         │
│                                                              │
│  处理:                                                        │
│    1. 识别凭证类型                                            │
│    2. 验证凭证有效性                                          │
│    3. 映射为 InsForge 角色                                    │
│    4. 用 InsForge 的 JWT Secret 签发新 JWT                   │
│    5. 透传给 InsForge                                        │
│                                                              │
│  输出:                                                        │
│    InsForge JWT: { sub, role, app_id, org_id }               │
└──────────────────────────────────────────────────────────────┘

请求链路:
  用户 → Traefik → Auth Gateway → InsForge App/PostgREST
                        │
                        ├── Platform JWT → 验证 → 换发 InsForge JWT
                        ├── InsForge JWT → 直接透传
                        ├── API Key → 换发 project_admin JWT
                        └── SSO Token → 验证 → 换发 InsForge JWT
```

**Auth Gateway 核心逻辑**:

```typescript
// gateway/src/index.ts (伪代码)

interface TokenExchangeResult {
  insforgeJWT: string;
  role: string;
  userId: string;
}

async function exchangeToken(request: Request): Promise<TokenExchangeResult> {
  const auth = request.headers.authorization;
  const apiKey = request.headers['x-api-key'];

  // 1. API Key (Agent MCP)
  if (apiKey) {
    return {
      insforgeJWT: signInsForgeJWT({ sub: 'agent', role: 'project_admin' }),
      role: 'project_admin',
      userId: 'agent',
    };
  }

  // 2. Bearer Token
  const token = auth?.replace('Bearer ', '');
  const payload = decodePayload(token);

  switch (payload.iss) {
    case 'super-agent': {
      // 验证 Platform JWT
      await verifyPlatformJWT(token);
      // 映射角色
      const role = mapPlatformRole(payload.role);
      // 记录用户映射（首次访问时）
      await ensureUserMapping(payload.sub, payload.org_id, payload.email);
      // 换发 InsForge JWT
      return {
        insforgeJWT: signInsForgeJWT({
          sub: payload.sub,
          role,
          org_id: payload.org_id,
          source: 'platform',
        }),
        role,
        userId: payload.sub,
      };
    }

    case 'insforge':
    default:
      // 已经是 InsForge JWT，直接透传
      return { insforgeJWT: token, role: payload.role, userId: payload.sub };
  }
}

function mapPlatformRole(platformRole: string): string {
  switch (platformRole) {
    case 'admin': return 'project_admin';
    case 'member': return 'authenticated';
    case 'viewer': return 'anon';
    default: return 'anon';
  }
}
```

**优点**:
- InsForge 零改动（只看到自己签发格式的 JWT）
- 支持任意认证源扩展（企微 SSO、飞书、SAML 等）
- 可以加审计日志、rate limiting、用户映射
- 升级 InsForge 版本无影响

**缺点**:
- 多一跳网络延迟（~1-2ms，可忽略）
- 多一个服务需要维护

---

## 五、JWT Claim 映射规则

### 平台用户 → InsForge 权限

| Super Agent 平台角色 | InsForge PostgREST 角色 | 数据权限 |
|---------------------|------------------------|---------|
| `admin` (组织管理员) | `project_admin` | 所有 App schema 的全部数据，绕过 RLS |
| `member` (组织成员) | `authenticated` | 绑定 App 的数据，受 RLS 约束 |
| `viewer` (只读成员) | `anon` | 只读访问 |

### JWT 格式对比

```json
// Super Agent Platform JWT
{
  "sub": "user_abc123",
  "org_id": "org_xxx",
  "role": "admin",
  "email": "zhang@company.com",
  "name": "Alice",
  "iss": "super-agent",
  "exp": 1716249600
}

// InsForge App JWT（终端用户）
{
  "sub": "app_user_456",
  "app_id": "550e8400-e29b-41d4-a716-446655440000",
  "role": "authenticated",
  "email": "customer@external.com",
  "iss": "insforge",
  "exp": 1716249600
}

// Auth Gateway 换发的 InsForge JWT（平台用户访问 App 时）
{
  "sub": "user_abc123",
  "role": "project_admin",
  "org_id": "org_xxx",
  "source": "platform",
  "original_role": "admin",
  "iss": "insforge",
  "exp": 1716249600
}
```

---

## 六、用户映射表（Phase 2+）

当需要在 App 内追踪"这条记录是哪个平台用户创建的"时：

```sql
-- 在 InsForge 的 public schema 或 _host schema 中
CREATE TABLE _user_mappings (
  id SERIAL PRIMARY KEY,
  platform_user_id TEXT NOT NULL,       -- Super Agent user ID
  insforge_user_id TEXT,                -- InsForge 内部 user ID（可选）
  org_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  avatar TEXT,
  platform_role TEXT DEFAULT 'member',  -- admin / member / viewer
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(platform_user_id, org_id)
);

-- 首次访问时由 Auth Gateway 自动创建
-- 后续访问更新 last_seen_at
```

**用途**:
- App 内显示"由 Alice 创建"而不是一个 UUID
- 审计日志关联到具体平台用户
- 统计哪些平台用户在使用哪些 App

---

## 七、实际访问场景

### 场景 1: 平台管理员查看 App 数据

```
1. 管理员已登录 Super Agent → 浏览器有 Platform JWT
2. 点击"查看Schedule Manager App 数据"
3. 前端带 Platform JWT 请求:
   GET /api/tables/app_550e8400e29b/schedules/records
   Authorization: Bearer {Platform JWT}
4. Auth Gateway:
   → 识别 iss=super-agent
   → 验证签名
   → role=admin → 映射为 project_admin
   → 换发 InsForge JWT
5. InsForge 收到 InsForge JWT → 验证通过 → 返回全部数据
```

### 场景 2: 外部客户访问 App

```
1. 客户打开 App URL → 看到登录页
2. 通过 InsForge Auth 注册/登录:
   POST /auth/login { email, password }
3. 获得 InsForge JWT (role=authenticated)
4. 访问数据:
   GET /api/tables/app_550e8400e29b/schedules/records
   Authorization: Bearer {InsForge JWT}
5. Auth Gateway → 识别 iss=insforge → 直接透传
6. PostgREST → role=authenticated → 受 RLS 约束 → 返回允许的数据
```

### 场景 3: Agent 通过 MCP 操作数据

```
1. Agent 执行 insforge-mcp 工具
2. 使用 API Key 认证:
   X-API-Key: ik_app_xxxxx
3. Auth Gateway → 识别 API Key → 换发 project_admin JWT
4. InsForge → 绕过 RLS → 可操作所有数据
```

### 场景 4: 企业 SSO 用户访问 App（Phase 3）

```
1. 用户通过企微/飞书 SSO 登录
2. SSO 回调返回 ID Token
3. Auth Gateway:
   → 验证 SSO Token
   → 查找用户映射（或自动创建）
   → 换发 InsForge JWT (role=authenticated)
4. 用户访问 App 数据
```

---

## 八、实施建议

| 阶段 | 方案 | 工作量 | 适用场景 |
|------|------|--------|---------|
| **POC** | Phase 1（共享 Secret） | 0（配置对齐） | 内部演示、架构验证 |
| **MVP** | Phase 1 + 用户映射表 | 1-2 天 | 首个客户上线 |
| **生产 v1** | Phase 3（Auth Gateway） | 1-2 周 | 多客户、需要 SSO |
| **生产 v2** | Phase 3 + RBAC 细化 | 2-3 周 | 需要 App 级权限控制 |

### POC 阶段立即可做

只需在 `docker-compose.floci.yml` 中确保 Super Agent 和 InsForge 使用相同的 `JWT_SECRET`，然后 Super Agent 签发的 JWT 包含 `role` claim 即可。当前 POC 已经配置了 per-tenant 的 JWT Secret，只需让 Super Agent 后端在生成"访问 App"的 token 时使用对应租户的 secret 签发即可。

---

## 九、安全考量

| 风险 | 缓解措施 |
|------|---------|
| JWT Secret 泄露 | Phase 2+ 切换为非对称密钥（RSA/EC），公钥可公开 |
| 平台用户越权访问其他租户 | JWT 中包含 org_id，InsForge RLS 策略校验 org_id |
| Token 重放攻击 | 短过期时间（15min）+ Refresh Token 机制 |
| Auth Gateway 单点故障 | 无状态设计，可水平扩展 |
| 用户映射数据不一致 | 每次验证时更新 last_seen_at，定期同步 display_name |
