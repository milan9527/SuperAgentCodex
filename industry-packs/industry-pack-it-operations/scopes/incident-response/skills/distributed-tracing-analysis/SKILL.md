# 分布式链路追踪分析 (Distributed Tracing Analysis)

## 技能概述

分布式链路追踪分析技能利用Jaeger、SkyWalking、Zipkin等APM系统的Trace数据，分析请求在微服务架构中的完整调用路径，定位导致故障的异常节点和故障传播路径。在微服务架构下，一个用户请求可能经过10+服务节点，链路追踪是定位"哪个环节出了问题"的最直接手段。

## 使用场景

- 请求超时类故障的瓶颈定位
- 错误率上升时的异常节点识别
- 服务间调用失败的故障传播路径分析
- 性能劣化的慢调用溯源

## 执行步骤

### 步骤1：采集异常Trace样本
- 根据故障时间窗口筛选异常Trace：
  - 错误Trace（HTTP 5xx / gRPC Error / 业务异常码）
  - 慢Trace（响应时间>P99阈值的请求）
  - 超时Trace（请求未完成或超时返回）
- 采集足够的样本量（建议20-50条）以确保统计意义
- 同时采集同时间段的正常Trace作为对照

### 步骤2：调用链拓扑分析
- 绘制请求调用链路图（Service A → Service B → Service C → DB）
- 标注每个节点的耗时、状态、错误信息
- 识别调用链中的异常节点（耗时突增/错误返回/超时）
- 分析异常是发生在哪一层（网络层/应用层/数据层）

### 步骤3：故障传播路径识别
- 从异常Trace中识别根源故障点和影响传播路径：
  - 向下游传播：Service A超时 → 调用方Service B超时 → 前端502
  - 资源竞争：Service X占用连接池 → Service Y获取不到连接 → 超时
- 区分"根源故障"和"受害者"：真正出问题的节点 vs 被影响的上游调用方

### 步骤4：对比分析
- 将异常Trace与正常Trace对比：
  - 调用路径是否发生变化（如多了一跳、路由到了不同节点）
  - 各节点耗时分布对比（哪个环节耗时显著增长）
  - 调用参数是否有差异（特定参数触发的问题）
- 与历史同时段Trace对比，确认是新增问题还是已有问题恶化

### 步骤5：输出分析结论
- 明确故障定位：哪个服务的哪个接口/操作是问题根源
- 故障传播链路描述（从根源到表面现象的完整路径）
- 异常指标量化：错误率、延迟增幅、影响的Trace比例
- 建议恢复动作（重启/限流/降级该节点）

## 输入规格

```json
{
  "time_range": {
    "start": "分析起始时间",
    "end": "分析结束时间"
  },
  "filter_criteria": {
    "service_name": "目标服务（可选）",
    "min_duration_ms": 3000,
    "status": "error|slow|timeout",
    "trace_ids": ["特定Trace ID（可选）"]
  },
  "apm_source": "jaeger|skywalking|zipkin",
  "normal_baseline": {
    "avg_duration_ms": 200,
    "p99_duration_ms": 1000,
    "error_rate": 0.01
  }
}
```

## 输出规格

```json
{
  "root_cause_node": {
    "service": "故障根源服务",
    "operation": "故障操作/接口",
    "error_type": "错误类型",
    "evidence": "证据描述"
  },
  "propagation_path": [
    {"from": "ServiceA", "to": "ServiceB", "impact": "timeout propagation"}
  ],
  "anomaly_statistics": {
    "error_trace_ratio": "错误Trace占比",
    "avg_duration_increase": "平均延迟增幅",
    "affected_operations": ["受影响的操作列表"]
  },
  "comparison_with_normal": "与正常Trace的关键差异",
  "recommended_actions": ["建议的恢复动作"]
}
```

## 最佳实践

1. **先看全局再看局部**：先从服务拓扑图了解整体调用关系，再深入异常节点
2. **采样偏差注意**：APM通常有采样率限制，低采样率下可能遗漏间歇性问题
3. **关注扇出节点**：高扇出（一个服务调用多个下游）的节点更容易成为故障放大器
4. **Span标签利用**：充分利用Span中的标签信息（如DB语句、HTTP参数）辅助定位

## 约束条件

- 链路分析依赖APM系统的数据完整性，若Trace丢失则需要结合日志补充
- 分析时不要只看单条Trace，需要统计多条以避免个例偏差
- 异步调用链（消息队列）可能无法通过Trace直接关联，需要辅助手段
- 分析结论的置信度与样本量正相关，样本不足时需明确标注
