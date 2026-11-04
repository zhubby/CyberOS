---
title: 前端样式维护清单
description: Web 与 TV 的样式模块归属、公共控件复用和回归验证入口。
type: reference
status: current
audience: [developer]
sourceOfTruth:
  - packages/web/src/styles.css
  - packages/web/src/styles/workspace.css
  - packages/web/src/styles/settings.css
  - packages/web/src/styles/brand.css
  - packages/web/src/styles/hud-workspaces.css
  - packages/web/src/styles/responsive.css
  - packages/web/src/styles/architecture.test.ts
  - packages/web/src/components/common/CustomSelect.tsx
  - packages/web/src/styles/components/create-form.css
  - packages/web/src/tv/tv.css
  - scripts/test-web-styles.mjs
  - eslint.config.js
sidebar:
  order: 3
---

遵循[前端设计语言](/docs/reference/frontend-design/)。以下文件是兼容聚合入口，新增规则进入所属模块，不继续堆叠在入口末尾。

## 文件归属

| 聚合入口 | 规则归属 |
| --- | --- |
| `workspace.css` | `files/`、`downloads/`、`network/`、`storage/`、`docker/`、`shares/`、`terminal/`、`management/`，共享创建流程在 `components/create-form.css`。 |
| `settings.css` | `settings/` 下的外壳、分类布局、操作、资源、设备和蓝牙；公共字段视觉在 `components/forms.css`。 |
| `brand.css` | `foundation/` 的字体、画布和动效；公共控件归 `components/`，业务主题规则归所属模块。 |
| `hud-workspaces.css` | `chat/`、`files/`、`workspace/` 的最终布局及交互细节；共享 HUD 别名在 `foundation/hud-aliases.css`。 |
| `responsive.css` | 只导入各模块的响应式规则，应用骨架在 `foundation/responsive.css`；文件选择器和创建流程各有公共响应文件。 |
| `chat.css` | 导航、会话操作、弹窗、加载、消息、审批和输入区。 |
| `photos.css` | 媒体库、筛选、地图、时间轴、查看器和元数据。 |
| `monitoring-alerts.css` | 告警列表、规则编辑、事件详情和设置。 |
| `tv/tv.css` | `tv/styles/` 的导入、基础尺度、外壳、媒体、遥控和浮层；按钮、表单、下拉、反馈复用 Web 公共文件。 |

模块文件以 200–600 行为维护目标。小型、独立的公共职责可以更短，超过 800 行的文件必须继续拆分。聚合入口不包含声明，不使用编号文件名维持历史顺序。

## 整改与复用清单

| 优先级 | 已处理问题 | 公共归属及约束 |
| --- | --- | --- |
| P1 | 音乐页面覆盖所有按钮，尺寸和禁用/忙碌状态偏离公共控件。 | `components/buttons.css` 统一命令与轻量操作；紧凑尺寸显式选择，业务不重置全部按钮。Docker、存储及文件选择器的底部命令也使用公共按钮，删除局部透明度和颜色覆盖。 |
| P1 | 7 个未定义变量、16 处无回退引用。 | 改用现有边框、焦点、警告、成功和表面语义变量；Web/TV 完整解析入口均有自动检查。 |
| P1 | Web 黄色菜单与 TV 灰蓝菜单不一致，TV 缺少共享变量。 | 共用 `foundation/tokens.css` 和 `select.css`，筛选容器不覆盖控件尺度，保留 TV 的遥控热区及焦点环；照片、网络工具栏与播放栏显式选择公共紧凑尺寸。 |
| P2 | 11 个组件的 47 处原生下拉框。 | 迁移到 `CustomSelect`，保留数值转换、条件选项、禁用、必填和焦点引用；ESLint 对全部 Web TSX 禁止原生下拉。 |
| P2 | 音乐导航选中态与公共页签不一致。 | 复用 `view-tabs` 外观，导航继续使用 `aria-current`。 |
| P2 | 播放栏收起和 TV 音频输出按钮仍使用浏览器默认灰底。 | 复用 `plain-button` 的透明表面与公共状态，保留播放栏的触控及遥控尺寸。 |
| P2 | TV 搜索入口借用输入框容器类，图标和文字重叠。 | 复用公共按钮和现有 TV 搜索行布局，移除仅适用输入框的 `search` 类。 |
| P2 | 弹窗重复定义遮罩、表面、滚动与操作区。 | `modal.css` 提供公共规则，沿用 `ModalPortal` 与焦点管理；Docker/VM 创建流程复用同一模态焦点机制。图标操作复用公共透明表面，Docker 配置弹窗不再覆盖圆角和字段焦点；公共字段同时悬停和聚焦时保持青色焦点边框。 |
| P2 | Docker 借用 `vm-create-*`。 | 统一为 `create-form-*`，共享样式独立于 VM 业务模块。 |
| P2 | 状态、空状态、错误和元数据散落。 | 状态在 `components/status.css`，常见错误和空状态在 `components/feedback.css`；音乐、影视和文件选择器复用元数据外观。 |
| P2 | 业务、品牌和 HUD 层反复覆盖。 | 首轮纯拆分确认声明顺序等价；随后清除在所有消费入口均被后续同一规则覆盖的 137 条历史声明，统一调整由浏览器回归覆盖。 |

继续复用 `PanelHeader`、`MobileAppHeader`、`Switch`、`SearchFilterPopover`、`HelpTip`、`TooltipLayer` 和公共骨架。保留媒体海报、文件列表、终端和 TV 的业务布局与操作尺度。

## 验证入口

```bash
# 文件上限、导入环、未定义变量及现有组件测试
npx vitest run packages/web/src/styles packages/web/src/components/common packages/web/src/tv

# 实际 Chromium：公共控件、业务创建表单、必填与数值、菜单及嵌套模态
npm run test:styles-browser
npm run test:tv-browser
npm run test:chat-browser

# 完整应用移动布局及状态恢复
cd docs
npx playwright test --config mobile.playwright.config.mjs
cd ..

# 全量检查及文档站共享样式回归
make ci
npm run docs:browser
```

控件回归比较 default、disabled、busy 和 focus 的计算样式，覆盖中英文、`1440/820/560/390/320px`、短视口、长文案、减少动态效果、滚动、嵌套 Escape 和焦点恢复。浏览器测试不能代替真实电视观看距离与物理遥控器验收；设备部署结果单独记录。
