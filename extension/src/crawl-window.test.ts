import { describe, expect, it } from "vitest";
import { TabPool, createCrawlWindowTabs, type ChromeLike } from "./scheduler";
import { markConnectionErrorsResolved, type WorkerState } from "./worker-state";

function fakeChrome(options: { refuseMinimized?: boolean; wmFocusesNewWindow?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const windows = new Map<number, { focused: boolean; tabs: Set<number> }>([[1, { focused: true, tabs: new Set([10]) }]]);
  let nextWindow = 2;
  let nextTab = 100;
  const api: ChromeLike = {
    windows: {
      async create(data) {
        calls.push(["windows.create", data]);
        if (data.state === "minimized" && options.refuseMinimized) throw new Error("minimized not supported");
        const id = nextWindow++;
        const tab = nextTab++;
        windows.set(id, { focused: Boolean(options.wmFocusesNewWindow), tabs: new Set([tab]) });
        if (options.wmFocusesNewWindow) windows.get(1)!.focused = false;
        return { id, tabs: [{ id: tab }] };
      },
      async get(id) { const w = windows.get(id); if (!w) throw new Error("no window"); return { id, focused: w.focused }; },
      async getLastFocused() { return { id: 1, focused: windows.get(1)!.focused }; },
      async update(id, data) { calls.push(["windows.update", { id, ...data }]); for (const [key, w] of windows) w.focused = key === id; return {}; }
    },
    tabs: {
      async create(data) { calls.push(["tabs.create", data]); const id = nextTab++; windows.get(data.windowId!)!.tabs.add(id); return { id }; },
      async update(id, data) { calls.push(["tabs.update", { id, ...data }]); return {}; },
      async remove(id) { calls.push(["tabs.remove", id]); for (const [key, w] of windows) { w.tabs.delete(id); if (key !== 1 && !w.tabs.size) windows.delete(key); } return {}; },
      async get(id) { for (const w of windows.values()) if (w.tabs.has(id)) return {}; throw new Error("no tab"); }
    }
  };
  return { api, calls, windows };
}

describe("crawl window (no focus stealing)", () => {
  it("opens slot tabs in one unfocused minimized window, never activates them, and closes it at the end", async () => {
    const chrome = fakeChrome();
    const crawl = createCrawlWindowTabs(chrome.api);
    const pool = new TabPool(crawl.api);
    const zipTab = await pool.open(0, "https://www.amazon.com/");
    const slot2 = await pool.open(1, "/s?k=b");
    await pool.open(0, "/s?k=a");
    expect(chrome.calls[0]).toEqual(["windows.create", { url: "https://www.amazon.com/", focused: false, state: "minimized", type: "normal" }]);
    expect(chrome.calls.find(([name]) => name === "tabs.create")![1]).toEqual({ windowId: crawl.windowId(), url: "/s?k=b", active: false });
    expect(chrome.calls.filter(([name]) => name === "tabs.update").every(([, data]) => !("active" in (data as object)))).toBe(true);
    expect(chrome.calls.some(([name]) => name === "windows.update")).toBe(false);
    expect(chrome.windows.get(1)!.focused).toBe(true); // user's window keeps focus
    expect(chrome.windows.get(1)!.tabs.has(zipTab) || chrome.windows.get(1)!.tabs.has(slot2)).toBe(false); // nothing in the user's window
    await pool.closeAll();
    crawl.reset();
    expect(chrome.windows.size).toBe(1);
  });

  it("falls back to an unfocused normal window and hands focus back if the window manager focused it", async () => {
    const chrome = fakeChrome({ refuseMinimized: true, wmFocusesNewWindow: true });
    const crawl = createCrawlWindowTabs(chrome.api);
    await crawl.api.create("https://www.amazon.com/");
    expect(chrome.calls.filter(([name]) => name === "windows.create").map(([, data]) => (data as { state?: string }).state)).toEqual(["minimized", undefined]);
    expect(chrome.calls.find(([name]) => name === "windows.update")![1]).toEqual({ id: 1, focused: true });
    expect(chrome.windows.get(1)!.focused).toBe(true);
  });

  it("re-creates the crawl window if the user closed it mid-run", async () => {
    const chrome = fakeChrome();
    const crawl = createCrawlWindowTabs(chrome.api);
    await crawl.api.create("a");
    const first = crawl.windowId()!;
    chrome.windows.delete(first);
    await crawl.api.create("b");
    expect(crawl.windowId()).not.toBe(first);
  });
});

describe("stale backend error lines", () => {
  it("marks old connection errors resolved after a successful contact; run errors stay", () => {
    const state: WorkerState = { connected: true, currentRun: null, lastResult: null, log: [
      { at: "2026-10-06T11:00:00Z", level: "error", message: "Không kết nối được backend http://localhost:8787 (Failed to fetch). Hãy chạy: python3 backend/rankflow.py serve" },
      { at: "2026-10-06T10:00:00Z", level: "error", message: "Run rf2-x dừng (captcha): ..." }
    ] };
    expect(markConnectionErrorsResolved(state)).toBe(true);
    expect(state.log[0]).toMatchObject({ level: "info", message: "Đã kết nối lại backend." });
    expect(state.log[1]!.resolved).toBe(true);
    expect(state.log[2]!.resolved).toBeUndefined();
    expect(markConnectionErrorsResolved(state)).toBe(false); // idempotent: no extra log lines on every poll
  });
});
