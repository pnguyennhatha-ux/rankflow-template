import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKEND_URL, getSettings, isLoopbackUrl, normalizeBackendUrl, originPattern } from "./settings";

afterEach(() => vi.unstubAllGlobals());

describe("backend URL rules", () => {
  it("defaults to the local backend", () => {
    expect(normalizeBackendUrl("")).toBe("http://localhost:8787");
    expect(DEFAULT_BACKEND_URL).toBe("http://localhost:8787");
  });
  it("accepts http only for loopback hosts, any port", () => {
    expect(normalizeBackendUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeBackendUrl("http://localhost:9000")).toBe("http://localhost:9000");
    expect(normalizeBackendUrl("https://rank.example.com/api/")).toBe("https://rank.example.com/api");
    expect(() => normalizeBackendUrl("http://192.168.1.10:8787")).toThrow();
    expect(() => normalizeBackendUrl("ftp://localhost")).toThrow();
    expect(() => normalizeBackendUrl("http://localhost:8787/?x=1")).toThrow();
  });
  it("derives permission patterns and loopback detection", () => {
    expect(originPattern("https://rank.example.com:8443/x")).toBe("https://rank.example.com/*");
    expect(isLoopbackUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackUrl("https://rank.example.com")).toBe(false);
  });
});

describe("getSettings", () => {
  it("creates and persists a stable worker id and enables the worker by default", async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({ ...store })), set: vi.fn(async (value: Record<string, unknown>) => Object.assign(store, value)) } } });
    const first = await getSettings();
    expect(first.workerId).toMatch(/^2j-[0-9a-f]{8}$/);
    expect(first.workerEnabled).toBe(true);
    expect(first.backendUrl).toBe("http://localhost:8787");
    expect((await getSettings()).workerId).toBe(first.workerId);
  });
  it("falls back to the default when a stored URL is invalid", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({ backendUrl: "http://evil.example", workerId: "2j-x", workerEnabled: false })), set: vi.fn() } } });
    const settings = await getSettings();
    expect(settings.backendUrl).toBe("http://localhost:8787");
    expect(settings.workerEnabled).toBe(false);
  });
});
