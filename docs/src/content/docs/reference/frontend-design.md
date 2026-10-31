---
title: 前端设计语言
description: CyberOS Web、TV 与文档站的视觉、布局、交互和响应式约束。
type: reference
status: current
audience: [developer]
sourceOfTruth:
  - packages/shared/src/hud-tokens.css
  - packages/web/src/styles/base.css
  - packages/web/src/styles/switch.css
  - packages/web/src/styles/brand.css
  - packages/web/src/styles/layout.css
  - packages/web/src/styles/chat.css
  - packages/web/src/styles/workspace.css
  - packages/web/src/styles/photos.css
  - packages/web/src/styles/music.css
  - packages/web/src/styles/video.css
  - packages/web/src/components/playback/PlaybackBar.tsx
  - packages/web/src/components/video/VideoLibraryPanel.tsx
  - packages/web/src/styles/responsive.css
  - packages/web/src/styles/interactions.css
  - packages/web/src/components/chat/ChatPane.tsx
  - packages/web/src/components/common/Switch.tsx
  - packages/web/src/components/common/CustomSelect.tsx
  - packages/web/src/components/common/SearchFilterPopover.tsx
  - packages/web/src/styles/search-filter.css
  - packages/web/src/components/common/ModalPortal.tsx
  - packages/web/src/styles/modal.css
  - packages/web/src/styles/select.css
  - eslint.config.js
  - packages/web/src/components/workspace/ManagementDashboard.tsx
  - packages/web/src/components/workspace/PanelHeader.tsx
  - packages/web/src/components/workspace/WorkspacePane.tsx
  - packages/web/src/components/workspace/PhotoLibraryPanel.tsx
  - packages/web/src/components/workspace/PhotoSearchFilterMenu.tsx
  - packages/web/src/components/settings/SettingsModal.tsx
  - packages/web/src/tv/tv.css
  - docs/src/styles/custom.css
  - packages/web/public/cyberos-icon.svg
sidebar:
  order: 2
---

这份文档是 CyberOS 主 Web、TV 和文档站的共同设计规范。业务需求可以改变信息和流程，但不能在局部 CSS 中建立另一套颜色、几何或交互语言。三端共享基础令牌和状态语义，并分别适配操作密度、远距离观看与长文阅读。

当前方向参考 Cyberpunk 2077 UI 的工业菜单语言：深黑设备表面、暖红结构层、稀疏黄色命令、红色风险与选择、青色信息焦点、硬切角和编号层级。实现只能借鉴设计方法，不得复制游戏标志、专有字体、Behance 原图或其他受限素材。

## 1. 产品性格

CyberOS 是个人 Linux NAS 的本地控制系统。界面要像可操作的设备菜单，而不是营销页或装饰性 dashboard。

- **高密度、可扫描**：优先展示状态、数据和下一步操作，使用稳定列、硬分隔线和清晰对齐。
- **单一深色 HUD**：不提供浅色、深色或跟随系统选项，也不读取旧的主题本地存储值。
- **工业结构**：深黑和暗红表面承载内容，黄色只定义主命令与当前入口，1px 结构线和 2px 状态轨建立层级。
- **尺度反差**：标题短、粗、紧凑；技术元数据使用更小的等宽文字。面板内不使用 hero 级字号。
- **状态可验证**：颜色必须同时配合图标、文字、ARIA 状态或结构位置，不能只靠红色或青色传意。
- **流程不变**：视觉改造不能绕过审批、安全边界、焦点管理或现有操作步骤。

不应出现巨型 hero、装饰性渐变球、胶囊控件、柔和圆角卡片、卡片套卡片、持续闪烁、第三方品牌标志或解释界面风格的可见文案。

## 2. 应用骨架

### 桌面

根布局保持 Agent / Workspace 双工作区，中间是支持鼠标和键盘的工业分隔结构。

- `.app-shell` 占满视口；Agent 最小宽度 `560px`，Workspace 最小宽度 `460px`。
- Agent 聊天页头与所有 Workspace `PanelHeader` 必须复用 `.app-titlebar` 和 `--app-titlebar-height`，桌面总高度固定为 `70px`，`560px` 以下统一为 `64px`，两侧底边基线不得错位。
- Agent 导航是黑色控制轨，当前会话使用黄色反色面和红色左轨。
- Workspace 是深色操作画布，最右侧面板导航使用黑色轨道，当前面板使用黄色反色面和红色状态轨。
- 分栏拖拽区使用黑色结构、黄色双线和红/青状态标记，不能因 hover 改变宽度。
- 页面骨架固定，面板内容在自身区域滚动；隐藏原生滚动条不能损失滚轮、触控板、触摸或键盘滚动。
- 公共播放条占应用骨架最后一行；桌面跨 Agent / Workspace，窄屏位于当前工作区下方。不得覆盖聊天输入框或面板末行，切换面板不卸载播放状态。
- 常驻区块使用完整画布和分隔线。只有可拖拽组件、审批项、重复交互项、弹窗和明确工具才使用封闭框。
- **无必要不等分块**：独立功能、配置和状态区块默认纵向排列，每块占据所在内容容器的一整行。不得仅为填满宽屏或追求对称而使用二等分、多等分布局；只有明确需要并列比较、紧密关联的字段或用户自定义工作区时才采用多列，并保证窄屏阅读顺序和可用宽度。

### 窄屏

既有响应式信息架构不变：

| 边界 | 规则 |
| --- | --- |
| `1040px` | 切换为单列，以黑色顶部轨切换 Agent / Workspace；通知和设置仍只有一个入口。 |
| `860px` | 设置切为上下结构，导航变为可横向滚动的黑色轨。 |
| `620px` | 管理区和文件区堆叠；页头保持单行，操作区可在自身范围滚动。 |
| `520px` | 预览隐藏次要文件列；Photo 瀑布墙固定两列。 |
| `360px` | Composer 主次操作收窄为图标按钮，输入和按钮不能溢出。 |

验收覆盖 `1440/820/560/390/320px`，中文和英文各检查一次。长文件名、路径、错误和按钮文案必须省略、安全换行或缩放容器，不能制造页面级横向滚动。

## 3. 品牌与资产

- CyberOS 图标和文字是第一视口的品牌信号。空间受限时只显示图标，设置和启动界面使用“图标 + CyberOS”。
- 图标保持现有几何和比例；黑色轨上可通过呈现层反白，不建立 Cyberpunk 标志或第三方联名版本。
- 不引入 Behance 图片、游戏截图、Cyberpunk logo、专有字体或从参考项目提取的图形文件。
- 图形装饰只由 CSS 结构线、状态轨、编号和短切角构成，不创建仿冒品牌素材。

## 4. 视觉令牌

### 字体

字体通过 Fontsource 自托管：

- 主 Web、TV 导航、标题、按钮和数字层级：`Rajdhani` 的 `400/500/600/700`，中文回退到 `Noto Sans SC Variable`。
- 文档导航和标题使用 `Rajdhani`；长文正文优先使用 `Noto Sans SC Variable`，保证中英文连续阅读。
- 技术元数据、路径、代码和终端：`JetBrains Mono Variable`，保留用户配置代码字体和字号的能力。
- 三端不使用 Inter、Newsreader 或 Noto Serif SC，字体均由 Fontsource 自托管。

正文通常为 `12-14px`；面板标题通常为 `17-22px`。标题、页签和命令可使用大写英文；中文保持原文，不增加字距。任何字号都不得随视口宽度连续缩放。

### 颜色

唯一基础调色板：

| 角色 | 值 | 用途 |
| --- | --- | --- |
| 主背景 | `#050a0e` | 应用骨架、TV 外壳、文档底面、终端和媒体框。 |
| 深色表面 | `#0d090d` / `#160d12` / `#211016` | 内容层、工具层和抬升层。 |
| 命令黄 | `#fcee0a` | 主命令、当前入口和关键进度，不作为大面积画布。 |
| 风险红 | `#ff003c` | 危险操作、错误、当前选择轨和关键警示。 |
| 信息青 | `#00f0ff` | 键盘/遥控焦点、连接反馈和精确 hover。 |

`packages/shared/src/hud-tokens.css` 定义原始令牌和跨端语义角色；Web、TV 和 docs 再映射为各自的组件令牌。组件不直接创建新的主色，红色与青色不能扩散为大面积背景，也不能单独承担状态语义。

### 几何

- 默认圆角为 `0`。封闭面板用 `8/12/18px` 视觉切角、角标或不裁切内容的 CSS 结构装饰。
- 按钮的零圆角是强制约束，包含图标、关闭、取消、保存、危险操作和弹窗内按钮，不能作为页面局部可覆盖的默认值。
- 不在包含可聚焦子项的容器上使用会裁掉焦点环的 `clip-path`。焦点环必须完整显示在控件外侧。
- 边框以 `1px` 结构线为主；当前选择和关键分隔使用 `2-5px` 状态轨。
- 主操作可使用 `3-5px` 黑色硬偏移底板。hover 只移动 `1px`，active 收紧底板，不缩放控件。
- 图标按钮具有稳定宽高和至少 `32px` 操作面；移动触控操作按现有布局保持可点击区域。
- 间距沿用 `4/6/8/10/12/14/18/20/24/32px` 的紧凑节奏。

## 5. 组件状态

按钮、图标按钮、输入框、选择器、页签、表格行、菜单、Toast 和对话框必须覆盖：default、hover、active、selected、focus、disabled、busy、error。

- **Switch 与 checkbox**：启用/禁用、自动启动、只读模式等单一布尔设置统一使用共享 HUD Switch，并暴露 `role="switch"` 与 `aria-checked`。checkbox 只用于多选列表、筛选条件、权限选择和危险操作确认，不能用原生 checkbox 表现服务开关。

- **Hover**：深色表面使用青色边框、青色角标或轻微抬升层，不把整块内容染成高饱和色。
- **Active**：位移最多 `1px`，硬偏移底板收紧；禁止缩放。
- **Selected**：红色状态轨配合反色面、图标或 `aria-selected` / `aria-pressed`。
- **Focus-visible**：`2px #00f0ff` 外环和 `3px` offset；不能被切角或父容器裁切。
- **Disabled**：降低对比但保持文本可读、尺寸稳定和 `not-allowed` 指针。
- **Busy**：使用黑底黄字、稳定尺寸、`aria-busy="true"` 和 spinner 或忙碌图标。
- **Error**：红色边框或轨道必须配合错误图标、文案或 `role="alert"`。

常见操作使用 `lucide-react` 图标。纯工具操作优先图标按钮并提供本地化的 `aria-label` 和 `title`；明确命令可使用图标加短文本。所有操作使用真实语义元素。

### 按钮（强制）

- **所有按钮必须直角**：原生 `button`、按钮类型的 `input` 和语义为 `role="button"` 的控件，四角均为 `0`；普通按钮、图标按钮、关闭按钮、页签、菜单操作与 Switch 一并遵守。禁止圆角、胶囊形或圆形按钮，也禁止通过按钮伪元素背景变相添加圆角。
- 主操作使用命令黄底和深色文字；次操作使用深色表面、暖白文字与结构边框；危险操作复用风险红及已有确认流程。颜色、字体、间距和硬偏移底板复用共享令牌，不另建页面风格。
- default、hover、active、selected、focus-visible、disabled 和 busy 状态均保持四角为 `0`、操作面尺寸稳定。图标按钮至少 `32px`；直角造型不能缩小触控区域或裁掉青色焦点外环。
- **规则不依赖挂载位置**：弹窗、嵌套弹窗、全屏层和挂载到 `document.body` 的 Portal 都必须生效。Web 在 `brand.css` 使用全局 `border-radius: 0 !important` 约束按钮，不能再依赖 `.app-shell` 祖先；基础主、次、危险按钮也直接定义为 `0`。
- 新增或修改按钮时禁止通过局部 CSS、内联样式、单角半径、交互状态或 `!important` 覆盖直角约束。验收检查浏览器计算样式中的四个角均为 `0px`，并覆盖主按钮、次按钮、危险按钮、图标按钮及 Portal 场景。

## 6. 动效

动效模拟短促设备状态切换，不模拟故障闪烁。

- 启动屏使用一次诊断面板揭示和扫描进度。
- Agent / Workspace 首次挂载使用约 `260ms` 的短揭示。
- 当前会话、当前面板和设置导航使用约 `160ms` 的状态轨跳变。
- loading spinner 可以持续旋转；其他元素不得持续闪烁、抖动或循环位移。
- `prefers-reduced-motion: reduce` 下关闭面板揭示、状态跳变、骨架移动和非必要过渡；加载和错误信息仍可被理解。

## 7. 核心界面

### Agent 与聊天

- Agent 导航保持黑色控制轨；会话使用编号层级，当前项黄底黑字并带红色左轨。
- Agent 页头只展示会话编号、标题和会话操作，不重复显示“就绪”等运行状态徽标；连接状态保留在侧栏底部，任务反馈放在 Composer。
- 消息是开放式分层记录，不使用圆角气泡。头像、左侧记录线、作者和时间共同区分用户与 Agent。
- Composer 是黑色命令框，输入使用黄字，顶部青色短轨表示可输入状态；提交、取消和投递模式保持原业务语义。
- 审批卡使用硬边框和明确的允许/拒绝操作，不能弱化风险信息或跳过确认。
- 操作生命周期进入通知中心，不伪装成聊天消息。

### Workspace 与文件

- `PanelHeader` 继续承载图标、标题/副标题和直接操作。页头不添加重复统计或状态徽标；文件页头不展示存储池“就绪”等状态，也不保留状态占位列。
- 文件列表使用硬分隔线和黑色表头。hover 反色为黑底黄字；选中行同时使用红色轨和选择语义。
- 文件搜索保持紧凑单行；高级筛选使用 `SlidersHorizontal` 菜单，Escape 关闭并恢复焦点。
- 搜索结果只渲染纯文本和结构化高亮，不注入服务端 HTML。加载更多不能重排已有结果。
- 文件操作保留审批、安全路径、遍历防护和下载行为；视觉重构不得改变 API 或协议。

### 管理面板与终端

- Docker、VM、网络、存储、共享、下载和监控保持现有数据流、表格和可编辑网格。
- HUD 区块无圆角，使用结构线、黑色顶部轨或硬偏移底板建立层级；页面区块之间不要再套卡片。
- Share 按 SMB、WebDAV、FTP、NFS、DLNA 分为独立协议区块，默认各占整行；服务区块汇总真实运行状态。协议内新增、编辑、启停、删除独立提交，禁用保留归属。每条共享必须有明确协议归属；编辑弹窗复用全视口模态与焦点管理。
- 布局编辑模式、拖拽抓手、键盘移动、调整尺寸和本地持久化保持现状。小于 `620px` 时固定单列并禁用拖拽缩放。
- 终端、控制台和代码区固定为黑色高对比表面，颜色从 CSS 令牌读取。主题切换不得作为重绘依赖。

### Photo、预览与编辑器

- Photo 查询区使用黄色控制轨，时间线和地图使用黑色媒体面。缩略图选择同时显示红框、红色选择控件和 `aria-pressed`。
- Photo 筛选弹层保留类型、相机、镜头、日期、曝光、评分、位置、关键词和高级元数据条件；关闭不提交草稿，重置保留文本搜索。
- storage pool、媒体路径和正常状态不占常驻信息栏。只有降级、离线、Worker 异常或稳定错误码在工具栏显示可聚焦异常入口。
- Photo 时间线保持 API 顺序、日期分组、真实宽高比、多列瀑布墙、游标分页、延迟加载和分页重试。地图视图不启用时间线分页观察器。
- 灯箱、文件预览和编辑器使用黑色媒体框、黄色控制轨和红色选择/危险状态。关闭按钮、Escape 和焦点恢复保持可用。

### Music 音乐库

- Music 与 Photo 并列，采用概览、专辑、艺术家、歌曲和歌单横向导航。以真实方形专辑封面为视觉主体，保持现有深色令牌、零圆角和紧凑密度。
- 音乐与影视的查询工具栏统一参照文件面板：单行搜索框加右侧 `SlidersHorizontal` 图标按钮。来源、年份、类型、排序、收藏及观看状态等条件放入共享 `SearchFilterPopover`，不占常驻工具栏；所有下拉使用 `CustomSelect`，禁止原生 `<select>`。浮窗复用文件筛选的尺寸、字段、操作区与 HUD 样式，应用和重置后关闭并恢复触发器焦点；重置保留当前文本搜索及所在合集，Escape 或点击外部关闭时不提交草稿。嵌套下拉展开时，Escape 先关闭下拉，再关闭筛选浮窗；窄屏和短视口下内容在浮窗内滚动。
- 音乐按面板容器宽度响应；容器小于 `620px` 隐藏歌曲专辑列，小于 `360px` 固定两列封面。队列和歌词放入可关闭抽屉，不创建常驻三栏。
- 音乐控制遥控 NAS，公共播放条按“此设备 / NAS”区分浏览器影视与 NAS 音乐或影视，显示各自实际输出与播放状态；无恢复队列时隐藏，暂停或异常时保留控制入口。窄屏将设备、音量和模式收进正在播放抽屉。
- 音乐与 NAS 影视共享一个播放会话；浏览器影视独立播放。NAS 跨类型接管前明确确认。音箱失联、NAS 或播放服务重启后保留队列并等待手动恢复，不自动改用其他音箱。
- 队列提供拖动及键盘上移/下移；歌词以文本渲染，LRC 根据服务端播放进度高亮。来源路径与正常扫描状态不占主面板常驻信息栏。

### Video 影视库与公共播放

- Web / TV 共享首页、电影、剧集、合集和待看导航；首页按继续观看、下一集、最近入库、待看排列。以真实海报为主体，未知技术能力不显示推测徽标。
- 详情使用海报、简介、播放命令、多版本和分季选集；小容器堆叠信息，海报墙在最窄容器保持两列。来源、扫描和匹配纠错放入管理入口。
- Web 默认“在此播放”，TV 播放使用明确的独立命令。浏览器全屏隐藏公共播放条；最小化保留视频节点、进度与音量。
- 公共条的设备页签始终明确控制对象；NAS 播电影时保留音乐队列入口。不同设备的操作不能隐式作用到另一端。
- 播放、音量和进度控件复用提交式滑杆，拖动结束后提交；输出切换必须明确执行。遥控焦点使用共享青色焦点环，TV 增大操作面和文字密度。

### 设置、通知与弹窗

- 设置是大型深色系统菜单：黑色导航轨、暗红正文层、黄色当前入口和硬边框配置区。只保留语言偏好，不展示主题选项。
- 设置在 `860px` 下切为上下结构；导航横向滚动并自动显示当前项。
- 设置中的独立区块统一复用 `settings-page-grid` 的单列整行布局，媒体元数据、媒体库状态等按顺序上下排列；不得用页面局部样式将独立区块改成左右等分。
- **设置下拉框禁止使用原生样式**：所有设置页面、内部弹窗及设置复用的共享控件必须使用 `CustomSelect`，触发器和展开选项都遵循共享 HUD 样式。禁止使用原生 `<select>`；仅添加 CSS 或 `appearance: none` 不符合要求。保留键盘导航、选中与禁用状态、长文本省略、Escape 关闭和焦点恢复，展开菜单不得被滚动容器裁切。`eslint.config.js` 对设置组件及共享 Wi-Fi 设置组件执行此限制；新增设置共享组件时同步纳入检查范围。
- 密钥输入框的清除操作放在框内右侧，待清除状态使用文字占位提示并提供撤销；提交设置后才清除已保存的凭据，不另占一行 checkbox。
- 无线网络设置页只展示网卡连接与热点状态。Scan 打开网络弹窗并扫描附近 SSID；选择、连接、编辑、遗忘已保存网络、射频开关和断开连接都在弹窗内完成。热点配置、启停和删除也放在热点弹窗内，保留风险确认和外部配置只读限制。
- 通知中心使用黑色 HUD 抽屉，未读项显示红色状态轨；点击单项只更新该项，不意外关闭抽屉。
- Toast 固定在视口层级并自动消失；可追溯的生命周期信息进入通知中心。
- 对话框必须有标题、关闭操作、焦点进入、Escape 关闭和焦点恢复。危险操作保留明确二次确认。
- **所有模态弹窗在整个界面居中**：设置、确认、编辑、文件选择、预览和嵌套弹窗的遮罩必须覆盖整个视口，内容水平、垂直居中；位置不随触发入口属于左侧 Agent 或右侧 Workspace 而改变，也不相对局部面板、卡片或设置正文居中。统一使用 `ModalPortal` 挂载到应用根层，全屏播放时使用当前全屏层；禁止在带有 transform、容器查询或滚动裁切的面板内直接挂载遮罩。嵌套弹窗使用共享层级，保持顶层交互、焦点圈定和关闭后的焦点恢复；窄屏保留安全边距，长内容在弹窗内滚动。ESLint 拦截直接用原生容器创建模态遮罩的写法。

## 8. 文案与本地化

- 用户可见文案进入 `packages/web/src/i18n/resources.ts`，中英文保持短、直接、以操作和状态为中心。
- `Agent`、`Workspace`、`Docker`、`VM`、`NAS` 等术语保持稳定。
- 错误文案说明发生了什么和下一步动作，不泄露凭据、内部堆栈或不必要路径。
- 界面不显示设计说明、键盘教学或风格描述。必要帮助放入现有 tooltip、label 或文档。

## 9. 无障碍基线

- Tab 顺序与视觉顺序一致；Enter、Space、方向键和 Escape 行为保持现有语义。
- 装饰图标设置 `aria-hidden="true"`，图标按钮有可读标签。
- 对话框打开后焦点进入，关闭后回到触发器。菜单和弹层同样恢复焦点。
- 状态变化使用合适的 `role="status"`、`role="alert"` 或 `aria-live`，避免后台刷新反复打断读屏。
- 黄/黑正文和控件达到 WCAG AA。红色与青色状态同时提供图标、文字、结构轨或 ARIA 状态。
- 焦点环不得被 `overflow`、`clip-path`、mask 或父容器裁切。

## 10. UI 变更准入

任何 Web、TV 或文档 UI 变更在交付前检查：

1. 是否复用深色 HUD 令牌、Rajdhani / Noto Sans SC / JetBrains Mono 字体角色和零圆角几何？
2. 是否覆盖 default、hover、active、selected、focus、disabled、busy、error？
3. 是否在中文、英文和 `prefers-reduced-motion` 下检查文本、动效和状态表达？
4. 是否在 `1440/820/560/390/320px` 检查重叠、页面级横向溢出、触控区域和长文本？
5. 是否保持 Enter、Space、方向键、Escape、焦点恢复和屏幕阅读器标签？
6. 是否误改 API、审批、安全路径、通知生命周期、Photo 顺序或分页语义？
7. 是否避免引入第三方专有素材、持续闪烁和局部视觉分支？
8. 设置及其弹窗中的下拉框是否全部使用 `CustomSelect`，并通过禁止原生 `<select>` 的 ESLint 检查？
9. 独立内容区块是否默认一块占据一整行，避免无必要的二等分或多等分布局？
10. 从左右工作区及嵌套弹窗打开时，遮罩是否覆盖全界面、弹窗是否始终按整个视口居中，并保持层级与焦点行为？
11. 按钮是否全部保持直角，尤其是弹窗内的关闭、取消、保存和危险操作；各交互状态与 Portal 挂载后四角计算值是否仍为 `0px`？

至少运行相关 Vitest、`npm run typecheck`、`npm run lint` 和 Web 构建，并完成一次真实浏览器检查。发布前执行 `make ci`。视觉问题优先修复根级令牌或共享组件，不用页面级临时补丁掩盖。
