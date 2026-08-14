# 恢复方案推荐 (Recovery Recommendation)

## 技能概述

恢复方案推荐技能基于根因分析结论，为故障指挥官提供可执行的恢复方案建议，包含方案对比、风险评估和预计恢复时间。在故障响应中，选择正确的恢复策略直接决定MTTR，错误的恢复决策可能导致二次故障或恢复时间成倍延长。

## 使用场景

- 根因定位后的恢复方案制定
- 多种恢复方案的对比分析
- 恢复方案执行前的风险评估
- 首选方案失败后的备选方案推荐

## 执行步骤

### 步骤1：根因-方案映射
根据不同根因类型，确定对应的恢复策略族：

| 根因类型 | 首选恢复策略 | 备选策略 |
|----------|-------------|----------|
| 代码缺陷 | 代码回滚 | 热修复/功能降级 |
| 配置错误 | 配置回滚 | 修正配置重新发布 |
| 容量不足 | 紧急扩容 | 限流/降级 |
| 依赖故障 | 切流/降级 | 等待恢复+超时兜底 |
| 数据异常 | 数据修复 | 回滚到备份点 |
| 硬件故障 | 切换备用节点 | 人工更换+数据恢复 |
| 网络故障 | 流量切换 | DNS切换/CDN回源 |

### 步骤2：方案可行性评估
对每个候选方案评估：
- 前置条件是否满足（如回滚：上一个稳定版本是否可用？回滚脚本是否就绪？）
- 执行所需时间估算（基于历史数据或经验值）
- 所需权限和审批（如全站切流需要VP级审批）
- 人员就位情况（执行该方案需要哪些角色参与）

### 步骤3：风险评估
对每个可行方案评估风险：
- 恢复失败概率（基于历史成功率和当前条件）
- 二次故障风险（如回滚后是否可能引入新问题）
- 数据影响（如回滚后期间的增量数据如何处理）
- 业务影响（如降级方案下用户体验的损失程度）
- 不可逆程度（方案执行后是否可以回退）

### 步骤4：方案排序和推荐
- 综合考虑恢复时间、风险等级、业务影响三个维度
- 推荐最优方案（通常是恢复最快+风险最低的）
- 明确备选方案和切换条件（如"首选方案执行10分钟后无效则切换备选"）
- 给出方案执行的详细步骤清单

### 步骤5：输出决策建议
- 以结构化格式输出方案对比表
- 明确推荐方案和推荐理由
- 标注需要决策者确认的关键决策点
- 提供方案执行的CheckList

## 输入规格

```json
{
  "root_cause": {
    "type": "code_bug|config_error|capacity|dependency|data|hardware|network",
    "description": "根因描述",
    "confidence": "high|medium|low",
    "affected_components": ["受影响组件"]
  },
  "current_impact": {
    "affected_users": "影响用户数",
    "business_loss_per_minute": "每分钟业务损失",
    "duration_minutes": "已持续时间"
  },
  "available_options": {
    "rollback_available": true,
    "rollback_version": "v1.2.3",
    "scale_out_possible": true,
    "failover_ready": true,
    "degradation_switch": true
  }
}
```

## 输出规格

```json
{
  "recommended_plan": {
    "strategy": "rollback|scale_out|failover|degradation|hotfix|data_repair",
    "description": "方案描述",
    "estimated_recovery_time_minutes": 15,
    "risk_level": "low|medium|high",
    "execution_steps": ["步骤1", "步骤2", "步骤3"],
    "success_criteria": "恢复成功的验证标准",
    "rollback_plan": "如果此方案失败的回退计划"
  },
  "alternative_plans": [
    {
      "strategy": "备选方案",
      "switch_condition": "何时切换到此方案",
      "estimated_recovery_time_minutes": 30,
      "risk_level": "medium"
    }
  ],
  "comparison_matrix": {
    "headers": ["方案", "恢复时间", "风险", "业务影响", "推荐度"],
    "rows": [["回滚", "10min", "低", "无", "★★★★★"]]
  },
  "decision_points": ["需要决策者确认的事项"],
  "prerequisites_check": ["执行前必须确认的前置条件"]
}
```

## 最佳实践

1. **速度优先原则**：在多个方案风险相近时，选择恢复最快的方案
2. **先止血后治根**：可以先用降级/限流快速止血，再慢慢排查修复根因
3. **考虑数据一致性**：涉及数据回滚的方案需要特别评估增量数据处理
4. **备选方案必须有**：永远准备Plan B，首选方案失败时能快速切换

## 约束条件

- 方案推荐必须在根因确认后5分钟内完成
- 高风险方案（如全站切流、数据库回滚）必须经过故障指挥官确认
- 不得推荐无回退能力的不可逆操作作为首选方案
- 恢复时间估算需保守（实际执行通常比估算多50%）
