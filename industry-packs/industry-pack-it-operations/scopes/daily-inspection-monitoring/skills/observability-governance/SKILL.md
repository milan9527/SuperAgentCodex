# 可观测性治理

## 技能概述

本技能负责监控体系的整体治理和持续优化，包括监控大盘规范化、监控数据保留策略管理、可观测性成熟度评估和改进路线图制定。目标是建立一个标准化、可持续演进的可观测性体系，支撑从故障发现到根因定位的全链路可观测能力。

## 适用场景

- 季度可观测性成熟度评估
- 监控大盘标准化推进
- 监控数据存储策略优化
- 故障复盘中的可观测性改进Action跟踪
- 新技术栈的可观测性规划

## 执行步骤

### 步骤1：可观测性成熟度评估
1. 按照可观测性成熟度模型（L1-L5）评估当前水平：
   - L1 基础监控：仅有基础设施指标（CPU/内存/磁盘）
   - L2 应用监控：增加APM、日志集中化
   - L3 分布式追踪：增加链路追踪、服务拓扑
   - L4 智能运维：增加异常检测、根因推荐
   - L5 自动修复：增加自动化故障处置
2. 对各维度分别评分：Metrics/Logs/Traces/Events
3. 标注当前瓶颈和下一阶段提升方向

### 步骤2：监控大盘规范化审查
1. 检查每个核心服务是否有标准化的监控Dashboard
2. 验证Dashboard是否包含Golden Signals四大类指标：
   - **延迟(Latency)**：P50/P95/P99响应时间
   - **流量(Traffic)**：QPS/并发数/数据吞吐量
   - **错误(Errors)**：错误率/HTTP 5xx比例/异常数
   - **饱和度(Saturation)**：CPU/内存/连接池/队列长度
3. 检查大盘是否支持多时间粒度（5min/1h/1d/7d）
4. 检查是否有同比/环比对比视图
5. 对不达标的大盘输出改进方案

### 步骤3：监控数据存储策略管理
1. 审查当前数据保留策略执行情况：
   - 原始数据（秒/分钟级）：保留15天
   - 1分钟聚合数据：保留90天
   - 1小时聚合数据：保留1年
   - 告警记录：永久保留
2. 评估存储成本与查询需求的平衡
3. 检查是否有未配置降采样（downsampling）的指标造成存储浪费
4. 评估冷热数据分层策略的执行情况

### 步骤4：改进Action跟踪
1. 从故障复盘报告中提取所有监控/可观测性相关的改进Action
2. 跟踪每个Action的状态：待开始/进行中/已完成/逾期
3. 对逾期未完成的Action发出提醒并升级
4. 统计Action完成率和平均完成时长

### 步骤5：治理报告与路线图
1. 输出季度可观测性治理报告：
   - 成熟度评分变化
   - 覆盖率变化趋势
   - 告警质量变化趋势
   - 改进Action完成情况
   - 存储成本趋势
2. 制定下季度改进路线图（具体改进项/Owner/时间表）
3. 标注需要技术投入的改进项（如引入分布式追踪、建设日志分析平台）

## 输入规格

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| service_list | array | 是 | 核心服务清单 |
| dashboard_inventory | array | 是 | 现有监控大盘清单 |
| storage_metrics | object | 是 | 监控数据存储使用情况 |
| postmortem_actions | array | 是 | 故障复盘中的改进Action |
| previous_assessment | object | 否 | 上季度评估结果 |

## 输出规格

```json
{
  "assessment_date": "2024-Q1",
  "maturity_score": {
    "overall": "L3.2",
    "metrics": "L4",
    "logs": "L3",
    "traces": "L2",
    "events": "L3"
  },
  "dashboard_compliance": {
    "total_core_services": 25,
    "compliant_dashboards": 20,
    "non_compliant": 5,
    "compliance_rate": "80%"
  },
  "storage_status": {
    "total_time_series": 1200000,
    "storage_cost_monthly": "¥35,000",
    "retention_compliance": "95%",
    "optimization_potential": "¥5,000/月 (清理无用指标)"
  },
  "action_tracking": {
    "total_actions": 15,
    "completed": 10,
    "in_progress": 3,
    "overdue": 2,
    "completion_rate": "66.7%"
  },
  "roadmap": [
    {
      "initiative": "引入分布式追踪(Jaeger/Zipkin)",
      "priority": "P1",
      "effort": "3人月",
      "expected_impact": "MTTR预计降低40%",
      "target_date": "2024-Q2"
    }
  ]
}
```

## 最佳实践

1. **标准先行**：先定义好监控大盘标准模板，再推动各服务落实
2. **渐进式推进**：不追求一步到位，按成熟度模型逐步提升
3. **成本意识**：可观测性建设需要平衡监控深度和存储成本
4. **Owner制**：每个改进Action需有明确Owner，避免成为公共议题无人推动
5. **与业务对齐**：优先提升核心业务的可观测性水平

## 约束条件

- 评估周期：季度全面评估
- 大盘标准模板需经技术委员会审批
- 数据保留策略变更需评估合规要求（安全日志不少于6个月）
- 路线图中涉及新工具引入需经架构评审
- 改进Action跟踪频率：每2周review一次进度
