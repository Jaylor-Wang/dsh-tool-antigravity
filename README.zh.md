# dsh-tool-antigravity

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-tool-antigravity.svg?color=blue)](https://www.npmjs.com/package/dsh-tool-antigravity)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-tool-antigravity.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-antigravity.svg)](https://github.com/Jaylor-Wang/dsh-tool-antigravity/releases)
[![Tests](https://img.shields.io/badge/tests-39%20suites%20%7C%20425%20passed-brightgreen.svg)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 打造的高性能 Antigravity 核心能力包插件。

提供私有 Google OAuth 2.0 PKCE 认证闭环、智能多账号池与额度用尽无感自动轮换、全系多模型路由服务（`google-antigravity`）、会话持久化 Nano Banana 2 图像生成与多轮编辑工具（`generate_image` / `list_images`），以及具备 SWR 容错缓存与实时配额看板的 Web 设置面板。

---

## v0.5.5 版本重要更新

- **同步 `@cortexkit/antigravity-auth-core@3.0.42` 并原生支持 Gemini 4 Carbon**：同步上游核心库至 3.0.42 最新版，原生支持 `antigravity-gemini-4-carbon`（支持 low / medium / high 思考深度，262,144 tokens 输出上限），并吸收 Windows 长路径锁回收与原子文件操作加固。
- **修复 Gemini 4 Argon 配额看板崩溃 Bug**：扩展 RPC 契约校验至最多 4 组配额并放行 `gemini-4` / `gemini-argon` 分组，彻底解决包含 Argon 额度的账号在配额面板解析失败崩溃的问题。
- **多账号模型可用性缓存隔离**：基于账号唯一标识隔离模型探测快照，杜绝异构多账号池（如免费号与 Ultra 号混用）之间的模型权限交叉污染。
- **已下线模型清理**：清理 Google 官方已下线的 `gemini-3.5-flash`，全面推荐使用最新的 `gemini-3.8-flash`。

## 核心特性与架构设计

### 1. 高性能底层架构
- **底层长连接池（TLS Socket Keep-Alive）与会话复用**：内置 HTTP/1.1 长连接池与 TLS 票据复用机制，彻底消除逐请求建立 TLS 握手的固有延迟，显著降低首字响应时间（TTFT）。
- **高吞吐 Buffer 游标滑动 SSE 解析**：在二进制 Buffer 字节层精确定位换行符并切片解码，彻底消除流式推理时高频字符串累加带来的 V8 堆内存重新分配与 GC 抖动。
- **细粒度思考预算调控**：全面支持 Gemini 3.8/3.7/3.6 Flash、Gemini 3.1 Pro 与 Claude 系列模型的思维链深度配置（`low`, `medium`, `high`）。
- **前置幂等断线自愈**：在流式首字节发出前遇到瞬时网络异常（如 TLS RST / 502 / 503 / 504）时自动平滑重试最多 3 次，提升模型生成稳定性。
- **Windows 文件锁活性探测**：引入 `process.kill(pid, 0)` 探测，若持有锁的外部进程已异常退出，立即主动回收锁，杜绝 30 秒卡死等待。
- **配额看板 SWR 容错与微光动效**：重构 5 小时与每周配额解析算法，解决窗口周期判断漂移问题；在接口波动时展示缓存数据与微光动效。

### 2. 支持的模型列表 (`google-antigravity`)
| 模型标识符 | 显示名称 | 核心模态 | 思考预算支持 |
| :--- | :--- | :--- | :--- |
| `antigravity-gemini-4-argon` | Gemini 4 Argon | 文本, 视觉, 工具 | Low / Medium / High |
| `antigravity-gemini-4-carbon` | Gemini 4 Carbon | 文本, 视觉, 工具 | Low / Medium / High |
| `antigravity-gemini-3.8-flash` | Gemini 3.8 Flash | 文本, 视觉, 工具 | Low / Medium / High |
| `antigravity-claude-opus-5-5` | Claude Opus 5.5 | 文本, 视觉, 工具 | Low / Medium / High |
| `antigravity-claude-sonnet-5-5` | Claude Sonnet 5.5 | 文本, 视觉, 工具 | Low / Medium / High |
| `antigravity-gpt-oss-120b-medium` | GPT-OSS 120B Medium | 文本, 视觉, 工具 | 固定档位 |

### 3. Nano Banana 2 图片生成与多轮编辑工具
- **`generate_image`**：依托 Nano Banana 2（`gemini-3.1-flash-image`）原生多模态能力，支持基于自然语言提示词的图像生成，以及基于会话图片的图生图/多轮编辑。
- **`list_images`**：供智能体检索当前会话中生成的图片附件。
- 深度接入 DSH `AttachmentStore` 与 `FileSystem`，结合 TOCTOU 防穿越路径准入，杜绝将大量 Base64 直接回灌进对话上下文。

---

## 安装与快速上手

### 通过 DSH 插件命令安装（推荐）
```sh
# 直接安装到当前激活的 web profile
dsh plugin --profile web add dsh-tool-antigravity
```

### 通过 npm / pnpm 安装
```sh
# 使用 npm
npm install dsh-tool-antigravity

# 使用 pnpm
pnpm add dsh-tool-antigravity
```

### Cordis 插件配置
在你的 `cordis.patch.yml` 或 DSH 配置文件中注入插件行：

```yaml
- id: antigravity-auth
  name: 'dsh-tool-antigravity'

- id: antigravity-image
  name: 'dsh-tool-antigravity/image'
```

---

## 常用指令与界面交互

### 终端斜杠命令 (Slash Commands)
在 DSH 命令行或交互输入框中可直接使用：

- `/antigravity-auth login`：启动 Google OAuth 2.0 PKCE 登录流程并自动唤起默认浏览器。
- `/antigravity-auth status`：查看当前账号登录状态、脱敏邮箱与 Project ID。
- `/antigravity-auth logout`：注销当前登录凭证并吊销 Token。
- `/antigravity-auth cancel`：取消正在进行的登录操作。

### 前端设置与仪表盘
在 DSH Web 前端设置页面中自动注入：
- **Antigravity Auth 设置卡片**：展示登录状态、账号身份及功能开关。
- **配额可视化仪表盘**：动态展示 5 小时与每周重置窗口的剩余配额百分比与倒计时。
- **图片生成设置卡片**：配置默认生图模型与批次大小。

---

## 安全机制与不可变约束

1. **凭证物理隔离**：`accessToken` 与 `refreshToken` 严格保留在宿主安全存储中，绝不泄露给前端 UI、日志或命令历史。
2. **严格 Loopback 守卫**：账号 RPC 接口仅在明确绑定 `127.0.0.1` 时生效，其他公网/未知 bind 默认阻断（Fail-Closed）。
3. **不可篡改线路签名**：严格维持已审计的 AGY CLI User-Agent（`antigravity/cli/1.1.24`）与归属载荷。
4. **多媒体路径逃逸防护**：强制进行目录穿越防范与符号链接安全检测。

---

## 免责声明

本项目为非官方、社区驱动的开源能力包，仅供个人学习、技术研究与独立开发使用。请严格遵守相关平台的服务条款。

---

## 许可证

[MIT](LICENSE) © [dsh-tool-antigravity contributors](LICENSE)
