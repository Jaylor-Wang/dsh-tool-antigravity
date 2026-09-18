# dsh-tool-antigravity

Streamlined, high-performance Antigravity capability bundle plugin for DeepSeek Harness (DSH).

Focuses exclusively on two core features:
1. **LLM Routing & Model Catalog** (`google-antigravity`): Native support for Gemini 3.8/3.7/3.6/3.1 Flash/Pro, Claude Sonnet/Opus 4.6 Thinking, and GPT-OSS 120B.
2. **Image Generation & Editing** (`generate_image` / `list_images`): Persistent session image creation and multi-turn reference editing via DSH `AttachmentStore`.

## Key Performance & Stability Enhancements
- **TLS Socket Connection Pooling & Session Resumption**: Eliminates per-request TLS handshake latency, dramatically improving Time-To-First-Token (TTFT).
- **Zero-Copy / Sliding-Window Buffer SSE Parser**: Bypasses heavy string concatenations to reduce V8 heap reallocations and GC pressure during streaming.
- **Granular Reasoning Budget & Idempotent Retry**: Smooth thinking budget control and graceful single-attempt recovery before first byte emission.
- **Robust Windows File Locking**: Active PID probing eliminates 30s stale lock freezes upon abnormal process termination.
- **Stale-While-Revalidate (SWR) Quota Dashboard**: Graceful fallback and refresh state during transient network hiccups.

## License

[MIT](LICENSE)
