# 时间线重建 (Timeline Reconstruction)

## 技能概述

时间线重建技能负责将故障响应全过程中分散在多个系统和沟通渠道中的事件信息，整合为精确到分钟的完整故障时间线。时间线是复盘报告的核心骨架，也是评估响应效率和发现流程改进点的关键依据。

## 使用场景

- 故障恢复后的复盘报告时间线章节撰写
- 实时故障中的时间线维护和状态更新
- 故障响应效率评估（各阶段耗时分析）
- 历史故障对比分析

## 执行步骤

### 步骤1：多源数据采集
收集以下来源的时间戳数据：
- 告警系统：首条告警触发时间、告警确认时间、告警恢复时间
- War Room聊天记录：关键发言、决策节点、操作确认
- 变更系统：故障前后的变更执行记录
- 操作审计：排查和恢复过程中的系统操作日志
- 通报记录：各次通报的发送时间
- 监控系统：指标异常首次出现和恢复正常的时间点

### 步骤2：事件标准化
将采集到的原始事件统一为标准格式：
- 时间戳（精确到分钟，必要时精确到秒）
- 事件类型：detection|response|investigation|decision|action|communication|recovery
- 事件描述（简洁明确的一句话）
- 操作人/系统
- 关键标注（如"定级完成""根因确认""恢复验证通过"等里程碑）

### 步骤3：时序排列和去重
- 按时间戳正序排列所有事件
- 合并重复记录（如同一操作在多个系统中都有记录）
- 填补时间空白（如果某段时间无记录，需要确认是"无事件"还是"记录缺失"）
- 标注关键里程碑节点

### 步骤4：阶段划分和耗时计算
将时间线划分为标准阶段并计算各阶段耗时：
- **检测阶段**（Detection）：故障实际发生 → 首条告警触发
- **响应阶段**（Response）：首条告警 → OnCall确认响应
- **分诊阶段**（Triage）：确认响应 → 定级完成
- **排查阶段**（Investigation）：定级完成 → 根因确认
- **恢复阶段**（Recovery）：根因确认 → 服务恢复正常
- **验证阶段**（Verification）：恢复操作 → 确认完全恢复

### 步骤5：输出格式化时间线
- 以表格形式输出完整时间线
- 标注各阶段耗时与SLA对比（达标/超标）
- 标记关键决策点和可改进点
- 计算总MTTR和各阶段占比

## 输入规格

```json
{
  "incident_id": "故障ID",
  "data_sources": {
    "alerts": [{"timestamp": "", "content": ""}],
    "chat_records": [{"timestamp": "", "speaker": "", "content": ""}],
    "change_records": [{"timestamp": "", "action": ""}],
    "operation_logs": [{"timestamp": "", "operator": "", "action": ""}],
    "communications": [{"timestamp": "", "type": "", "content": ""}],
    "metrics": [{"timestamp": "", "metric": "", "value": ""}]
  },
  "sla_requirements": {
    "response_time_minutes": 5,
    "resolution_time_minutes": 30
  }
}
```

## 输出规格

```json
{
  "timeline": [
    {
      "timestamp": "2024-01-15 14:32",
      "event_type": "detection",
      "description": "Prometheus触发CPU使用率>95%告警",
      "actor": "监控系统",
      "is_milestone": true,
      "phase": "detection"
    }
  ],
  "phase_analysis": {
    "detection": {"duration_minutes": 3, "sla_met": true},
    "response": {"duration_minutes": 4, "sla_met": true},
    "investigation": {"duration_minutes": 22, "sla_met": true},
    "recovery": {"duration_minutes": 8, "sla_met": true}
  },
  "total_mttr_minutes": 37,
  "key_decision_points": ["关键决策节点列表"],
  "improvement_opportunities": ["时间线中发现的可改进点"]
}
```

## 最佳实践

1. **精确度优先**：时间线的价值在于精确，模糊的"大约XX点"不可接受
2. **多源交叉验证**：同一事件在多个系统中的时间戳可能有偏差，取最可靠源
3. **记录"空白"**：如果某段时间明显无活动，需要标注并在复盘中讨论原因
4. **即时记录**：鼓励在故障进行中就实时维护时间线，事后回忆会丢失细节

## 约束条件

- 时间线必须覆盖从首条告警到恢复确认的完整周期
- 不得篡改或美化时间记录
- 涉及个人操作的记录需客观描述，不带评价性语言
- 时间线应在故障恢复后24小时内完成初稿
