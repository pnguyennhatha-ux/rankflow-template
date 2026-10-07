// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

it("popup renders its status card (not an empty, invisible popup)", async () => {
  const store: Record<string, unknown> = { workerState: { connected: true, currentRun: null, lastResult: null, log: [] }, workerId: "2j-test" };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values: Record<string, unknown>) => { Object.assign(store, values); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    runtime: { sendMessage: async () => ({ ok: true }), getURL: (path: string) => path },
    tabs: { create: vi.fn() }
  };
  const html = readFileSync(resolve(process.cwd(), "entrypoints/popup/index.html"), "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
  expect(document.querySelector("[data-fallback]")).not.toBeNull(); // visible even before the bundle runs
  await import("../entrypoints/popup/main");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const root = document.getElementById("root")!;
  expect(root.querySelector("[data-fallback]")).toBeNull();
  expect(root.textContent).toContain("Rảnh · chờ yêu cầu");
  expect(root.textContent).toContain("Mở Dashboard");
});
