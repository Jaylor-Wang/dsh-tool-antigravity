import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { parseSseFrame, SseStreamParser, stripXssiPrefix } from "../src/sse-parser.js";
import {
  antigravityModelFamily,
  applyClaudeToolHardening,
  groupClaudeFunctionResponses
} from "../src/replay.js";
import {
  cleanModelDisplayName,
  getModelReasoningEfforts,
  parseLiveModelIds,
  resolveWireModel
} from "../src/model-catalog.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { AntigravityAdapter } from "../src/llm-adapter.js";
import type { PrivateTransport } from "../src/private-transport.js";

describe("SSE Stream Parser & XSSI Protection", () => {
  it("strips Google XSSI defense prefixes safely", () => {
    expect(stripXssiPrefix(")]}'\n{\"status\": \"ok\"}")).toBe("{\"status\": \"ok\"}");
    expect(stripXssiPrefix(")]}'\r\n{\"status\": \"ok\"}")).toBe("{\"status\": \"ok\"}");
    expect(stripXssiPrefix("{\"status\": \"ok\"}")).toBe("{\"status\": \"ok\"}");
  });

  it("parses single and multi-line SSE frames", () => {
    const frame = "event: message\ndata: first line\ndata: second line\n\n";
    const parsed = parseSseFrame(frame);
    expect(parsed).toBeDefined();
    expect(parsed?.event).toBe("message");
    expect(parsed?.data).toBe("first line\nsecond line");
  });

  it("handles chunk fragmentation across sliding buffer", () => {
    const parser = new SseStreamParser();
    const part1 = Buffer.from(")]}'\ndata: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hel");
    const part2 = Buffer.from("lo \"}]}}]}\n\ndata: [DONE]\n\n");

    const events1 = Array.from(parser.push(part1));
    expect(events1).toHaveLength(0); // Incomplete frame

    const events2 = Array.from(parser.push(part2));
    expect(events2).toHaveLength(2);
    expect(events2[0].data).toContain("Hello ");
    expect(events2[1].data).toBe("[DONE]");
  });
});

describe("Model Catalog & Reasoning Efforts", () => {
  it("maps Gemini 3.8 and 3.7 models to exact wire names and budgets", () => {
    expect(resolveWireModel("gemini-3.7-flash")).toBe("gemini-3-flash");
    expect(resolveWireModel("antigravity-gemini-3.7-flash")).toBe("gemini-3-flash");
    expect(resolveWireModel("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
    expect(resolveWireModel("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-low");
  });

  it("provides correct reasoning effort levels for Flash and Pro models", () => {
    const flashEfforts = getModelReasoningEfforts("gemini-3.8-flash");
    expect(flashEfforts).toBeDefined();
    expect(flashEfforts?.efforts).toHaveLength(3); // low, medium, high

    const proEfforts = getModelReasoningEfforts("gemini-3.1-pro");
    expect(proEfforts).toBeDefined();
    expect(proEfforts?.efforts).toHaveLength(2); // low, high

    const claudeEfforts = getModelReasoningEfforts("claude-4-6-sonnet");
    expect(claudeEfforts).toBeUndefined();
  });

  it("cleans display names without trailing parenthetical aliases", () => {
    expect(cleanModelDisplayName("Gemini 3.8 Flash (Preview)")).toBe("Gemini 3.8 Flash");
    expect(cleanModelDisplayName("Claude 4.6 Sonnet (Thinking)")).toBe("Claude 4.6 Sonnet");
  });

  it("parses live model catalog IDs correctly", () => {
    const rawResponse = {
      models: {
        "models/gemini-3-flash": {},
        "models/gemini-3.8-flash": {},
        "models/claude-4-6-sonnet": {}
      }
    };
    const liveIds = parseLiveModelIds(rawResponse, {});
    expect(liveIds.has("gemini-3.7-flash")).toBe(true);
    expect(liveIds.has("gemini-3.8-flash")).toBe(true);
    expect(liveIds.has("claude-4-6-sonnet")).toBe(true);
  });
});

describe("Replay & Tool Call Prompt Hardening", () => {
  it("accurately classifies model families", () => {
    expect(antigravityModelFamily("gemini-3.8-flash")).toBe("gemini");
    expect(antigravityModelFamily("claude-4-6-sonnet")).toBe("claude");
    expect(antigravityModelFamily("gpt-oss-120b")).toBe("gpt-oss");
    expect(antigravityModelFamily("unknown-future-model")).toBe("unknown");
  });

  it("hardens Claude tool schemas with parameter signatures and instructions", () => {
    const request = {
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file from disk",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" }
                },
                required: ["path"]
              }
            }
          ]
        }
      ]
    };

    applyClaudeToolHardening(request);
    const system = (request as { systemInstruction?: { parts: Array<{ text: string }> } }).systemInstruction;
    expect(system).toBeDefined();
    expect(system?.parts[0].text).toContain("CRITICAL TOOL USAGE INSTRUCTIONS");

    const decl = (request.tools[0] as { functionDeclarations: Array<{ description: string }> }).functionDeclarations[0];
    expect(decl.description).toContain("STRICT PARAMETERS:");
    expect(decl.description).toContain("path (string, REQUIRED)");
  });

  it("groups adjacent function responses for Claude", () => {
    const contents = [
      {
        role: "user",
        parts: [{ functionResponse: { name: "tool_1", response: { result: "ok 1" } } }]
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "tool_2", response: { result: "ok 2" } } }]
      }
    ];

    const grouped = groupClaudeFunctionResponses(contents, "claude-4-6-sonnet");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].parts).toHaveLength(2);
  });
});

describe("Antigravity Adapter Streaming & Flow Control", () => {
  it("filters out image-only models from text model listing", () => {
    const adapter = new AntigravityAdapter({
      auth: {
        credential: async () => ({
          accessToken: "mock_token",
          projectId: "mock-proj"
        })
      }
    });

    const textModels = adapter.pinnedTextModelInfos();
    expect(textModels.length).toBeGreaterThan(0);
    // Every advertised model must have text as an input modality
    for (const model of textModels) {
      expect(model.inputModalities).toContain("text");
    }
  });

  it("streams text-delta chunks and emits finish reason with replay state", async () => {
    const ssePayload = [
      "data: " + JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: "Hello from Antigravity!" }]
            }
          }
        ]
      }) + "\n\n",
      "data: " + JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: "" }]
            }
          }
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 5
        }
      }) + "\n\n",
      "data: [DONE]\n\n"
    ].join("");

    const mockResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload));
          controller.close();
        }
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const mockTransport: PrivateTransport = {
      request: async () => mockResponse
    };

    const adapter = new AntigravityAdapter({
      auth: {
        credential: async () => ({
          accessToken: "mock_token",
          projectId: "mock-project"
        })
      },
      transport: mockTransport
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: "google-antigravity",
      model: "gemini-3.8-flash",
      messages: [
        createUserMessage({
          content: [{ type: "text", text: "Hi" }],
          source: { kind: "user" }
        })
      ]
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.length).toBe(1);
    const firstDelta = textDeltas[0];
    if (firstDelta?.type === "text-delta") {
      expect(firstDelta.text).toBe("Hello from Antigravity!");
    }

    const finishChunk = chunks.find((c) => c.type === "finish");
    expect(finishChunk).toBeDefined();
    if (finishChunk?.type === "finish") {
      expect(finishChunk.reason.kind).toBe("stop");
      expect(finishChunk.replayState).toBeDefined();
    }
  });
});
