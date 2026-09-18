# DeepSeek Harness - Antigravity 能力包 (dsh-tool-antigravity) 开发计划

## 1. 项目定位与目标

本项目（`dsh-tool-antigravity`）是基于开源项目 `dsh-antigravity-auth` 独立构建的全新 DeepSeek Harness (DSH) 能力包插件仓库。

### 核心定位
* **独立受控**：独立代码仓库维护，不受上游分支变动束缚。
* **专注核心能力**：**只保留两大核心功能** —— **LLM 路由与模型服务**（Google Antigravity / Gemini / Claude / GPT 系列）以及 **图片生成与编辑**（`generate_image` / `list_images`）。彻底剥离与精简“网页搜索”和“视频理解”模块。
* **全面性能与体验调优**：针对原插件在网络连接开销、SSE 解析性能、思考预算粒度、Windows 平台锁机制以及前端降级体验等维度的不足，进行系统性重构与性能升级。
* **安全底线不妥协**：严格继承原项目的核心安全资产，包括单账号 OAuth 2.0 PKCE 认证安全闭环、Token 绝不跨 Host 泄露、严格 Loopback 访问守卫、以及对 AGY CLI 1.1.24 Wire Identity 的 100% 格式对齐。

---

## 2. 功能范围界定（保留与裁剪）

### 2.1 保留与升级的功能
1. **统一认证与凭据协调器（Auth & Credential Coordinator）**
   * 直连 Google OAuth 2.0 PKCE 流程（临时回环监听 `127.0.0.1:51121`）。
   * 本地凭证安全存储（Windows ACL / POSIX 0600）、自动刷新、并发请求合并。
   * `/antigravity-auth` 交互式命令与本地 Web 路由守卫。
2. **LLM 路由与模型发现（LLM Adapter & Provider）**
   * 注册 `google-antigravity` 提供方。
   * 模型覆盖：Gemini 3.8 Flash、Gemini 3.7 Flash、Gemini 3.6 Flash、Gemini 3.1 Pro、Claude Sonnet 4.6 Thinking、Claude Opus 4.6 Thinking、GPT-OSS 120B Medium。
   * 真实账号模型目录（Live Catalog）与固定快照安全交集。
   * 稳定流式传输、Tool Call 签名绑定、Claude 提示词与参数类型加固。
3. **图片创作与编辑工具（Image Generation & Editing）**
   * 提供 `generate_image`（支持文生图、图生图/多图参考编辑）。
   * 提供 `list_images`（会话持久图片分页检索）。
   * 接入 DSH 原生 `AttachmentStore`，实现图片的字节校验、解码与持久化。
4. **配额看板与前端设置（Dashboard & Client Settings）**
   * 5 小时与每周额度占比与倒计时可视化（Shimmer 动效、倒计时格式化）。
   * 仅保留“账号登录/配额”卡片与“图片创作”设置卡片。

### 2.2 彻底移除的功能与依赖
1. **移除网页搜索（Search）**：
   * 移除 `antigravity-search` 插件行、`buildGroundedSearchPayload` 模块。
   * 移除依赖 `@deepseek-ai/dsh-web` 及相关配置项。
2. **移除视频理解（Video）**：
   * 移除 `antigravity-video` 插件行、`analyze_video` 工具及 MP4 解析模块。
   * 消除大体积视频带来的瞬时堆内存压力。

---

## 3. 核心不足与深度优化设计

### 优化一：TLS Socket 长连接池化与 Session Resumption（降低首字延迟 TTFT）
* **现状痛点**：
  原插件为了精确控制 HTTP 请求头的大小写与顺序（规避反爬），自研了 HTTP/1.1 Dispatcher，但对每个请求都执行一次全新的 TLS 建立与握手，流结束后直接 `socket.destroy()`，在海外网络下产生 150~350ms 的固有握手延迟。
* **重构方案**：
  1. **HTTP/1.1 Socket Keep-Alive 连接池**：基于目标 Origin（如 `daily-cloudcode-pa.googleapis.com`）构建轻量 Socket 池。流式读取完响应尾（`[DONE]` 或连接流断开）后，在满足空闲条件时将套接字归还给池，设置 30~45s 空闲超时与自动心跳。
  2. **TLS Session Ticket 票据复用**：监听 TLS 的 `session` 事件并缓存会话票据，在建立新连接时传入 `session` 参数，将握手往返降为 1-RTT / 0-RTT。
  3. **严格保持 Wire Identity**：保留手动拼装 HTTP/1.1 报文与 AGY CLI 1.1.24 格式特性的优势，兼得极致低延迟与协议仿真。

### 优化二：单包/滑动窗口 SSE 流解析器（降低 GC 与内存开销）
* **现状痛点**：
  `iteratePrivateSse` 频繁执行大字符串累加 `buffer += decoded` 与 `buffer.slice(...)`，长文本回答时引发严重的 V8 堆内存重新分配与垃圾回收抖动。
* **重构方案**：
  1. **基于 Buffer / Uint8Array 的游标滑动解析**：在二进制 Buffer 层直接定位 `\n`（ASCII 10）与 `\r\n\r\n`，仅在提取单行事件内容时解码目标切片。
  2. **单帧轻量对象重用**：避免高频创建冗余中间对象，减少高并发或长输出时的 GC 压力。

### 优化三：推理配置（Thinking Budget）细粒度调控与幂等安全重试
* **现状痛点**：
  1. Gemini 3.8 Flash 仅提供固定的 Low/Medium/High 三档，默认 Medium 思考预算死板地固定为 4000。
  2. Claude 4.6 与 GPT-OSS 无法从外部微调思考预算。
  3. `maxRetries: 0` 导致网络瞬时抖动（如 TLS RST、503 闪断）直接失败。
* **重构方案**：
  1. **开放更多思考预算档位**：为 Gemini 与 Claude 开放精细档位（如 Low 1024、Medium 4000、High 8000/16000、Max 32768），并允许在插件配置中自定义默认 Budget。
  2. **幂等前置重试（Idempotent Pre-flight Retry）**：若在向 Google 端点发出首字节且尚未收到响应前遇到网络层连接重置（`ECONNRESET`）或 502/503，自动平滑重试 1 次。

### 优化四：Windows 平台文件锁与权限优化
* **现状痛点**：
  1. 本地文件锁 `withStoreLock` 设置了 30 秒超时（`AUTH_STORE_LOCK_STALE_MS`）。若开发过程中进程被强杀，30 秒内无法启动任何 auth 操作，极易触发 `AUTH_STORE_CONFLICT`。
  2. 在 Windows 环境下无意义地执行了 POSIX `chmod(..., 448)`。
* **重构方案**：
  1. **PID 活跃性主动探测**：读取锁文件中记录的 `process.pid`，在 Windows 平台上使用 `process.kill(pid, 0)` 探测进程是否已经退出；若进程已消亡，立即主动回收锁文件，无需死等 30 秒。
  2. **跨平台系统调用裁剪**：在 `process.platform === "win32"` 时跳过 POSIX `chmod` 与目录同步调用。

### 优化五：多模态图片内存与格式扩展
* **现状痛点**：
  图片数据整体 Base64 编码常驻内存，且原插件仅支持 PNG、JPEG、WEBP、GIF。
* **重构方案**：
  1. **流式/分块 Base64 转换**：在向模型推送大图片时，避免在中间层保留冗余字符串副本。
  2. **增加现代格式识别**：扩展 Magic Bytes 探测，增加对 AVIF 格式的检测与友好提示。

### 优化六：配额看板精细化与 Stale-While-Revalidate（SWR）容错
* **现状痛点**：
  1. 配额时间窗口识别粒度粗糙（`identifyWindow` 将 `<= 691200s` 均划入 `weekly`，存在误判隐患）。
  2. 配额接口因网络抖动超时失败时，前端卡片直接变为 `offline` 并清空进度条，体验断崖式下跌。
* **重构方案**：
  1. **精确的时间窗口区间划分**：区分 5h、24h/daily、7d/weekly，增强对上游配额协议变动的兼容性。
  2. **SWR 缓存展示机制**：在配额拉取失败或超时时，前端保持展示“上次成功的有效快照”，并打上“数据已过期/重试中”标记，同时提供快速手动刷新入口。

### 优化七：精简架构与代码分块
* **现状痛点**：
  各子模块重复打包工具函数与常量，且前端保留了未启用的视频和搜索卡片逻辑。
* **重构方案**：
  1. 前端 UI 仅保留核心设置卡片（认证状态/配额仪表盘、图片设置）。
  2. 简化 Cordis Patch 拓扑：仅声明 `antigravity-auth` 和 `antigravity-image` 两个 Host 行。

---

## 4. 目录结构设计（瘦身后）

```text
E:\Github\dsh-tool-antigravity\
├── Development Plan.md           # 本开发计划文档
├── package.json                  # 精简后的项目清单与依赖
├── tsconfig.json                 # TypeScript 编译配置
├── vite.config.ts / tsup.config.ts # 现代化构建配置
├── cordis.patch.yml              # 精简后的 Host 行注入配置
├── README.md                     # 项目英文说明
├── README.zh.md                  # 项目中文说明
├── LICENSE                       # MIT 许可证
├── src\
│   ├── index.ts                  # 插件主入口：Cordis 注入、LLM 适配器、RPC 注册、Auth 命令
│   ├── client\                   # 浏览器端设置界面（React）
│   │   ├── index.tsx             # 客户端扩展入口
│   │   ├── AntigravitySettings.tsx # 整合后的设置卡片（认证看板 + 图片配置）
│   │   ├── QuotaDashboard.tsx    # 配额与倒计时动效可视化组件
│   │   ├── locales.ts            # 中英文双语支持
│   │   └── styles.css            # 仪表盘微光与动画样式
│   ├── llm\                      # LLM 核心模块
│   │   ├── adapter.ts            # AntigravityAdapter 实现（流式输出、模型列表）
│   │   ├── sse-parser.ts         # 优化后的高效 Buffer 游标滑动 SSE 解析器
│   │   ├── model-catalog.ts      # 模型目录、Live Discovery 与快照
│   │   ├── thinking-budget.ts    # 思考预算档位与参数转换
│   │   └── transforms.ts         # Gemini / Claude 参数加固与格式规整
│   ├── image\                    # 图片创作模块
│   │   ├── index.ts              # 图片 Host 插件入口
│   │   ├── generate-tool.ts      # generate_image 工具实现
│   │   └── list-tool.ts          # list_images 工具实现
│   ├── transport\                # 网络通信与线路身份
│   │   ├── wire-identity.ts      # AGY CLI 1.1.24 User-Agent & DSH 归因
│   │   ├── socket-pool.ts        # TLS Socket 长连接保持池与 Session 复用
│   │   ├── private-transport.ts  # 构造报文与 Dispatcher
│   │   └── errors.ts             # 传输异常分类与重试策略
│   ├── auth\                     # 认证与生命周期
│   │   ├── oauth-flow.ts         # PKCE S256 OAuth 流程与 51121 回环服务
│   │   ├── credential-store.ts   # 凭证持久化（含 Windows 活跃 PID 锁清理）
│   │   ├── credential-coordinator.ts # 凭证刷新合并与原子提交
│   │   └── project-discovery.ts  # loadCodeAssist 项目探测
│   ├── quota\                    # 配额处理
│   │   ├── quota-service.ts      # 配额拉取、缓存与防抖
│   │   └── quota-normalizer.ts   # 精准窗口识别与归一化
│   ├── media\                    # 媒体准入与校验
│   │   └── image-admission.ts    # 图片 Magic Bytes 探测、大小与工作区准入
│   └── utils\                    # 公共辅助方法
│       ├── loopback-guard.ts     # Loopback 严格安全检查
│       ├── safe-text.ts          # 安全文本与输入校验
│       └── process-opener.ts     # 平台默认浏览器启动器
```

---

## 5. 开发阶段与实施里程碑

```
[阶段 1: 基础设施] ──> [阶段 2: 传输与认证] ──> [阶段 3: LLM 核心] ──> [阶段 4: 图片工具] ──> [阶段 5: 前端与配额] ──> [阶段 6: 联调验证]
```

### 阶段 1：项目初始化与依赖精简 (Phase 1) [已完成]
* **任务清单**：
  - [x] 初始化 `package.json`，包名设定为 `dsh-tool-antigravity`，定义准确的 exports 和 files。
  - [x] 剥离无用的 peerDependencies（已彻底移除 `@deepseek-ai/dsh-web`）。
  - [x] 配置 TypeScript（`tsconfig.json`）与构建脚本（`tsdown.config.ts`，支持 CJS client 与 ESM lib）。
  - [x] 编写精简版的 `cordis.patch.yml`，仅注册 `antigravity-auth` 与 `antigravity-image`。
  - [x] 完成 pnpm 依赖安装与构建脚本许可配置，通过 AST (`xd://ast_grep`) 与 LSP (`xd://lsp`) 校验。
### 阶段 2：底层传输层重构与认证加固 (Phase 2) [已完成]
* **任务清单**：
  - [x] 实现 `wire-identity.ts`，确保 AGY CLI 1.1.24 格式与 DSH 归因头 100% 精确与不可篡改。
  - [x] 实现 `socket-pool.ts`，加入基于 Origin 的 TLS Keep-Alive 连接池与 TLS Session Ticket 缓存（降低 150~350ms 握手延迟）。
  - [x] 实现 `private-transport.ts`，接入长连接池、会话票据、滑动 Buffer SSE 解析以及前置幂等重试机制。
  - [x] 重构 `credential-store.ts`，加入基于 Windows `process.kill(pid, 0)` 的 Stale Lock 活跃性回收机制，消除 30 秒死锁隐患；优化 Windows 下的权限调用。
  - [x] 实现 `oauth-flow.ts`，支持 Google PKCE OAuth 2.0 与 `127.0.0.1:51121` 回环回调服务。
  - [x] 实现 `project-context.ts` 与 `credential-coordinator.ts`（支持并发刷新合并与原子提交）。
  - [x] 编写单元测试 `tests/transport-and-auth.test.ts` 并全部通过，验证了瞬时锁回收、Wire Identity 序列化与 Ticket 缓存。
### 阶段 3：LLM 适配器与高性能流式解析 (Phase 3) [已完成]
* **任务清单**：
  - [x] 编写高性能 `sse-parser.ts`，采用 Buffer 游标滑动窗口切片，支持自动剥除 Google `)]}'` 安全防线前缀，避免内存膨胀。
  - [x] 实现 `replay.ts`，支持模型家族分类、函数声明构建、Claude 工具描述增强（`STRICT PARAMETERS` 与系统指令）以及相邻工具响应合并。
  - [x] 实现 `model-catalog.ts`，支持模型别名弹性查找、Thinking Budget 平滑映射以及 5 分钟目录缓存。
  - [x] 实现 `llm-adapter.ts` 核心，完全对齐 `@deepseek-ai/dsh-llm` 架构规范（100% 严格类型无 `any`），引入首字节前网络抖动 1 次重试与认证自动刷新机制。
  - [x] 编写单元测试 `tests/llm-adapter.test.ts`（12 个用例全部通过），全套 18 个测试绿灯。

### 阶段 4：图片生成与编辑工具接入 (Phase 4) [已完成]
* **任务清单**：
  - [x] 实现 `media-admission.ts`，保留严格的路径逃逸检查与 TOCTOU 竞争防护（两阶段 Stat 校验与版本对比），支持扩展 AVIF 图片与 MP4 容器 magic bytes 识别。
  - [x] 实现 `image-tool.ts`，完全对齐 DSH 原生 `generate_image` 与 `list_images` 工具规范与并发安全策略，支持会话持久图片 Handle 关联与 Base64 自动准入持久化。
  - [x] 编写单元测试 `tests/image.test.ts`（16 个用例全部通过），全套 34 个测试绿灯，工程 project-wide 类型检查 100% 通过。
### 阶段 5：配额管理与前端 UI 交互优化 (Phase 5) [已完成]
* **任务清单**：
  - [x] 重构配额服务 `src/quota-service.ts`，实现精准的 5 小时与每周时间窗口解析、ISO 8601 时长支持、以及 Gemini / 3P 模型分组归一化。
  - [x] 精简 React 前端代码（`src/client/AntigravityAuthSettings.tsx`）：彻底剔除 Web Search 与 Video 卡片，聚焦“认证/配额仪表盘”与“图片创作”。
  - [x] 前端实现 SWR 缓存容错与渐进降级，在接口波动或网络超时时保持展示有效缓存配额，并触发 `@keyframes agy-shimmer` 微光动效与状态指示。
  - [x] 完善双语支持（`src/client/locales.ts`），提供完整中英文自适应与无缝切换。
  - [x] 编写单元测试 `tests/quota.test.ts`（14 个用例全部通过），全套 48 个单元测试全部绿灯，工程类型检查 0 报错。
### 阶段 6：全链路测试、回归与构建打包 (Phase 6) [已完成]
* **任务清单**：
  - [x] 梳理并对齐所有导出入口：实现 `src/index.ts`、`src/image.ts`、`src/rpc-contract.ts`、`src/auth-service.ts`、`src/invariant.ts`，100% 对齐 Cordis 插件规范（`name`, `inject`, `apply`）。
  - [x] 配置构建流水线（`tsdown.config.ts`），执行 `pnpm build` 构建打包，产出双分发目标产物：
    * Node.js 宿主端 ESM 模块（`lib/*.mjs` 与 `lib/*.d.mts`）
    * 浏览器端 CommonJS 单文件（`lib/client.cjs` 与 `lib/client.d.cts`）
  - [x] 严格对齐 `package.json` 的 `exports`、`main`、`types` 与 `files` 配置字段。
  - [x] 离线与构建产物全链路测试：新增 `tests/build-artifacts.test.ts`，5 个测试套件（51 个测试用例）100% 全部通过，`pnpm typecheck` (`tsc --noEmit`) 0 报错。
---

## 6. 安全底线与不可变约束 (Invariants)

1. **凭证隔离性**：`accessToken` 和 `refreshToken` 绝不可暴露给前端 UI、日志或命令输出。
2. **Loopback 绝对安全**：账号 RPC 接口仅在明确绑定 `127.0.0.1` 时生效，其他公网/未知 bind 必须 Fail-Closed。
3. **Wire Identity 真实性**：必须保持已审计的 AGY CLI User-Agent 和真实的 `X-DeepSeek-Harness-Attribution` 二级载荷，严禁伪造或移除。
4. **媒体准入安全**：所有工作区文件引用必须强制进行 Root Containment、符号链接禁用以及 TOCTOU 竞争检测。
