# BizOps 易用性改进 - 高保真交互设计

Super Agent 平台从"搭积木工具"到"端到端 BizOps 产品"的交互设计原型。

## 运行方式

```bash
cd design/bizops-usability-improvement
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`

## 包含的设计页面

### 1. 解决方案市场 (Solution Marketplace)
- 行业解决方案卡片展示（分类筛选、搜索）
- 方案详情弹窗（包含 Agent、Workflow、Connector 清单）
- 配置表单（填入业务变量：域名、品牌名、目标平台等）
- 部署动画 + 完成确认

### 2. 引导式配置向导 (Onboarding Wizard)
- 对话式交互，逐步引导用户完成配置
- 选项卡片 + 自由输入混合交互
- 实时进度条
- 方案预览卡片 + 一键部署

### 3. 业务域蓝图 (Scope Blueprint)
- 文档上传区域（拖拽 + 点击）
- AI 分析动画
- 蓝图结构化展示（Agent 团队 / 工作流 / 连接器）
- 可展开查看详情（Agent 技能、Workflow 节点流程）
- 可编辑 + 一键部署

### 4. 连接器市场 (Connector Marketplace)
- 连接器卡片网格（分类、搜索、状态标识）
- 连接详情弹窗（功能列表、权限说明、认证方式）
- OAuth 一键授权流程
- 已连接状态管理

## 技术栈（与 Super Agent 前端一致）

- React 19 + TypeScript
- Tailwind CSS v4（`@tailwindcss/vite` 插件）
- Framer Motion（动画）
- Lucide React（图标）
- React Router v7（页面路由）

## 主题系统

与 Super Agent 前端完全一致的主题方案：

- **Dark-first 设计**：默认深色模式，使用 `.dark` class 控制
- **CSS 变量调色板反转**：浅色模式通过反转 gray 色阶实现，无需为每个组件添加 `dark:` 变体
- **品牌色**：blue-* → Indigo，purple-* → Violet
- **三种模式**：深色 / 浅色 / 跟随系统（右上角切换按钮）
- **ThemeContext**：`useTheme()` hook + localStorage 持久化

## 设计原则

- **渐进式披露**：不一次性暴露所有配置项，通过对话/步骤逐步引导
- **即时反馈**：每个操作都有明确的视觉反馈（动画、状态变化）
- **最小输入**：用户只需提供业务信息（域名、品牌名），技术配置由系统自动完成
- **可审阅**：蓝图模式让用户在部署前看到完整方案，可修改后再确认
