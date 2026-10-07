import { describe, expect, it } from "vitest";
import { badgeFor, deriveStatus, runPercent } from "./status";
import type { WorkerState } from "./worker-state";

const base = { connected: true, log: [] } as unknown as WorkerState;
const run = (patch: Record<string, unknown>) => ({ ...base, currentRun: { runId: "r", completed: 1, keywordsTotal: 4, pairsTotal: 4, message: "m", phase: "crawl", inflight: {}, ...patch } }) as unknown as WorkerState;

describe("worker status", () => {
  it("is idle when connected with no run", () => {
    expect(deriveStatus(base, { enabled: true }).kind).toBe("idle");
  });
  it("shows running x/y keywords with partial progress", () => {
    const status = deriveStatus(run({ inflight: { a: 0.5 } }), { enabled: true });
    expect(status).toMatchObject({ kind: "running", label: "Đang chạy 1/4 keyword", percent: 38 });
  });
  it("shows paused on CAPTCHA backoff", () => {
    expect(deriveStatus(run({ pausedUntil: 2_000 }), { enabled: true, now: 1_000 }).kind).toBe("paused");
    expect(deriveStatus({ ...base, cooldownUntil: 5_000 } as WorkerState, { enabled: true, now: 1_000 }).kind).toBe("paused");
  });
  it("shows offline / error / disabled", () => {
    expect(deriveStatus({ ...base, connected: false } as WorkerState, { enabled: true }).kind).toBe("offline");
    expect(deriveStatus({ ...base, lastError: "x" } as WorkerState, { enabled: true }).kind).toBe("error");
    expect(deriveStatus(base, { enabled: false }).kind).toBe("disabled");
  });
  it("never reports 100% before the last keyword completes", () => {
    expect(runPercent({ completed: 0, keywordsTotal: 1, inflight: { a: 1 } })).toBe(95);
    expect(runPercent({ completed: 4, keywordsTotal: 4 })).toBe(100);
  });
  it("badge: empty when idle/connected or not yet contacted; '!' only on error/offline", () => {
    expect(badgeFor(base, { enabled: true }).text).toBe("");
    expect(badgeFor({ currentRun: null, lastResult: null, log: [] } as WorkerState, { enabled: true }).text).toBe("");
    expect(badgeFor(base, { enabled: false }).text).toBe("");
    expect(badgeFor({ ...base, connected: false } as WorkerState, { enabled: true })).toEqual({ text: "!", color: "#c0362c" });
    expect(badgeFor({ ...base, lastError: "x" } as WorkerState, { enabled: true }).text).toBe("!");
    expect(badgeFor(run({ inflight: { a: 0.5 } }), { enabled: true }).text).toBe("38%");
    expect(badgeFor(run({ pausedUntil: 2_000 }), { enabled: true, now: 1_000 }).text).toBe("II");
  });
  it("fresh install (no poll yet) is not shown as offline", () => {
    expect(deriveStatus({ currentRun: null, lastResult: null, log: [] } as WorkerState, { enabled: true }).kind).toBe("idle");
  });
});
