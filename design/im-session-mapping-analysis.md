# IM Session 映射机制调研

## 背景问题

Chat Module 中每个 Agent 可以有多个 Chat Session，每个 Session 是独立的对话界面。但在飞书等 IM 集成中，用户感知到的是一个聊天窗口，所有消息混在同一个时间线上。这两种对话模型之间存在体验错位。

## 现有架构

### 核心数据模型

- `im_channel_bindings`：将 IM 渠道绑定到 business scope
  - 字段：`organization_id`, `business_scope_id`, `channel_type`, `channel_id`, `bot_token_enc`, `config`
- `im_thread_sessions`：将 IM 的 thread 映射到内部 Chat Session
  - 字段：`binding_id`, `thread_id`, `session_id`, `im_user_id`
  - 约束：`(binding_id, thread_id)` 唯一

### 消息处理流程（`IMService.handleMessage`）

```
1. 收到 IM 消息（webhook / gateway）
2. 通过 channel_type + channel_id 查找 im_channel_bindings
3. 调用 resolveSession()：
   - 查 im_thread_sessions 表，(binding_id, thread_id) 是否已有映射
   - 有 → 复用已有 Chat Session
   - 无 → 创建新 Chat Session + 插入映射记录
4. 调用 ChatService.processMessage()（与 Web UI 共用同一代码路径）
5. 通过 adapter.sendReply() 回复到 IM 平台
```

### 各平台 threadId 提取逻辑

| 平台 | threadId 来源 | 说明 |
|------|-------------|------|
| 飞书 | `root_id \|\| message_id` | 话题回复用 root_id，独立消息用 message_id |
| Slack | `thread_ts \|\| ts` | 线程回复用 thread_ts，独立消息用 ts |
| Discord | Gateway 事件中的 thread/channel ID | — |
| Telegram | 消息中的 chat ID | — |
| 钉钉 | Stream API 事件 | — |

## 问题分析

### 对话模型冲突

- **Chat Module**：多 Session 模型，每个 Session 是独立对话流，有清晰边界
- **飞书等 IM**：单流模型，所有消息在一个聊天窗口的时间线上

### 当前策略的问题

飞书 adapter 用 `root_id || message_id` 作为 threadId：

1. **话题回复**：同一话题下的消息共享 `root_id`，会路由到同一个 Chat Session ✅
2. **独立消息**：每条消息的 `message_id` 不同，每条消息都会创建新的 Chat Session ❌
   - 用户感知：在同一个聊天窗口连续提问
   - 系统行为：每条消息开启全新对话，机器人"失忆"

### 体验错位

用户在飞书里觉得"我一直在跟同一个机器人聊天"，但系统把非话题消息分散到了不同的 Session。上一条问了问题，下一条想追问，因为没在话题里回复，机器人就丢失了上下文。

## 可能的改进方向

### 方案 A：以 chat_id 为 threadId（单 Session 模式）

对飞书这种单流 IM，不按 thread 拆 Session，用 `chat_id`（群/单聊 ID）作为 threadId，同一个聊天窗口的所有消息落到同一个 Chat Session。

- 优点：体验与用户感知一致，对话连续
- 缺点：Session 历史无限增长，上下文管理和 token 消耗需要额外处理

### 方案 B：chat_id + user_id 作为 fallback

非话题消息用 `chat_id + user_id` 作为 threadId，同一用户在同一聊天窗口的非话题消息归到同一个 Session。话题回复仍按 `root_id` 走独立 Session。

- 优点：兼顾话题隔离和非话题连续性
- 缺点：群聊中不同用户的消息仍然分散

### 方案 C：时间窗口机制

在 `resolveSession` 中加入时间窗口逻辑，比如 30 分钟内同一用户的消息归到同一个 Session，超时则开新 Session。

- 优点：自动管理 Session 生命周期，避免无限增长
- 缺点：实现复杂度较高，窗口边界可能不符合用户预期

## 相关代码文件

- `backend/src/services/im.service.ts` — IMService 核心逻辑、resolveSession
- `backend/src/services/feishu-adapter.ts` — 飞书 adapter，parseEvent 中的 threadId 提取
- `backend/src/services/slack-adapter.ts` — Slack adapter
- `backend/src/repositories/im-channel.repository.ts` — im_channel_bindings / im_thread_sessions 数据访问
- `backend/src/services/chat.service.ts` — ChatService，processMessage / createSession
- `backend/src/services/message-router.service.ts` — 群聊消息路由（多 Agent 场景）
- `backend/prisma/schema.prisma` — 数据模型定义（chat_sessions, im_thread_sessions 等）
