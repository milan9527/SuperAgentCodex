# 改进Action跟踪 (Action Tracking)

## 技能概述

改进Action跟踪技能负责管理故障复盘中产出的改进措施（Action Items）的全生命周期，从创建、分配、执行到验收闭环。复盘的价值不在于报告本身，而在于改进措施的有效落地——业界数据显示，没有跟踪机制的改进Action完成率通常不到50%，而有效跟踪可将完成率提升至90%+。

## 使用场景

- 复盘报告中改进Action的创建和分配
- 改进Action执行进度的定期跟踪
- 逾期Action的自动提醒和升级
- Action完成率统计和效果验证
- 跨故障的Action合并和优先级调整

## 执行步骤

### 步骤1：Action创建与规范化
每个Action必须满足SMART原则：
- **Specific**（具体）：明确做什么，不接受"加强监控"这类模糊表述
  - 正确："为订单服务添加数据库连接池水位监控，阈值设为80%"
  - 错误："加强数据库监控"
- **Measurable**（可度量）：有明确的完成标准
- **Assignable**（可分配）：指定唯一Owner
- **Realistic**（可实现）：在Deadline内技术上可行
- **Time-bound**（有时限）：明确完成日期

### 步骤2：Action分类和优先级
- 分类：
  - 短期止血（1周内）：紧急加固措施防止同类故障重现
  - 中期加固（1月内）：系统性的防护措施建设
  - 长期预防（1季度内）：架构优化和流程改进
- 优先级：
  - P0：不完成有再次故障的高风险
  - P1：显著降低故障风险或提升响应效率
  - P2：改善性质的优化

### 步骤3：分配与确认
- 将Action分配给指定Owner
- Owner需在24小时内确认接受（或提出异议协商调整）
- 为每个Action创建对应的工单/任务项
- 与Owner协商合理的Deadline

### 步骤4：进度跟踪
- 跟踪频率：
  - P0 Action：每日跟进
  - P1 Action：每周跟进
  - P2 Action：每两周跟进
- 状态更新：待开始 → 进行中 → 待验证 → 已完成
- 对于进度滞后的Action，主动了解阻塞原因并协助解决

### 步骤5：逾期处理与升级
- Deadline前3天：自动提醒Owner
- 逾期1天：提醒Owner + CC其直属上级
- 逾期3天：升级至部门负责人
- 逾期7天：升级至VP级别
- 记录逾期原因（资源不足/优先级冲突/技术难度高/需求变更）

### 步骤6：完成验证
- Action标记完成后，需要验证：
  - 实施内容是否与Action描述一致
  - 是否能有效预防同类问题（通过演练或回归测试验证）
  - 相关文档/流程是否同步更新
- 验证通过后正式关闭

## 输入规格

```json
{
  "incident_id": "关联故障ID",
  "actions": [
    {
      "id": "ACTION-001",
      "description": "具体的改进措施描述",
      "category": "short_term|mid_term|long_term",
      "priority": "P0|P1|P2",
      "owner": "责任人",
      "deadline": "截止日期",
      "acceptance_criteria": "验收标准",
      "related_why_level": "对应5-Why的哪一层"
    }
  ]
}
```

## 输出规格

```json
{
  "tracking_dashboard": {
    "total_actions": 12,
    "completed": 8,
    "in_progress": 3,
    "overdue": 1,
    "completion_rate": "66.7%"
  },
  "action_status": [
    {
      "id": "ACTION-001",
      "status": "completed|in_progress|overdue|not_started",
      "progress_notes": "最新进展",
      "last_updated": "最后更新时间",
      "days_remaining": 5,
      "blocker": "阻塞原因（如有）"
    }
  ],
  "overdue_escalations": [
    {
      "action_id": "ACTION-003",
      "overdue_days": 3,
      "escalation_level": "manager|director|vp",
      "reason": "逾期原因"
    }
  ],
  "effectiveness_verification": {
    "verified_actions": ["已验证有效的Action"],
    "same_incident_recurrence": false
  }
}
```

## 最佳实践

1. **宁少勿多**：每次复盘产出的Action控制在5-8个，太多则无法有效跟踪
2. **Owner唯一**：每个Action只有一个Owner（可以有协助者），确保责任明确
3. **关联效果**：Action完成后持续观察，同类故障是否减少
4. **合并同类项**：多次故障产出的相似Action合并执行，避免重复劳动

## 约束条件

- Action创建后不可删除（只能标记为"取消"并说明原因）
- Deadline延期需要Owner申请并说明原因（最多延期一次）
- 季度末统计Action完成率，纳入团队运维质量评估
- Action关闭后6个月内若同类故障重现，需要复查Action有效性
