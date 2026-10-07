import { afterEach, describe, expect, it, vi } from "vitest";
import { requestRunNow } from "./backend";
import { NO_GROUP, groupLabel, groupRunValue, runNowGroupParam } from "./groups";
import type { ExtensionSettings } from "./settings";

afterEach(() => vi.unstubAllGlobals());
const settings: ExtensionSettings = { backendUrl: "http://localhost:8787", workerToken: "", workerEnabled: true, workerId: "2j-test" };

function captureRunNow() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  return () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/worker/run-now");
    return JSON.parse(String(init.body)) as { group?: string; watchlist_id?: string };
  };
}

describe("run-now group filter", () => {
  it("ungrouped row sends the NO_GROUP sentinel, never an empty (= all) filter", async () => {
    const lastBody = captureRunNow();
    await requestRunNow(groupRunValue(""), "team-a", settings);   // dashboard '(không nhóm)' row
    expect(lastBody()).toEqual({ group: NO_GROUP, watchlist_id: "team-a" });
    await requestRunNow("", "team-a", settings);                  // raw "" is also mapped, not dropped
    expect(lastBody()).toEqual({ group: NO_GROUP, watchlist_id: "team-a" });
  });
  it("main 'Chạy ngay' (no group) still means all groups", async () => {
    const lastBody = captureRunNow();
    await requestRunNow(undefined, undefined, settings);
    expect(lastBody()).toEqual({});
    expect("group" in lastBody()).toBe(false);
  });
  it("named groups pass through unchanged (incl. internal double spaces)", async () => {
    const lastBody = captureRunNow();
    await requestRunNow(groupRunValue("NA  1"), "team-a", settings);
    expect(lastBody().group).toBe("NA  1");
  });
  it("helpers", () => {
    expect(runNowGroupParam(undefined)).toBeUndefined();
    expect(runNowGroupParam(null)).toBeUndefined();
    expect(runNowGroupParam("  ")).toBe(NO_GROUP);
    expect(runNowGroupParam(NO_GROUP)).toBe(NO_GROUP);
    expect(groupLabel("")).toBe("(không nhóm)");
    expect(groupLabel(NO_GROUP)).toBe("(không nhóm)");
    expect(groupLabel("Nhóm 5")).toBe("Nhóm 5");
  });
});
