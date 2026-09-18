import { describe, expect, it } from "vitest";
import {
  identifyGroup,
  identifyWindow,
  normalizeFraction,
  normalizeQuotaResponse,
  normalizeResetTime,
  createQuotaService,
  QuotaNormalizationError
} from "../src/quota-service.js";
import type { PrivateTransport } from "../src/private-transport.js";

describe("Quota Window Identification & Duration Parsing", () => {
  it("identifies standard 5h and weekly strings", () => {
    expect(identifyWindow({ window: "5h" })).toBe("5h");
    expect(identifyWindow({ window: "5-hour" })).toBe("5h");
    expect(identifyWindow({ window: "pt5h" })).toBe("5h");
    expect(identifyWindow({ window: "weekly" })).toBe("weekly");
    expect(identifyWindow({ window: "7d" })).toBe("weekly");
    expect(identifyWindow({ window: "7-day" })).toBe("weekly");
    expect(identifyWindow({ window: "p7d" })).toBe("weekly");
  });

  it("identifies numeric durations in seconds", () => {
    // 5 hours = 18,000s
    expect(identifyWindow({ durationSeconds: 18000 })).toBe("5h");
    // 7 days = 604,800s
    expect(identifyWindow({ durationSeconds: 604800 })).toBe("weekly");
  });

  it("identifies string duration format (e.g. 18000s)", () => {
    expect(identifyWindow({ duration: "18000s" })).toBe("5h");
    expect(identifyWindow({ duration: "604800s" })).toBe("weekly");
  });

  it("identifies millisecond durations", () => {
    expect(identifyWindow({ duration: 18000000 })).toBe("5h");
    expect(identifyWindow({ duration: 604800000 })).toBe("weekly");
  });

  it("returns undefined for unrecognized durations", () => {
    expect(identifyWindow({ window: "unknown" })).toBeUndefined();
    expect(identifyWindow({})).toBeUndefined();
  });
});

describe("Quota Group Classification & Normalization", () => {
  it("classifies Gemini models into 'gemini' group", () => {
    expect(identifyGroup({ displayName: "Gemini 3.8 Flash" })).toBe("gemini");
    expect(identifyGroup({ title: "Google Gemini 3.1 Pro" })).toBe("gemini");
    expect(identifyGroup({})).toBe("gemini");
  });

  it("classifies Claude and GPT models into 'non-gemini' group", () => {
    expect(identifyGroup({ displayName: "Claude 4.6 Sonnet" })).toBe("non-gemini");
    expect(identifyGroup({ name: "GPT-OSS 120B" })).toBe("non-gemini");
    expect(identifyGroup({ group: "3p-models" })).toBe("non-gemini");
    expect(identifyGroup({ title: "Third-party models" })).toBe("non-gemini");
  });

  it("normalizes remaining fraction", () => {
    expect(normalizeFraction(0.75)).toBe(0.75);
    expect(normalizeFraction(75)).toBe(0.75);
    expect(normalizeFraction(100)).toBe(1);
    expect(normalizeFraction(0)).toBe(0);
    expect(normalizeFraction(-5)).toBeUndefined();
    expect(normalizeFraction(150)).toBeUndefined();
  });

  it("normalizes reset time into ISO string", () => {
    const now = 1700000000000;
    const iso = new Date(now + 3600000).toISOString();
    expect(normalizeResetTime(iso, now)).toBe(iso);

    const epochSeconds = Math.floor((now + 3600000) / 1000);
    expect(normalizeResetTime(epochSeconds, now)).toBe(new Date(epochSeconds * 1000).toISOString());
  });

  it("normalizes full provider quota response and sorts windows", () => {
    const now = 1700000000000;
    const rawResponse = {
      response: {
        groups: [
          {
            displayName: "Gemini Flash & Pro",
            buckets: [
              {
                window: "weekly",
                remainingFraction: 0.9,
                resetTime: new Date(now + 86400000).toISOString()
              },
              {
                window: "5h",
                remainingFraction: 0.5,
                resetTime: new Date(now + 3600000).toISOString()
              }
            ]
          }
        ]
      }
    };

    const snapshot = normalizeQuotaResponse(rawResponse, now);
    expect(snapshot.state).toBe("available");
    expect(snapshot.groups?.length).toBe(1);

    const geminiGroup = snapshot.groups?.[0];
    expect(geminiGroup?.group).toBe("gemini");
    // 5h must sort before weekly
    expect(geminiGroup?.windows[0]?.window).toBe("5h");
    expect(geminiGroup?.windows[1]?.window).toBe("weekly");
  });

  it("throws QuotaNormalizationError when response is not a valid record", () => {
    expect(() => normalizeQuotaResponse(null)).toThrow(QuotaNormalizationError);
    expect(() => normalizeQuotaResponse("invalid string")).toThrow(QuotaNormalizationError);
  });

  it("returns empty groups when record has no quota groups", () => {
    const result = normalizeQuotaResponse({ empty: true });
    expect(result.state).toBe("available");
    expect(result.groups).toEqual([]);
  });
});

describe("Quota Service Deduplication & SWR Resilience", () => {
  it("deduplicates concurrent refresh calls into single network request", async () => {
    let networkCalls = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const mockTransport: PrivateTransport = {
      request: async () => {
        networkCalls += 1;
        await barrier; // Controlled deterministic pause
        return new Response(
          JSON.stringify({
            response: {
              groups: [
                {
                  displayName: "Gemini",
                  buckets: [
                    {
                      window: "5h",
                      remainingFraction: 0.8,
                      resetTime: new Date(1700000000000).toISOString()
                    }
                  ]
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
    };

    const clock = 1000;
    const service = createQuotaService({
      auth: { credential: async () => ({ accessToken: "tok", projectId: "p" }) },
      transport: mockTransport,
      now: () => clock,
      minIntervalMs: 1000
    });

    // Start 3 refreshes simultaneously while barrier is held
    const p1 = service.refresh(undefined, true);
    const p2 = service.refresh(undefined, true);
    const p3 = service.refresh(undefined, true);

    // Release the barrier
    releaseBarrier();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(networkCalls).toBe(1);
    expect(r1.state).toBe("available");
    expect(r2.state).toBe("available");
    expect(r3.state).toBe("available");
  });

  it("maintains SWR cached groups with stale flag when network refresh fails", async () => {
    let shouldFail = false;
    const mockTransport: PrivateTransport = {
      request: async () => {
        if (shouldFail) {
          return new Response(JSON.stringify({ error: "gateway timeout" }), { status: 504 });
        }
        return new Response(
          JSON.stringify({
            response: {
              groups: [
                {
                  displayName: "Gemini",
                  buckets: [
                    {
                      window: "5h",
                      remainingFraction: 0.8,
                      resetTime: new Date(1700000000000).toISOString()
                    }
                  ]
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
    };

    let clock = 1000;
    const service = createQuotaService({
      auth: { credential: async () => ({ accessToken: "tok", projectId: "p" }) },
      transport: mockTransport,
      now: () => clock,
      minIntervalMs: 100
    });

    // 1. Initial success
    const first = await service.refresh(undefined, true);
    expect(first.state).toBe("available");
    expect(first.groups?.length).toBe(1);
    expect(first.stale).toBeFalsy();

    // 2. Advance deterministic clock past minIntervalMs
    clock += 500;
    shouldFail = true;

    // 3. Network fails
    const second = await service.refresh(undefined, true);

    // SWR behavior: returns error state but preserves cached groups with stale=true
    expect(second.stale).toBe(true);
    expect(second.groups?.length).toBe(1);
    expect(second.groups?.[0]?.group).toBe("gemini");
  });
});
