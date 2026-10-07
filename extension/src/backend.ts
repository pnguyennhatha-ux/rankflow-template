import type { DirectRankRow } from "./rank";
import { getSettings, type ExtensionSettings } from "./settings";
import type { Throttle } from "./throttle";
import { runNowGroupParam } from "./groups";

export const WORKER_VERSION = "2j/0.3.5";

/** Payload of GET /job (rankflow-v2 backend, api "2j-worker/1"). */
export type WorkerJob = {
  job_id: string;
  lease_token: string;
  run_id: string;
  watchlist_id: string;
  groups: Array<{ id: string; name: string; asins: string[]; keywords: string[]; owner?: { id: string; name?: string | null } | null }>;
  keywords_total: number;
  pairs_total: number;
  postalCode: string;
  setPostalCode: boolean;
  includeSponsored: boolean;
  concurrency: number;
  maxOrganic: number;
  lease_seconds: number;
  heartbeat_seconds: number;
  throttle?: Partial<Throttle>;
  scope?: string;
};

export type BackendOwner = { id: string; name?: string | null };
/** owners: distinct owners of the group's enabled pairs; asins[].owners: {keyword: owner} (only pairs that have one). */
export type BackendGroup = { watchlist_id: string; group: string; pairs: number; owners?: BackendOwner[]; asins: Array<{ asin: string; keywords: string[]; owners?: Record<string, BackendOwner> }> };
export type BackendWatchlist = { watchlist_id: string; name?: string | null; zip?: string | null; top_n?: number | null; sponsored?: boolean | number | null } | null;
export type GroupsResponse = { groups: BackendGroup[]; watchlists: Record<string, BackendWatchlist>; server_time: string; version?: string };
export type WorkerStatusResponse = {
  ok: boolean; server_time: string; live_enabled: boolean; queued_runs: number; pairs_enabled: number; outbox: number;
  active_leases: Array<{ run_id: string; worker_id: string; claimed_at: string; heartbeat_at: string; progress: string }>;
  last_run: { id: string; watchlist_id: string; status: string; finished_at: string; error?: string | null; counts: Record<string, number> } | null;
  workers_seen?: Record<string, string>;
  groups_version?: string;
};
export type CompleteResponse = { ok: boolean; run_id: string; run_status: string; done: number; requeued: number; failed: number };

export class BackendError extends Error {
  constructor(message: string, readonly status: number, readonly code: "UNREACHABLE" | "AUTH" | "LEASE_LOST" | "HTTP" = "HTTP") {
    super(message);
    this.name = "BackendError";
  }
}

export async function backendFetch<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}, settings?: ExtensionSettings): Promise<{ status: number; data: T | null; headers?: Headers }> {
  const s = settings ?? await getSettings();
  const headers: Record<string, string> = { "X-Worker-Id": s.workerId, "X-Worker-Version": WORKER_VERSION, Accept: "application/json" };
  if (s.workerToken) headers["X-Worker-Token"] = s.workerToken;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await fetch(`${s.backendUrl}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal, cache: "no-store" });
  } catch (error) {
    throw new BackendError(`Không kết nối được backend ${s.backendUrl} (${error instanceof Error ? error.message : String(error)}). Hãy chạy: python3 backend/rankflow.py serve`, 0, "UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 204) return { status: 204, data: null, headers: response.headers };
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (response.ok) return { status: response.status, data: data as T, headers: response.headers };
  const message = (data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "") || `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) throw new BackendError(`Backend từ chối worker (${message}). Kiểm tra Worker token.`, response.status, "AUTH");
  if (response.status === 409) throw new BackendError(`Lease không còn hiệu lực (${message}).`, 409, "LEASE_LOST");
  throw new BackendError(`Backend lỗi: ${message}`, response.status);
}

export async function health(settings?: ExtensionSettings) {
  return (await backendFetch<{ ok: boolean; service: string; api: string }>("/health", { timeoutMs: 5_000 }, settings)).data;
}

/** Long-poll for a job. The server holds the request up to `waitSeconds` (<=25) and answers as soon as a run is queued. */
export async function claimJob(settings?: ExtensionSettings, waitSeconds = 0): Promise<{ job: WorkerJob | null; groupsVersion: string | null }> {
  const wait = Math.max(0, Math.min(25, Math.round(waitSeconds)));
  const response = await backendFetch<WorkerJob>(wait ? `/job?wait=${wait}` : "/job", { timeoutMs: (wait + 8) * 1_000 }, settings);
  return { job: response.data, groupsVersion: response.headers?.get("X-Groups-Version") ?? null };
}

export async function fetchGroups(settings?: ExtensionSettings): Promise<GroupsResponse> {
  const { data } = await backendFetch<GroupsResponse>("/worker/groups", {}, settings);
  return data ?? { groups: [], watchlists: {}, server_time: new Date().toISOString() };
}

export async function fetchWorkerStatus(settings?: ExtensionSettings): Promise<WorkerStatusResponse | null> {
  return (await backendFetch<WorkerStatusResponse>("/worker/status", { timeoutMs: 8_000 }, settings)).data;
}

export type RunProgress = { completed: number; total: number; keyword?: string; pageNumber?: number; message?: string };

export async function sendHeartbeat(job: Pick<WorkerJob, "lease_token" | "run_id">, progress: RunProgress, settings?: ExtensionSettings) {
  return (await backendFetch<{ ok: boolean; lease_until: string }>("/job/heartbeat", { body: { lease_token: job.lease_token, run_id: job.run_id, progress }, timeoutMs: 10_000 }, settings)).data;
}

export type ResultBody = { lease_token: string; run_id: string; job_id: string; watchlist_id: string; rows: DirectRankRow[]; warnings: string[]; startedAt: string; completedAt: string; worker: { id: string; version: string }; meta?: Record<string, unknown> };

export async function postResult(body: ResultBody, settings?: ExtensionSettings) {
  return (await backendFetch<CompleteResponse>("/result", { body, timeoutMs: 60_000 }, settings)).data;
}

export async function postFail(body: ResultBody & { error: string }, settings?: ExtensionSettings) {
  return (await backendFetch<CompleteResponse>("/job/fail", { body, timeoutMs: 60_000 }, settings)).data;
}

/** group undefined = all groups; "" or NO_GROUP = only ungrouped pairs; else that group (see groups.ts). */
export async function requestRunNow(group?: string | null, watchlistId?: string, settings?: ExtensionSettings) {
  return (await backendFetch<{ runs: Array<{ watchlist_id: string; group?: string | null; run_id: string; existing: boolean; pairs?: number }> }>("/worker/run-now", { body: { group: runNowGroupParam(group), watchlist_id: watchlistId || undefined } }, settings)).data;
}
