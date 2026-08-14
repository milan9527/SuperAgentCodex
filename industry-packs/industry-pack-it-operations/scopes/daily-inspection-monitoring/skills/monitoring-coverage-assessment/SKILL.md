# 监控覆盖率评估

## 技能概述

本技能负责系统性评估IT基础设施的监控覆盖完整性，通过对照CMDB和服务目录识别监控盲区，确保所有服务和组件都被纳入可观测性体系。覆盖率是监控体系有效性的基础前提——未被监控的服务在故障时将成为"黑盒"，无法及时发现和定位问题。

## 适用场景

- 季度监控治理中的覆盖率审查
- 新服务上线后的监控完整性验证
- 等保合规审计中的监控要求检查
- 故障复盘后发现监控缺失的补全

## 执行步骤

### 步骤1：资产清单获取
1. 从CMDB导出当前所有在线资产清单（服务器/数据库/中间件/网络设备/应用服务）
2. 从服务目录（Service Catalog）获取所有已注册服务列表
3. 标注各资产/服务的重要性等级（核心/重要/一般）
4. 获取各监控系统（Prometheus/Zabbix/CloudWatch/APM）已接入的监控对象列表

### 步骤2：覆盖率计算
1. 交叉比对：CMDB资产清单 vs 各监控系统已覆盖对象
2. 按层级计算覆盖率：
   - 基础设施层覆盖率（服务器/网络设备是否有基础指标监控）
   - 应用层覆盖率（应用服务是否有APM/日志监控）
   - 业务层覆盖率（核心业务是否有业务指标监控）
3. 按重要性等级分别计算：核心系统覆盖率、非核心系统覆盖率
4. 输出总体覆盖率得分

### 步骤3：监控盲区识别
1. **完全未覆盖**：在CMDB中存在但无任何监控的资产
2. **部分覆盖**：仅有基础设施监控但缺少应用/业务层监控的服务
3. **Golden Signals缺失**：已监控但不满足四大信号（延迟/流量/错误/饱和度）全覆盖的服务
4. **告警规则缺失**：有监控数据采集但未配置告警规则的指标

### 步骤4：补全计划制定
1. 对每个未覆盖项生成具体的监控接入方案：
   - 推荐监控工具（基于现有体系和技术栈匹配度）
   - 建议采集的关键指标列表
   - 建议的告警阈值（参考同类服务）
   - 接入实施复杂度评估（简单/中等/复杂）
2. 按优先级排序：核心系统完全未覆盖 > 核心系统部分覆盖 > 非核心系统未覆盖
3. 制定补全时间表（目标：核心系统立即补全，非核心系统季度内完成）

### 步骤5：报告输出
1. 输出覆盖率仪表盘数据（总覆盖率/分层覆盖率/分级覆盖率）
2. 输出未覆盖项清单（含补全方案）
3. 与上次评估对比，展示覆盖率变化趋势
4. 标注覆盖率目标达成状态（核心100%/非核心95%）

## 输入规格

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cmdb_assets | array | 是 | CMDB资产清单 |
| service_catalog | array | 是 | 服务目录列表 |
| monitoring_inventory | object | 是 | 各监控系统已接入对象列表 |
| previous_assessment | object | 否 | 上次评估结果（用于对比） |

## 输出规格

```json
{
  "assessment_date": "2024-01-01",
  "overall_coverage": 96.5,
  "by_importance": {
    "core_systems": {"coverage": 100, "target": 100, "status": "达标"},
    "important_systems": {"coverage": 97.2, "target": 95, "status": "达标"},
    "general_systems": {"coverage": 92.1, "target": 95, "status": "未达标"}
  },
  "by_layer": {
    "infrastructure": 99.2,
    "application": 95.8,
    "business": 88.5
  },
  "gaps": [
    {
      "asset": "payment-callback-service",
      "importance": "core",
      "gap_type": "partial_coverage",
      "missing": ["business_metrics", "golden_signals_saturation"],
      "remediation_plan": {
        "tool": "Prometheus + custom exporter",
        "metrics": ["payment_success_rate", "callback_latency_p99", "queue_depth"],
        "estimated_effort": "2人天",
        "priority": "P1"
      }
    }
  ],
  "trend": {
    "vs_last_quarter": "+2.3%",
    "newly_covered": 8,
    "newly_uncovered": 3
  }
}
```

## 最佳实践

1. **CMDB准确性**：覆盖率评估的前提是CMDB数据准确，发现CMDB与实际不一致时需反馈更新
2. **深度优于广度**：核心服务的Golden Signals全覆盖比所有服务仅有基础监控更重要
3. **自动化检查**：将覆盖率检查集成到服务上线流程中（上线前检查清单包含监控配置）
4. **持续跟踪**：每次评估后跟踪补全计划的执行进度
5. **服务Owner负责**：覆盖率gap应关联到具体的服务Owner推动整改

## 约束条件

- 评估周期：每季度至少一次全面评估
- 核心系统覆盖率100%是硬性要求，不达标需立即补全
- CMDB数据滞后超过7天需标注并提醒更新
- 新上线服务需在上线后7天内完成监控接入验证
