# dsh-tool-antigravity

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-tool-antigravity.svg)](https://www.npmjs.com/package/dsh-tool-antigravity)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-tool-antigravity.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-antigravity.svg)](https://github.com/Jaylor-Wang/dsh-tool-antigravity/releases)

Streamlined, high-performance Antigravity capability bundle plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Provides private OAuth 2.0 PKCE authentication, multi-model routing (`google-antigravity`), session-persistent image generation/editing, and a real-time quota dashboard with graceful caching.

---

## Features & Optimizations

### 1. High-Performance Core Architecture
- **TLS Connection Pooling & Session Resumption**: Built-in HTTP/1.1 Keep-Alive socket pool and TLS session resumption against Google endpoints, eliminating repeated TLS handshake roundtrips and significantly reducing Time-To-First-Token (TTFT).
- **Sliding-Window Buffer SSE Parser**: High-throughput binary chunking directly locates newline separators on raw Buffers, bypassing heavy string concatenations and drastically reducing V8 heap allocations and GC spikes during long reasoning chains.
- **Granular Thinking Budgets**: Fine-grained reasoning effort configuration (`low`, `medium`, `high`) across Gemini and Claude models with graceful fallbacks.
- **Pre-flight Idempotent Retry**: Automatically retries transient network interruptions (e.g. TLS RST / 502 / 503) once prior to first byte emission.
- **Windows File Lock Recovery**: Active PID probing (`process.kill(pid, 0)`) detects stale locks from crashed processes and immediately frees them, preventing 30-second hang timeouts.
- **Stale-While-Revalidate (SWR) Quota Resilience**: Robust quota normalization supporting 5h and weekly windows; retains and displays last-known valid quota with smooth shimmer animations during transient network disruptions.

### 2. Supported Models (`google-antigravity`)
| Model Identifier | Display Name | Capabilities | Thinking Budget |
| :--- | :--- | :--- | :--- |
| `antigravity-gemini-3.8-flash` | Gemini 3.8 Flash | Text, Vision, Tools | Low / Medium / High |
| `antigravity-gemini-3.7-flash` | Gemini 3.7 Flash | Text, Vision, Tools | Low / Medium / High |
| `antigravity-gemini-3.1-pro` | Gemini 3.1 Pro | Text, Vision, Tools | Low / High |
| `claude-sonnet-4-6-thinking` | Claude Sonnet 4.6 | Text, Vision, Tools | Dynamic Reasoning |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 | Text, Vision, Tools | Dynamic Reasoning |
| `gpt-oss-120b-medium` | GPT-OSS 120B | Text, Tools | Fixed Effort |

### 3. Image Generation & Multi-Turn Editing
- **`generate_image`**: Prompt-based image creation and iterative image-to-image editing using session references.
- **`list_images`**: Inspect and retrieve generated image attachments within the current session.
- Fully integrated with DSH `AttachmentStore` without polluting chat context with raw base64 payloads.

---

## Installation

Inside your DSH profile or root project:

```sh
npm install dsh-tool-antigravity
# or using pnpm
pnpm add dsh-tool-antigravity
```

### Cordis Plugin Configuration

Add the plugin to your `cordis.patch.yml` or DSH config file:

```yaml
- id: antigravity-auth
  name: 'dsh-tool-antigravity'

- id: antigravity-image
  name: 'dsh-tool-antigravity/image'
```

---

## Usage & Commands

### Slash Commands
Manage authentication directly from the DSH terminal / chat prompt:

- `/antigravity-auth login`: Initiates Google OAuth 2.0 PKCE login and launches your default browser.
- `/antigravity-auth status`: Check current authentication state, masked email, and project id.
- `/antigravity-auth logout`: Discard credentials and revoke tokens.
- `/antigravity-auth cancel`: Abort an ongoing login attempt.

### UI Settings & Dashboard
Once loaded in the DSH Web client:
- **Antigravity Auth Settings Card**: View live login status, account identifier, and toggle capabilities.
- **Quota Visualizer**: Real-time remaining quota percentages and countdowns for 5-hour and weekly reset windows.

---

## Security & Invariants

1. **Credential Isolation**: Access and refresh tokens are strictly held in host-side secure stores and are never forwarded to the frontend UI, logs, or command done events.
2. **Strict Loopback Guard**: Account RPC endpoints fail-closed (`loopback-required`) unless the web service is explicitly bound to `127.0.0.1`.
3. **Immutable Wire Identity**: Emits verified AGY CLI headers (`antigravity/cli/1.1.24`) and attribution metadata.
4. **Media Path Containment**: All file references are verified against directory traversal and symlink escapes.

---

## Disclaimer

This project is an unofficial, community-driven capability bundle intended strictly for personal research, educational purposes, and independent development. Please adhere to relevant platform Terms of Service.

---

## License

[MIT](LICENSE) © [dsh-tool-antigravity contributors](LICENSE)
