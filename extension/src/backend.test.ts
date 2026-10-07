import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendError, claimJob, postResult, sendHeartbeat } from "./backend";
import type { ExtensionSettings } from "./settings";

afterEach(() => vi.unstubAllGlobals());
const settings: ExtensionSettings = { backendUrl: "http://localhost:8787", workerToken: "", workerEnabled: true, workerId: "2j-test" };

describe("worker API client", () => {
  it("claims with X-Worker-Id and treats 204 as no job", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204, headers: { "X-Groups-Version": "v1" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await claimJob(settings)).toEqual({ job: null, groupsVersion: "v1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/job");
    expect((init.headers as Record<string, string>)["X-Worker-Id"]).toBe("2j-test");
    expect((init.headers as Record<string, string>)["X-Worker-Token"]).toBeUndefined();
  });
  it("long-polls with a bounded wait and returns the job", async () => {
    const job = { run_id: "r1", lease_token: "t" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(job), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await claimJob(settings, 20)).job).toMatchObject(job);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:8787/job?wait=20");
    await claimJob(settings, 99);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("http://localhost:8787/job?wait=25");
  });
  it("sends JSON + token on POST", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, run_id: "r", run_status: "done", done: 1, requeued: 0, failed: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await postResult({ lease_token: "t", run_id: "r", job_id: "j", watchlist_id: "w", rows: [], warnings: [], startedAt: "", completedAt: "", worker: { id: "2j-test", version: "x" } }, { ...settings, workerToken: "secret" });
    expect(out?.run_status).toBe("done");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["X-Worker-Token"]).toBe("secret");
  });
  it("maps 409 to LEASE_LOST and network errors to UNREACHABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "lease expired", cancel: true }), { status: 409 })));
    await expect(sendHeartbeat({ lease_token: "t", run_id: "r" }, { completed: 0, total: 1 }, settings)).rejects.toMatchObject({ code: "LEASE_LOST", status: 409 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const error = await claimJob(settings).catch((reason) => reason);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: "UNREACHABLE", status: 0 });
  });
});
