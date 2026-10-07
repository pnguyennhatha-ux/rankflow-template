// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

it("popup counts distinct pairs/owners from the synced groups and asks for a fresh sync on open", async () => {
  const OU1 = "ou_" + "1".repeat(32);
  const store: Record<string, unknown> = {
    workerState: { connected: true, currentRun: null, lastResult: null, log: [] }, workerId: "2j-test",
    backendGroups: { syncedAt: new Date().toISOString(), watchlists: {}, server_time: "", groups: [
      { watchlist_id: "w", group: "", pairs: 2, asins: [{ asin: "B0AAAAAAAA", keywords: ["a", "b"], owners: { a: { id: OU1, name: "Hana" } } }] },
      { watchlist_id: "w", group: "NA", pairs: 1, owners: [{ id: OU1, name: "Hana" }], asins: [{ asin: "B0BBBBBBBB", keywords: ["a"] }] },
      { watchlist_id: "w", group: "NA  1", pairs: 1, asins: [{ asin: "B0CCCCCCCC", keywords: ["c"] }] },
      { watchlist_id: "w", group: "Nhóm 5", pairs: 36, asins: [{ asin: "B0DDDDDDDD", keywords: ["d"] }] }
    ] }
  };
  const sendMessage = vi.fn(async () => ({ ok: true }));
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values: Record<string, unknown>) => { Object.assign(store, values); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    runtime: { sendMessage, getURL: (path: string) => path },
    tabs: { create: vi.fn() }
  };
  const html = readFileSync(resolve(process.cwd(), "entrypoints/popup/index.html"), "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
  await import("../entrypoints/popup/main");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const text = document.getElementById("root")!.textContent ?? "";
  expect(text).toContain("4 nhóm · 5 cặp · 1 owner"); // not 2+1+1+36 = 40 from the per-group counters
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "WORKER_REFRESH_GROUPS" }));
});
