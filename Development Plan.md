# DeepSeek Harness - Antigravity 能力包 (dsh-tool-antigravity) 开发计划与架构方案

## 1. 项目定位与目标

本项目（`dsh-tool-antigravity`）是基于官方已审计验证的架构全面重构与裁剪的全新 DeepSeek Harness (DSH) 能力包插件仓库。

### 核心定位
* **独立受控**：独立代码仓库维护，保证与上游最新 DSH 运行时生态兼容的同时，支持自主维护与演进。
* **专注核心能力**：**严格收敛为两大核心支柱** —— **LLM 路由与模型服务**（Google Antigravity / Gemini / Claude / GPT 系列）以及 **图片生成与编辑**（`generate_image` / `list_images`）。已彻底剔除并剥离“网页搜索”和“视频理解”模块。
* **高可靠与极致性能**：保留底层已审计的私有 HTTP/1.1 协议栈与 AGY CLI 1.1.24 格式对齐，单次构建毫秒级输出（Host 42ms / Client 31ms）。
* **Windows 深度适配**：解决 Windows 平台下 `cmd.exe` 截断 `&` 查询参数（导致 OAuth 报 `Required parameter is missing: response_type`）问题，支持 `windowsVerbatimArguments` 保真唤起默认浏览器。
* **严格安全闭环**：继承单账号 OAuth 2.0 PKCE 认证闭环、Token 绝不跨 Host 泄露、严格 Loopback (`127.0.0.1`) 访问守卫与 TOCTOU 本地文件竞争防护。

---

## 2. 功能范围界定（保留与裁剪）

### 2.1 保留的核心功能
1. **统一认证与凭据协调器（Auth & Credential Coordinator）**
   * 直连 Google OAuth 2.0 PKCE 流程（临时回环监听 `127.0.0.1:51121`）。
   * 跨平台浏览器安全唤起（`open-authorization-url.ts`，Windows 专有命令参数保真防截断）。
   * 本地凭证安全存储（Windows ACL / POSIX 0600）、自动异步续期与并发刷新合并。
   * `/antigravity-auth` 交互式终端命令与本地 Web 路由守卫。
2. **LLM 路由与模型发现（LLM Adapter & Provider）**
   * 注册 `google-antigravity` 提供方，完美接入 `@deepseek-ai/dsh-llm` 体系。
   * 全系模型覆盖：Gemini 3.8 Flash、Gemini 3.7 Flash、Gemini 3.6 Flash、Gemini 3.1 Pro、Claude Sonnet 4.6 Thinking、Claude Opus 4.6 Thinking、GPT-OSS 120B Medium。
   * 真实账号模型目录（Live Catalog）与固定审计快照安全交集。
   * 稳定 SSE 流式传输、Tool Call 签名绑定、Claude 提示词与参数类型规整加固。
3. **图片创作与编辑工具（Image Generation & Editing）**
   * 独立插件行 `dsh-tool-antigravity/image`，按需提供 `generate_image`（文生图/图生图参考）与 `list_images`（会话持久图片检索）。
   * 接入 DSH 原生 `AttachmentStore` 与 `FileSystem`，严格执行 Magic Bytes 格式嗅探与 TOCTOU 工作区安全准入。
4. **配额看板与前端设置（Dashboard & Client Settings）**
   * 浏览器端 Client 扩展，注入 DSH Web 设置中心（`settings.section`）。
   * 提供 5 小时与每周配额占比、倒计时可视化展示。
   * 精简卡片布局：仅保留“账号登录状态/配额仪表盘”与“图片创作”卡片。

### 2.2 彻底移除的功能与依赖
1. **彻底移除网页搜索（Search）**：
   * 移除 `antigravity-search` 插件行与 `search.ts`。
   * 移除依赖 `@deepseek-ai/dsh-web`、`live-gate-search.ts` 及搜索门禁。
2. **彻底移除视频理解（Video）**：
   * 移除 `antigravity-video` 插件行与 `video.ts`。
   * 移除 `live-gate-video.ts`、MP4 深度解析逻辑及视频门禁。
   * 消除大体积媒体带来的瞬时堆内存膨胀风险。

---

## 3. 核心设计与专项技术对齐

### 3.1 浏览器唤起与 Windows 命令行转义方案
* **问题痛点**：Windows 下 `cmd.exe /c start "" <url>` 执行时，URL 中的 `&` 会被解析为 cmd 命令连接符，导致 `&response_type=code` 及后续参数丢失，Google 报 `400: invalid_request (Required parameter is missing: response_type)`。
* **落地设计**：在 `src/open-authorization-url.ts` 中采用 `windowsVerbatimArguments: true` 与双层双引号结构 `['/c', 'start', '""', `"${url}"`]`，确保复杂 OAuth URL 原样送达 Windows 系统默认浏览器。

### 3.2 动态 RPC 注入与 Host 路由装配
* **问题痛点**：若在 Cordis `apply()` 中同步获取尚未初始化的 `connection` 服务，会导致 `/api/antigravity-auth/*` 路由未被注册，前端出现 `invalid usage response from Host`。
* **落地设计**：在 `src/index.ts` 中采用 `ctx.inject(['connection'], (connectionCtx) => ...)` 延迟监听，并在挂载时执行 `registerAccountRoutes` 精确 Fetch 注册。

### 3.3 状态与能力门禁裁剪对齐
* 在 `src/status.ts` 中将 `CAPABILITY_ROW_IDS` 严格对齐为 `['auth-llm', 'image']`。
* 状态解析器与 live gate 运行器均去除了对 search 和 video 的硬编码校验，保证门禁检查与能力投影 100% 吻合实际能力集合。

---

## 4. 实际项目目录结构

```text
E:\Github\dsh-tool-antigravity\
├── Development Plan.md           # 本开发计划与架构文档
├── package.json                  # 项目清单与依赖配置（包名：dsh-tool-antigravity）
├── pnpm-lock.yaml                # 确定性依赖锁定文件
├── tsconfig.json                 # 基础 TypeScript 配置
├── tsconfig.host.json            # Host 宿主端编译配置
├── tsconfig.client.json          # Client 浏览器端编译配置
├── tsconfig.build.host.json      # Host 类型声明提取配置（生成 lib/types）
├── tsconfig.build.client.json    # Client 类型声明提取配置
├── tsdown.config.ts              # 高性能 Rolldown 构建配置
├── vitest.config.ts              # 单元测试配置
├── cordis.patch.yml              # 精简版 Host 行注入配置（auth + image）
├── README.md                     # 项目英文说明
├── README.zh.md                  # 项目中文说明
├── LICENSE                       # MIT 许可证
├── build\
│   └── client-bundle.ts          # 浏览器端模块加载器封装（window.__ModuleLoader__）
├── scripts\
│   └── clean.mjs                 # 构建产物清理脚本
├── src\
│   ├── index.ts                  # 插件主入口：Cordis 注入、LLM 适配器与账户 RPC 挂载
│   ├── image.ts                  # 图片创作插件：generate_image / list_images 工具与准入
│   ├── auth-service.ts           # 认证服务：状态机、凭证协调与门禁触发
│   ├── auth-store.ts             # 凭证持久化：跨平台文件锁与权限加固
│   ├── auth-command.ts           # 终端斜杠命令交互
│   ├── bootstrap-service.ts      # 引导阶段状态服务接口
│   ├── capability-gates.ts       # 门禁凭证记录与持久化
│   ├── capability-lifecycle.ts   # 动态能力生命周期挂载与卸载
│   ├── credential-coordinator.ts # 凭证刷新合并、原子提交与状态视图
│   ├── invariant.ts              # 核心不变量断言
│   ├── live-gates.ts             # Live Gate 命令行接口
│   ├── live-gate-runner.ts       # Live Gate 运行执行器
│   ├── live-gate-auth.ts         # Auth 门禁实现
│   ├── live-gate-llm.ts          # LLM 门禁实现
│   ├── live-gate-image.ts        # Image 门禁实现
│   ├── live-gate-outcome.ts      # 门禁结果分类与记录
│   ├── live-gate-attachments.ts  # 门禁临时附件管理
│   ├── llm-adapter.ts            # LLM 核心适配器（模型目录、流式推理、重试与异常封装）
│   ├── login-types.ts            # 登录阶段与操作类型定义
│   ├── loopback-rpc.ts           # 回环地址判定与安全守卫
│   ├── media-admission.ts        # 多模态媒体准入与 Magic Bytes 探测
│   ├── model-catalog.ts          # 模型目录快照与实时探测
│   ├── oauth-flow.ts             # PKCE OAuth 流程与 127.0.0.1:51121 回环服务
│   ├── open-authorization-url.ts # 跨平台默认浏览器安全拉起（防 Windows 参数截断）
│   ├── private-failure.ts        # 私有接口异常分类
│   ├── private-transport-error.ts# 传输层异常定义
│   ├── private-transport.ts      # HTTP/1.1 私有传输客户端与 SSE 流解析
│   ├── project-context.ts        # Project ID 上下文解析与规范化
│   ├── quota.ts                  # 配额数据结构与时间窗口处理
│   ├── raw-http.ts               # 底层原始 HTTP 封装
│   ├── replay.ts                 # 请求/响应重放与 Claude 参数规格化
│   ├── rpc.ts                    # 账户 RPC 业务分发与端点处理
│   ├── rpc-contract.ts           # 浏览器与宿主端 RPC 通信契约
│   ├── rpc-vocabulary.ts         # RPC 异常码词表
│   ├── safe-text.ts              # 边界安全文本校验
│   ├── status.ts                 # 统一状态模型与能力定义
│   ├── wire-identity.ts          # AGY CLI 1.1.24 协议与 DSH 归因特征
│   └── client\                   # 浏览器端设置界面（React）
│       ├── index.ts              # 客户端扩展入口（注册 settings.section）
│       ├── AntigravityAuthSettings.tsx # 统一设置卡片（登录/配额 + 图片设置）
│       ├── locales.ts            # 中英文双语支持
│       └── styles.ts             # 样式注入
└── tests\                        # 自动化测试套件（28 个测试套件，268 项测试）
    ├── account-routes.spec.ts
    ├── agent-loop-system.spec.ts
    ├── auth-command.spec.ts
    ├── auth-service.spec.ts
    ├── auth-store.spec.ts
    ├── capability-gates.spec.ts
    ├── client-apply.client.spec.ts
    ├── client-settings.client.spec.tsx
    ├── credential-coordinator.spec.ts
    ├── image.spec.ts
    ├── invariant.spec.ts
    ├── lifecycle.spec.ts
    ├── live-gate-attachments.spec.ts
    ├── live-gates.spec.ts
    ├── llm-adapter.spec.ts
    ├── loopback-rpc.spec.ts
    ├── media-admission.spec.ts
    ├── oauth-flow.spec.ts
    ├── open-authorization-url.spec.ts
    ├── private-transport.spec.ts
    ├── project-context.spec.ts
    ├── quota.spec.ts
    ├── raw-transport.spec.ts
    ├── rpc.spec.ts
    ├── settings-registration.spec.ts
    ├── terminal-composition.integration.spec.ts
    ├── wire-identity-public.spec.ts
    └── wire-identity.spec.ts
```

---

## 5. 构建交付与质量指标

1. **构建流程**：
   ```bash
   pnpm run build
   ```
   * 自动清理历史目录并执行双目标 TypeScript 声明生成。
   * Host 端 ESM 构建耗时约 40ms，Client 端 CJS Bundle 耗时约 30ms。
2. **测试与类型保障**：
   * **类型健全性**：`pnpm run typecheck` (`tsc --noEmit`) 0 报错。
   * **单元测试覆盖**：`pnpm test` (Vitest) **28 个测试文件、268 项测试 100% 全部通过**。
3. **部署环境同步**：
   * 支持通过 `dsh plugin --profile web install --force` 直接挂载至本地 DeepSeek Harness Web Profile 环境。

---

## 6. 安全底线与不可变约束 (Invariants)

1. **凭证隔离性**：`accessToken` 和 `refreshToken` 绝不可暴露给前端 UI、日志或命令输出。
2. **Loopback 绝对安全**：账号 RPC 接口仅在明确绑定 `127.0.0.1` 时生效，公网/未知 bind 必须 Fail-Closed。
3. **Wire Identity 真实性**：保持已审计的 AGY CLI User-Agent 和真实的 `X-DeepSeek-Harness-Attribution` 二级载荷，严禁伪造或移除。
4. **媒体准入安全**：所有工作区文件引用必须强制进行 Root Containment、符号链接禁用以及 TOCTOU 竞争检测。
