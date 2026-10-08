# dsh-tool-antigravity

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-tool-antigravity.svg?color=blue)](https://www.npmjs.com/package/dsh-tool-antigravity)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-tool-antigravity.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-antigravity.svg)](https://github.com/Jaylor-Wang/dsh-tool-antigravity/releases)
[![Tests](https://img.shields.io/badge/tests-29%20suites%20%7C%20279%20passed-brightgreen.svg)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

High-performance, streamlined Antigravity capability bundle plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Provides private Google OAuth 2.0 PKCE authentication, multi-model LLM routing (`google-antigravity`), session-persistent Nano Banana 2 image generation and editing (`generate_image`, `list_images`), and an interactive Web settings panel with live quota visualization.

---

## Highlights in v0.3.5 (Multi-Account Pool with Quota-Driven Rotation)

- **Multi-Account Pool (`accounts.json`)**: Seamlessly manage multiple Google Antigravity accounts with strict POSIX `0600` owner-only permissions, inter-process locking (`.pool.lock`), and salted SHA-256 identity tagging (`emailTag`) without exposing PII.
- **Quota-Driven Automatic Rotation**: Automatically detects LLM 429 quota exhaustion during generation, marks cooldowns, and rotates to the next ready account with zero interruption to downstream users.
- **Per-Model-Family Cursor Isolation**: Independent rotation cursors for Gemini and Claude model families (`activeIndexByFamily`)—quota exhaustion on Gemini never burns Claude.
- **Visual Settings Management**: View signed-in accounts, active status, cooldown countdowns, and failure counts with one-click account switching and removal in the settings card.
- **Retains v0.3.2 capabilities**: Scoped HTTPS proxy isolation, zero global dispatcher pollution, and robust keep-alive connection pooling.
## Features

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
| `antigravity-gemini-3.6-flash` | Gemini 3.6 Flash | Text, Vision, Tools | Default |
| `antigravity-gemini-3.1-pro` | Gemini 3.1 Pro | Text, Vision, Tools | Low / High |
| `claude-sonnet-4-6-thinking` | Claude Sonnet 4.6 | Text, Vision, Tools | Dynamic Reasoning |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 | Text, Vision, Tools | Dynamic Reasoning |
| `gpt-oss-120b-medium` | GPT-OSS 120B | Text, Tools | Fixed Effort |

### 3. Nano Banana 2 Image Generation & Multi-Turn Editing
- **`generate_image`**: Prompt-based image creation and iterative image-to-image editing powered by Nano Banana 2 (`gemini-3.1-flash-image`) using session references.
- **`list_images`**: Inspect and retrieve generated image attachments within the current session.
- Fully integrated with DSH `AttachmentStore` and `FileSystem` with TOCTOU path escape protection without polluting chat context with raw base64 payloads.

---

## Installation

### Via DSH Plugin CLI (Recommended)
```sh
# Add directly to your active DSH web profile
dsh plugin --profile web add dsh-tool-antigravity
```

### Via npm / pnpm
```sh
# Using npm
npm install dsh-tool-antigravity

# Using pnpm
pnpm add dsh-tool-antigravity
```

### Cordis Plugin Configuration
Add the plugin entries to your `cordis.patch.yml` or DSH config file:

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
- **Image Generation Card**: Configure default image models and batch size.

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
