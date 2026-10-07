import type { DirectRankRow } from "./rank";
import type { GroupsResponse, ResultBody } from "./backend";

export type CurrentRun = {
  runId: string;
  jobId: string;
  watchlistId: string;
  leaseToken: string;
  startedAt: string;
  keywordsTotal: number;
  pairsTotal: number;
  completed: number;
  /** zip = setting Delivery location, crawl = reading Amazon, submit = sending results */
  phase: "zip" | "crawl" | "submit";
  /** keyword -> fraction done (pages read / expected) for keywords in progress */
  inflight: Record<string, number>;
  keyword?: string;
  pageNumber?: number;
  message: string;
  /** CAPTCHA backoff in progress (ms epoch) */
  pausedUntil?: number;
  lastHeartbeatAt?: string;
};

export type LastResult = {
  runId: string;
  watchlistId: string;
  ok: boolean;
  finishedAt: string;
  rows: number;
  ranked: number;
  notFound: number;
  unverified: number;
  backendStatus?: string;
  error?: string;
  durationMs?: number;
  warnings?: string[];
};

export type WorkerLogEntry = { at: string; level: "info" | "warn" | "error"; message: string; /** error superseded by a later successful contact */ resolved?: boolean };

export type WorkerState = {
  /** undefined = no poll has completed yet (fresh install): not shown as offline. */
  connected?: boolean;
  lastPollAt?: string;
  lastContactAt?: string;
  lastError?: string;
  /** Pause claiming until this time (ms epoch), e.g. after repeated CAPTCHA. */
  cooldownUntil?: number;
  currentRun: CurrentRun | null;
  lastResult: LastResult | null;
  log: WorkerLogEntry[];
};

export type PendingSubmission = { kind: "result" | "fail"; body: ResultBody & { error?: string }; savedAt: string; attempts: number };
export type NavTiming = { atMs: number; slot: number; kind: string; gapMs: number; waitMs: number; loadMs: number | null };
export type LastRunRows = { runId: string; watchlistId: string; completedAt: string; rows: DirectRankRow[]; warnings: string[]; notes?: string[]; navigations?: NavTiming[] };
export type GroupsCache = GroupsResponse & { syncedAt: string };

/** Write only when something the UI shows actually changed (idle polls must not touch storage). */
export function stateFingerprint(state: WorkerState): string {
  return JSON.stringify([state.connected ?? null, state.lastError ?? "", state.cooldownUntil ?? 0, state.currentRun, state.lastResult?.runId ?? "", state.log[0]?.at ?? ""]);
}

export const STORAGE = { state: "workerState", groups: "backendGroups", lastRows: "lastRunRows", pending: "pendingSubmissions" } as const;

const EMPTY: WorkerState = { currentRun: null, lastResult: null, log: [] };
const LOG_LIMIT = 40;

export async function getWorkerState(): Promise<WorkerState> {
  const stored = (await chrome.storage.local.get(STORAGE.state))[STORAGE.state] as Partial<WorkerState> | undefined;
  return { ...EMPTY, ...(stored ?? {}), log: Array.isArray(stored?.log) ? stored.log : [] };
}

// Serialize read-modify-write so concurrent updates from the crawl loop and heartbeat do not clobber each other.
let queue: Promise<unknown> = Promise.resolve();
export function updateWorkerState(mutate: (state: WorkerState) => void | WorkerState): Promise<WorkerState> {
  const next = queue.then(async () => {
    const state = await getWorkerState();
    const result = mutate(state) ?? state;
    await chrome.storage.local.set({ [STORAGE.state]: result });
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

export function pushLog(state: WorkerState, level: WorkerLogEntry["level"], message: string) {
  state.log = [{ at: new Date().toISOString(), level, message: message.slice(0, 400) }, ...state.log].slice(0, LOG_LIMIT);
}

export function logEvent(level: WorkerLogEntry["level"], message: string) {
  return updateWorkerState((state) => pushLog(state, level, message));
}

export function summarizeRows(rows: DirectRankRow[]) {
  let ranked = 0, notFound = 0, unverified = 0;
  for (const row of rows) {
    if (row.status === "ranked") ranked += 1;
    else if (row.status.startsWith("not_found")) notFound += 1;
    else unverified += 1;
  }
  return { rows: rows.length, ranked, notFound, unverified };
}

export async function getPending(): Promise<PendingSubmission[]> {
  const value = (await chrome.storage.local.get(STORAGE.pending))[STORAGE.pending];
  return Array.isArray(value) ? value as PendingSubmission[] : [];
}

export async function setPending(items: PendingSubmission[]) {
  await chrome.storage.local.set({ [STORAGE.pending]: items.slice(-10) });
}

/**
 * After a successful backend contact, older connection-error lines (unreachable / auth / HTTP) stay in
 * the log for history but are marked resolved, so the dashboard never shows them as the current state.
 * Run errors (CAPTCHA, ZIP, …) are left alone. Returns true when something changed.
 */
const CONNECTION_ERROR = /^(Không kết nối được backend|Backend từ chối worker|Backend lỗi)/;
export function markConnectionErrorsResolved(state: WorkerState): boolean {
  let changed = false;
  for (const entry of state.log) if (entry.level === "error" && !entry.resolved && CONNECTION_ERROR.test(entry.message)) { entry.resolved = true; changed = true; }
  if (changed) pushLog(state, "info", "Đã kết nối lại backend.");
  return changed;
}
