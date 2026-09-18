# dsh-tool-antigravity

DeepSeek Harness (DSH) 高性能 Antigravity 能力包插件。

专注于两大核心功能：
1. **LLM 路由与模型服务**（`google-antigravity`）：集成 Gemini 3.8/3.7/3.6/3.1 Flash/Pro、Claude Sonnet/Opus 4.6 Thinking、GPT-OSS 120B 等模型。
2. **图片生成与多轮编辑**（`generate_image` / `list_images`）：接入 DSH `AttachmentStore`，提供多模态创作能力。

## 关键优化特性
- **底层长连接池（TLS Socket Keep-Alive）与会话复用**：彻底消除逐请求 TLS 握手开销，首字延迟（TTFT）大幅降低。
- **高吞吐 Buffer 游标滑动 SSE 解析**：消除流式回答过程中的高频字符串累加，降低 V8 堆内存与 GC 压力。
- **细粒度思考预算（Thinking Budget）与幂等容错**：更平滑的思维链控制与首字节断线自愈。
- **跨平台鲁棒性**：Windows 平台 PID 活性检测清理残留锁，杜绝 30 秒卡顿异常。
- **配额看板 SWR 容错**：接口波动时保持展示上一次有效快照与重试提示。

## 安装与使用

在 DSH 环境中安装并加载本插件：
```sh
npm install dsh-tool-antigravity
```

并在 Cordis 或 DSH 配置文件中注入插件行。

## 许可证

[MIT](LICENSE)
