# 日志模式分析 (Log Pattern Analysis)

## 技能概述

日志模式分析技能通过对ELK/Loki/云日志服务等系统中的应用日志和系统日志进行智能分析，识别错误模式、异常特征和故障线索。日志是故障排查中信息量最丰富的数据源，包含了详细的错误堆栈、业务上下文和时序信息。

## 使用场景

- 故障排查中的错误日志检索和分析
- 错误模式识别（新增错误类型 vs 已知错误突增）
- 日志时序分析（确定错误首次出现时间）
- 跨服务日志关联（通过RequestID/TraceID关联多服务日志）

## 执行步骤

### 步骤1：日志检索
- 确定检索范围：
  - 时间范围：故障前30分钟到当前
  - 服务范围：受影响服务及其直接上下游
  - 日志级别：优先检索ERROR/FATAL，辅以WARN
- 构建检索查询（支持Elasticsearch Query DSL / LogQL）
- 获取错误日志样本

### 步骤2：错误模式识别
- 对错误日志进行聚类分析（基于错误类型、堆栈指纹）
- 识别以下模式：
  - 新增错误：故障前不存在的错误类型（高度可疑）
  - 突增错误：已有错误类型但频率突然升高
  - 周期性错误：按固定间隔出现（可能与定时任务相关）
  - 级联错误：多个服务出现关联错误（上游异常传播）
- 统计各错误模式的出现频率和时间分布

### 步骤3：错误堆栈分析
- 解析关键错误的堆栈信息：
  - 异常类型（NullPointerException/TimeoutException/ConnectionRefused等）
  - 错误发生的代码位置（类名.方法名:行号）
  - 调用堆栈链路（从入口到错误点的完整调用路径）
- 关联到具体代码版本和最近变更

### 步骤4：时序分析
- 绘制错误频率的时间线
- 确定错误首次出现的精确时间点
- 分析错误增长趋势（突发/渐进/波动）
- 对比错误首现时间与变更执行时间的关系

### 步骤5：跨服务日志关联
- 通过RequestID/TraceID关联同一请求在多个服务中的日志
- 构建请求的完整日志链路
- 识别请求处理过程中最先出现异常的节点
- 输出结构化的故障证据链

## 输入规格

```json
{
  "search_criteria": {
    "time_range": {"start": "起始时间", "end": "结束时间"},
    "services": ["目标服务列表"],
    "log_levels": ["ERROR", "FATAL", "WARN"],
    "keywords": ["可选的关键字过滤"],
    "trace_id": "可选的TraceID精确查询"
  },
  "log_source": "elasticsearch|loki|cloudwatch|aliyun_sls",
  "baseline": {
    "normal_error_rate": "正常错误率基线",
    "known_errors": ["已知的可忽略错误模式"]
  }
}
```

## 输出规格

```json
{
  "error_patterns": [
    {
      "pattern_id": "模式ID",
      "error_type": "错误类型",
      "message_template": "错误消息模板",
      "count": "出现次数",
      "first_seen": "首次出现时间",
      "affected_services": ["涉及服务"],
      "is_new": true,
      "sample_stacktrace": "样本堆栈",
      "suspected_cause": "疑似原因"
    }
  ],
  "timeline": {
    "error_start_time": "错误开始时间",
    "peak_time": "错误峰值时间",
    "trend": "increasing|stable|decreasing"
  },
  "cross_service_correlation": {
    "root_service": "最先出错的服务",
    "propagation_sequence": ["错误传播顺序"]
  },
  "investigation_clues": ["发现的排查线索"]
}
```

## 最佳实践

1. **先宏观后微观**：先看错误率趋势图，再深入具体错误内容
2. **关注新增模式**：新出现的错误类型比已有错误突增更值得关注
3. **利用结构化日志**：如果日志是JSON格式，充分利用字段进行精确筛选
4. **注意日志延迟**：日志采集和索引有延迟（通常1-5秒），分析时考虑时间偏移

## 约束条件

- 日志量可能巨大（每秒GB级），检索需要合理限定范围避免超时
- 非结构化日志（纯文本）的分析准确度低于结构化日志
- 日志中可能包含敏感信息，分析输出中需脱敏处理
- 日志保留期有限（通常15天原始数据），历史比对受限
