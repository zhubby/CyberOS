# web — Web、移动端与 TV 的 React 界面

`@cyberos/web` 是 CyberOS 的浏览器工作空间，使用 React 19、TypeScript 和 Vite。它提供 Agent 会话、NAS 文件与管理面板、媒体库、播放控制、系统设置和通知，并复用公共状态支持桌面和移动端；TV 使用独立入口。

浏览器通过 API 的 HTTP、SSE 和 WebSocket 访问系统。数据库、文件写入和主机特权由后端执行，前端的确认与校验需与服务端保护配合。

[返回工作空间总览](../README.md) · [包定义](package.json) · [前端设计规范](../../docs/src/content/docs/reference/frontend-design.md)

## 架构图

![Web、业务面板、共享播放状态与 TV 入口架构](docs/architecture.svg)

App 负责公共会话和页面协调；业务面板按职责维护局部状态。Playback/Music provider 位于应用上层，使面板切换与播放器生命周期分离。

## 启动与入口

| 入口 | 行为 |
| --- | --- |
| [src/main.tsx](src/main.tsx) | 初始化 i18n，挂载 StrictMode/App/TooltipLayer，处理 boot screen 与失败 |
| [src/App.tsx](src/App.tsx) | MobileNavigationProvider → PlaybackProvider → MusicProvider → AppContent；会话、设置、上传和全局协调 |
| [src/tv/main.tsx](src/tv/main.tsx) | 独立 TV 页面、输入法、i18n、TvApp、TooltipLayer 与 TV 样式 |
| [vite.config.ts](vite.config.ts) | 主页面与 `tv/index.html` 双入口；开发代理 `/api`/`/health` |

App 并非统一全局 store：一些业务数据由 App 通过 props/callback 传入，专题面板和设置页也有自己的 API 请求、草稿与局部状态。

## 源码与内部模块导航

| 模块 | 职责与关键边界 |
| --- | --- |
| [components/chat](src/components/chat) | 消息/工具活动展示、composer、IME/Enter、滚动锚定；SSE 由 App 管理 |
| [components/workspace](src/components/workspace) | 文件选择/上传/预览与 Docker、VM、共享、存储、终端、照片、下载、监控面板 |
| [components/settings](src/components/settings) | 分类、搜索、表单、领域设置与秘密输入；页面保存方式按领域实现 |
| [components/playback](src/components/playback) | 浏览器/NAS 播放状态、全局菜单/底栏、音量与 BrowserPlayer |
| [components/music](src/components/music) | 音乐目录、队列、歌单、歌词、筛选和 NAS 播放接管 |
| [components/video](src/components/video) | 首页/电影/剧集/合集、详情、待看和播放目标选择 |
| [components/preview](src/components/preview) | 文本/Markdown/图片/音视频/PDF/Office 分派和专门 VOD 控件 |
| [components/editor](src/components/editor) | 文本编辑、700ms 防抖保存、显式保存和修改时间冲突 |
| [components/file](src/components/file) | 文件视觉分类和图标，不能替代 MIME/授权判断 |
| [components/activity](src/components/activity) | 上传、批量文件和操作活动，取消/回滚交由回调执行 |
| [components/notifications](src/components/notifications) | 操作、蓝牙、告警分栏，已读与告警确认分开 |
| [components/power](src/components/power) | 关机/重启的明确确认、busy 与焦点控制 |
| [components/common](src/components/common) | Portal、CustomSelect、Switch、筛选、tooltip 和共享视觉组件 |
| [mobile](src/mobile) | hash 路由、返回优先栈、scope、内存视图状态和滚动恢复 |
| [tv](src/tv) | 大屏目录、遥控/手柄导航、方向焦点、拼音输入和播放控制适配 |
| [lib](src/lib) | API adapter、事件/状态归并、偏好存储、上传/选择/布局 helper 与 hooks |
| [config](src/config) | 设置分组、共享/存储/iSCSI 表单转换与验证，不执行主机动作 |
| [i18n](src/i18n) | 中英文资源、初始化、语言偏好和格式化 |
| [styles](src/styles)、[styles.css](src/styles.css) | 共享 tokens 映射、业务层样式、响应式和交互层 |
| [src/api.ts](src/api.ts) | 通用 HTTP 类型与调用；部分领域另有专用 adapter |

## Agent 会话：快照与增量分开

App 加载 session 列表，再取得当前 transcript 和审批。transcript 返回历史、运行状态与游标；恢复后从该游标建立 EventSource，事件归并由 [transcript](src/lib/transcript.ts)、[events](src/lib/events.ts) 和 [agent-job-state](src/lib/agent-job-state.ts) 等 helper 协作。

异步结果受当前 session、请求 ID 和卸载状态约束；事件通过 runId、sequence 和 job ID 识别归属，避免旧回调污染切换后的会话。ChatPane 接收展示状态和操作回调，不自行创建另一条 SSE。

composer 区分普通 prompt、steer 和 follow_up，使用临时消息提供提交反馈，服务器确认后替换。输入法 composing 时 Enter 不提交；滚动逻辑在贴底跟随和用户阅读历史之间保持锚定。

## Workspace 与文件操作

WorkspacePane 分派文件与专题面板，部分重面板 lazy 加载。普通文件数据和 mutation callbacks 来自 App；下载、媒体、监控等面板有自己的请求与订阅路径。桌面终端可在首次访问后保持挂载，compact 布局的挂载策略不同，不能假定所有隐藏面板都常驻。

终端用 xterm/FitAddon 接收输出并发送输入与 resize，经 API WebSocket 接到 terminald。监控只在页面可见时订阅，按事件、重连或序列缺口刷新有界数据；下载则有独立任务 SSE。

文件编辑保存带 `expectedModifiedAt`，冲突时阻止自动覆盖；关闭前有未保存修改会尝试保存，失败保留弹窗。Office 预览按需加载渲染器、支持取消并清理资源，链接受协议限制；Markdown 不应作为执行原始 HTML 的通道。

## 播放与媒体所有权

PlaybackProvider 分别持有 NAS 状态和浏览器 session。NAS 状态由 API/SSE 与兜底刷新同步，控制带 serviceInstanceId、expectedSessionId 等归属条件；音乐队列还带 expectedQueueVersion，并在冲突时刷新/请求接管。

“此设备”创建 media-streamer session，由 BrowserPlayer 使用 direct、Hls.js 或原生 HLS。转码 seek 可通过创建替代流完成，进度由 API 保存；关闭菜单或切换库页面不应销毁仍在播放的底层播放器。

NAS 音乐与原生视频共享播放所有权，浏览器视频另有执行路径。TV 页面复用目录和 provider，通过 API 控制 NAS；原生 mpv 全屏控件由 Linux 播放链路实现，不是浏览器 DOM 覆盖在 mpv 上。

## 移动端、弹层与设计约束

移动端使用 `#/home` 与 `#/app/<id>`，返回先消费按优先级排列的 handler，再退路由/首页。handler 绑定当前 route scope；ViewStateStore 仅在挂载期内存保存，页面刷新后不会自动持久恢复。

ModalPortal 按深度/层级组织 Portal，并注册移动返回。焦点圈定、Escape 和关闭阻塞由具体 dialog 或 hook 协作，不是 Portal 自动为所有弹层完成。通知和电源弹窗有各自焦点/确认逻辑；busy 期间保护需要完成的操作。

当前界面采用统一深色、密集工业 HUD。根 tokens 来自 shared，base.css 映射语义变量，styles.css 依次导入业务、responsive、interaction 等层；TV 样式有独立入口。公共 token、断点或交互语义变化须同步设计规范。

## 开发与验证

在仓库根目录运行，配合独立开发数据根的 API：

```bash
npm run dev -w @cyberos/web
npx vitest run packages/web
npm run build -w @cyberos/web
```

Vite 默认 `127.0.0.1:5173`，代理 API 到 `127.0.0.1:3010`，支持 WebSocket。生产静态产物由 API 提供，不运行 Vite 开发服务器。

UI 改动除类型/测试/构建外，应在浏览器核对中英文、桌面/窄屏、键盘焦点/Escape、加载/错误、滚动和 reduced motion。模拟 API/播放器测试不证明真实主机动作、物理音视频输出或客户端终端交互。
