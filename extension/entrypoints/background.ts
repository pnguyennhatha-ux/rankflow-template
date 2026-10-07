import { defineBackground } from "wxt/utils/define-background";
import { buildDirectQueryPlans, buildDirectRows, buildUnverifiedRows, scanPagePlan, type DirectCheckRequest, type DirectQueryTarget, type DirectRankRow } from "../src/rank";
import { BackendError, WORKER_VERSION, claimJob, fetchGroups, postFail, postResult, requestRunNow, sendHeartbeat, type ResultBody, type WorkerJob } from "../src/backend";
import { heartbeatInterval, jobToRequest } from "../src/job";
import { getSettings, type ExtensionSettings } from "../src/settings";
import { accumulatePage, newRankState, scanSerpPage, serpSignature, type SerpLayout, type SerpScan } from "../src/serp";
import { TabPool, createCrawlWindowTabs, runSlots, type TabApi } from "../src/scheduler";
import { badgeFor, runPercent } from "../src/status";
import { DEFAULT_THROTTLE, NavGate, captchaBackoff, type NavKind, type Throttle } from "../src/throttle";
import { STORAGE, getPending, getWorkerState, pushLog, setPending, stateFingerprint, summarizeRows, type CurrentRun, type GroupsCache, type LastRunRows, type NavTiming, type PendingSubmission, type WorkerState, markConnectionErrorsResolved } from "../src/worker-state";
import { groupLabel } from "../src/groups";

/*
 * 2J v0.3 — backend worker only. No manual/direct crawling: Amazon tabs are opened only while a job
 * leased from the RankFlow backend is running.
 *
 * Idle strategy: a chrome.alarms wake-up every 30 s performs ONE long-poll `GET /job?wait=20` against the
 * local backend. The server answers immediately when a run is queued (run-now from block UI/CLI/API or
 * schedule), otherwise after 20 s with 204. No busy loop, no Amazon traffic, and idle polls do not write
 * to chrome.storage unless something visible changed.
 */

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------
type StopKind = "cancelled" | "captcha" | "lease_lost" | "zip";

type KeywordTiming = { keyword: string; slot: number; startMs: number; endMs: number; pages: number; attempts: number; outcome: string; settleMs?: number };
type PageLayout = SerpLayout & { page: number; settleMs: number };

type RunControl = {
  stopped: StopKind | null;
  stopReason: string;
  pauseUntil: number;
  consecutiveBlocks: number;
  totalBlocks: number;
  retried: number;
  completed: number;
  total: number;
  throttle: Throttle;
  gate: NavGate;
  t0: number;
  timings: KeywordTiming[];
  diagnostics: Record<string, Record<string, string>>;
  layout: Record<string, PageLayout[]>;
  tabs: TabPool;
  progress: (patch: ProgressPatch, flush?: boolean) => void;
  onKeywordDone: (rows: DirectRankRow[]) => void;
};

class RunStopped extends Error {
  constructor(readonly kind: StopKind, message: string) { super(message); this.name = "RunStopped"; }
}
class AmazonBlocked extends Error {}

const CAPTCHA_ABORT_AFTER = 3;
const RUN_COOLDOWN_AFTER_CAPTCHA_MS = 15 * 60_000;

function stopRun(ctl: RunControl, kind: StopKind, reason: string) {
  if (!ctl.stopped) { ctl.stopped = kind; ctl.stopReason = reason; }
}
function throwIfStopped(ctl: RunControl) {
  if (ctl.stopped) throw new RunStopped(ctl.stopped, ctl.stopReason);
}
function keepAlive() {
  return chrome.runtime.getPlatformInfo().catch(() => undefined);
}
async function pause(ms: number, ctl?: RunControl) {
  const until = Date.now() + Math.max(0, ms);
  let lastTouch = Date.now();
  while (Date.now() < until) {
    if (ctl) throwIfStopped(ctl);
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    if (Date.now() - lastTouch > 15_000) { lastTouch = Date.now(); await keepAlive(); }
  }
  if (ctl) throwIfStopped(ctl);
}
async function waitForGlobalPause(ctl: RunControl) {
  while (Date.now() < ctl.pauseUntil) {
    ctl.progress({ pausedUntil: ctl.pauseUntil, message: `Amazon CAPTCHA · nghỉ ${Math.ceil((ctl.pauseUntil - Date.now()) / 1_000)}s` });
    await pause(Math.min(5_000, ctl.pauseUntil - Date.now()), ctl);
  }
}
/** Every Amazon navigation goes through the shared gate (random gap between ANY two navigations, all slots). */
async function navigate(ctl: RunControl, kind: NavKind, slot: number) {
  await waitForGlobalPause(ctl);
  const wait = ctl.gate.reserve(kind, slot);
  if (wait > 0) await pause(wait, ctl);
  // a CAPTCHA seen by the other slot while we were waiting pauses this one too
  await waitForGlobalPause(ctl);
}

const RUN_TABS_KEY = "runTabs";
const crawlWindow = createCrawlWindowTabs(chrome);
const chromeTabs: TabApi = crawlWindow.api;

// ---------------------------------------------------------------------------
// Amazon helpers
// ---------------------------------------------------------------------------
function waitForTab(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const onUpdated = (updatedId: number, change: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && change.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (removedId: number) => {
      if (removedId === tabId) {
        cleanup();
        reject(new Error("Tab Amazon đã bị đóng trước khi tải xong."));
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Amazon tải quá 30 giây. Hãy kiểm tra mạng rồi thử lại."));
    }, timeoutMs);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve();
      }
    }).catch(() => undefined);
  });
}

async function waitForAmazonPage(tabId: number): Promise<void> {
  await waitForTab(tabId);
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function waitForAmazonSearchReady(tabId: number, keyword: string, pageNumber: number, ctl: RunControl, navStartedAt: number, timeoutMs = 25_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    throwIfStopped(ctl);
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [keyword, pageNumber, navStartedAt - 1_000],
        func: (expectedKeyword: string, expectedPage: number, notBefore: number) => {
          // the reused tab still shows the previous page until the new document commits
          if (performance.timeOrigin < notBefore) return false;
          const url = new URL(location.href);
          const correctPage = url.hostname.endsWith("amazon.com") && url.pathname === "/s" && url.searchParams.get("k") === expectedKeyword && Number(url.searchParams.get("page") ?? "1") === expectedPage;
          if (!correctPage) return false;
          const bodyText = document.body?.innerText ?? "";
          return Boolean(document.querySelector("[data-component-type='s-search-result'][data-asin], #captchacharacters, form[action*='validateCaptcha']")) || /no results for|did not match any products|enter the characters you see below|sorry, we just need to make sure you're not a robot/i.test(bodyText);
        }
      });
      if (execution?.result) return;
    } catch { /* navigation may temporarily reject script injection */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Amazon chưa render kết quả page ${pageNumber} sau ${Math.round(timeoutMs / 1_000)} giây.`);
}

/** A reused tab keeps reporting the previous document until the new navigation commits. */
async function waitForCommit(tabId: number, navStartedAt: number, ctl: RunControl, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    throwIfStopped(ctl);
    const [execution] = await chrome.scripting.executeScript({ target: { tabId }, args: [navStartedAt - 1_000], func: (notBefore: number) => performance.timeOrigin >= notBefore }).catch(() => [undefined]);
    if (execution?.result === true) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Wait until Amazon stops injecting result/ad tiles (same grid signature twice, no pending ad slot). */
async function waitForSerpSettle(tabId: number, ctl: RunControl, minMs = 1_200, maxMs = 4_000): Promise<number> {
  const started = Date.now();
  let previous = "";
  let stable = 0;
  while (Date.now() - started < maxMs) {
    throwIfStopped(ctl);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: serpSignature }).catch(() => [undefined]);
    const signature = String(execution?.result ?? "");
    const pending = Number(signature.split(":")[2] ?? 0);
    stable = signature && signature === previous && pending === 0 ? stable + 1 : 0;
    previous = signature;
    if (stable >= 1 && Date.now() - started >= minMs) break;
  }
  return Date.now() - started;
}

/** ZIP is a session setting: set it once per run in slot 0's tab; both slots then share it. */
async function setAmazonPostalCode(postalCode: string, ctl: RunControl): Promise<string> {
  const navStartedAt = Date.now();
  const tabId = await ctl.tabs.open(0, "https://www.amazon.com/");
  const tab = { id: tabId };
  {
    await waitForCommit(tab.id, navStartedAt, ctl);
    await waitForAmazonPage(tab.id);
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [postalCode],
      func: async (zip: string) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async <T extends Element>(selector: string, timeout = 8_000): Promise<T | null> => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            const element = document.querySelector<T>(selector);
            if (element) return element;
            await sleep(150);
          }
          return null;
        };
        const bodyText = document.body?.innerText ?? "";
        if (document.querySelector("#captchacharacters") || /enter the characters you see below/i.test(bodyText)) return { ok: false, message: "Amazon yêu cầu CAPTCHA." };
        document.querySelector<HTMLElement>("#nav-global-location-popover-link, #glow-ingress-block")?.click();
        const input = await waitFor<HTMLInputElement>("#GLUXZipUpdateInput, input[data-action='GLUXPostalInputAction']");
        if (!input) return { ok: false, message: "Không mở được hộp thoại Delivery location của Amazon." };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, zip); else input.value = zip;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const submit = document.querySelector<HTMLElement>("#GLUXZipUpdate, [data-action='GLUXPostalUpdateAction']");
        if (!submit) return { ok: false, message: "Không tìm thấy nút Apply ZIP code." };
        submit.click();
        await sleep(2_000);
        document.querySelector<HTMLElement>(".a-popover-footer #GLUXConfirmClose, #GLUXConfirmClose")?.click();
        await sleep(500);
        const location = document.querySelector<HTMLElement>("#glow-ingress-line2")?.innerText.trim() ?? "";
        return location.includes(zip) ? { ok: true, message: location } : { ok: false, message: `Amazon chưa xác nhận ZIP ${zip}. Location hiện tại: ${location || "không đọc được"}.` };
      }
    });
    const result = execution?.result as { ok: boolean; message: string } | undefined;
    if (!result?.ok) throw new Error(result?.message ?? "Không đặt được ZIP code trên Amazon.");
    return result.message;
  }
}


async function scanPage(tabId: number): Promise<SerpScan> {
  const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: scanSerpPage });
  if (!execution?.result) throw new Error("Không đọc được nội dung tab Amazon.");
  return execution.result as SerpScan;
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------
function withTargets(baseRows: DirectRankRow[], queryTargets: DirectQueryTarget[]): DirectRankRow[] {
  const byAsin = new Map(baseRows.map((row) => [row.asin, row]));
  return queryTargets.flatMap((target) => {
    const row = byAsin.get(target.asin);
    return row ? [{ ...row, groupId: target.groupId, groupName: target.groupName, ownerId: target.ownerId ?? null, ownerName: target.ownerName ?? null }] : [];
  });
}

async function scanKeyword(keyword: string, queryTargets: DirectQueryTarget[], request: DirectCheckRequest, snapshotDay: string, ctl: RunControl, timing: KeywordTiming, slot: number): Promise<DirectRankRow[]> {
  const asins = [...new Set(queryTargets.map((target) => target.asin))];
  const targets = new Set(asins);
  const state = newRankState();
  let verifiedTerminal = false;
  let terminalRows: DirectRankRow[] | null = null;
  const searchUrl = (pageNumber: number) => `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${pageNumber}`;
  const { maxPages, expectedPages } = scanPagePlan(request.maxOrganic);
  ctl.layout[keyword] = [];
  {
    for (let pageNumber = 1; pageNumber <= maxPages && state.organicScanned < request.maxOrganic; pageNumber += 1) {
      throwIfStopped(ctl);
      await navigate(ctl, pageNumber === 1 ? "keyword" : "page", slot);
      if (pageNumber === 1 && !timing.startMs) timing.startMs = Date.now() - ctl.t0;
      ctl.progress({ keyword, pageNumber, message: `"${keyword}" · page ${pageNumber} · ${state.organicScanned}/${request.maxOrganic} organic`, inflightKey: keyword, inflightValue: Math.max(0.05, (pageNumber - 1) / expectedPages) });
      const navStartedAt = Date.now();
      const tabId = await ctl.tabs.open(slot, searchUrl(pageNumber));
      let scan: Awaited<ReturnType<typeof scanPage>>;
      let settleMs = 0;
      try {
        await waitForAmazonSearchReady(tabId, keyword, pageNumber, ctl, navStartedAt);
        settleMs = await waitForSerpSettle(tabId, ctl);
        scan = await scanPage(tabId);
      } finally {
        ctl.gate.settle(slot);
      }
      timing.settleMs = (timing.settleMs ?? 0) + settleMs;
      if (scan.kind === "blocked") throw new AmazonBlocked(scan.message);
      ctl.consecutiveBlocks = 0;
      timing.pages = pageNumber;
      if (scan.kind === "parser_error") {
        terminalRows = buildUnverifiedRows(keyword, asins, "unverified_parser_error", scan.message, snapshotDay, request.maxOrganic);
        break;
      }
      const { map, ...counts } = scan.layout;
      ctl.layout[keyword]!.push({ page: pageNumber, settleMs, ...counts, ...(pageNumber === 1 && map ? { map } : {}) });
      accumulatePage(state, scan.items, pageNumber, targets, { maxOrganic: request.maxOrganic, includeSponsored: request.includeSponsored });
      const foundAllOrganic = asins.every((asin) => state.matches.some((match) => match.asin === asin && !match.sponsored));
      if (foundAllOrganic || !scan.hasNext) { verifiedTerminal = true; break; }
    }
  }
  if (Object.keys(state.traces).length) ctl.diagnostics[keyword] = state.traces;
  if (!terminalRows && state.organicScanned < request.maxOrganic && !verifiedTerminal) terminalRows = buildUnverifiedRows(keyword, asins, "unverified_parser_error", `Đã tới giới hạn ${maxPages} trang nhưng mới xác minh ${state.organicScanned}/${request.maxOrganic} organic.`, snapshotDay, request.maxOrganic);
  return withTargets(terminalRows ?? buildDirectRows(keyword, asins, state.matches, snapshotDay, request.maxOrganic), queryTargets);
}

async function crawlKeyword(keyword: string, queryTargets: DirectQueryTarget[], request: DirectCheckRequest, snapshotDay: string, ctl: RunControl, slot: number): Promise<DirectRankRow[]> {
  const asins = [...new Set(queryTargets.map((target) => target.asin))];
  const timing: KeywordTiming = { keyword, slot, startMs: 0, endMs: 0, pages: 0, attempts: 0, outcome: "" };
  ctl.timings.push(timing);
  const finish = (rows: DirectRankRow[], outcome: string) => { timing.endMs = Date.now() - ctl.t0; timing.outcome = outcome; return rows; };
  for (let attempt = 1; ; attempt += 1) {
    timing.attempts = attempt;
    try {
      const rows = await scanKeyword(keyword, queryTargets, request, snapshotDay, ctl, timing, slot);
      return finish(rows, rows.every((row) => row.status === "ranked") ? "ranked" : rows[0]?.status ?? "ok");
    } catch (error) {
      if (error instanceof RunStopped || ctl.stopped) { finish([], "stopped"); throw error instanceof RunStopped ? error : new RunStopped(ctl.stopped!, ctl.stopReason); }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AmazonBlocked) {
        ctl.consecutiveBlocks += 1;
        ctl.totalBlocks += 1;
        if (ctl.consecutiveBlocks >= CAPTCHA_ABORT_AFTER) {
          stopRun(ctl, "captcha", `Amazon CAPTCHA ${ctl.consecutiveBlocks} lần liên tiếp — dừng lượt, backend sẽ chạy lại sau (blocked).`);
          finish([], "captcha");
          throw new RunStopped("captcha", ctl.stopReason);
        }
        const wait = captchaBackoff(ctl.throttle.captchaBackoffMs, ctl.consecutiveBlocks);
        ctl.pauseUntil = Math.max(ctl.pauseUntil, Date.now() + wait);
        ctl.gate.delayUntil(ctl.pauseUntil);
        void logEvent("warn", `CAPTCHA tại "${keyword}" (lần ${ctl.consecutiveBlocks}) — nghỉ ${Math.round(wait / 1_000)}s.`);
        if (attempt >= 2) return finish(withTargets(buildUnverifiedRows(keyword, asins, "unverified_blocked", message, snapshotDay, request.maxOrganic), queryTargets), "unverified_blocked");
        ctl.retried += 1;
        continue;
      }
      if (attempt >= 2) return finish(withTargets(buildUnverifiedRows(keyword, asins, "unverified_parser_error", message, snapshotDay, request.maxOrganic), queryTargets), "unverified_parser_error");
      ctl.retried += 1;
      void logEvent("warn", `"${keyword}": ${message} — thử lại.`);
    }
  }
}

type CrawlResult = { rows: DirectRankRow[]; warnings: string[]; notes: string[]; startedAt: string; completedAt: string; meta: Record<string, unknown> };

/** One-line timing summary: gaps between navigations (all slots), load times, tabs used. */
function navSummary(ctl: RunControl, keywords: number, concurrency: number): string {
  const range = (values: number[]) => values.length ? `${(Math.min(...values) / 1_000).toFixed(1)}–${(Math.max(...values) / 1_000).toFixed(1)}s` : "—";
  const gaps = ctl.gate.log.slice(1).map((entry) => entry.gapMs);
  const loads = ctl.gate.log.map((entry) => entry.loadMs).filter((value): value is number => typeof value === "number");
  return `${keywords} keyword · ${concurrency} slot/${ctl.tabs.created} tab · ${ctl.gate.log.length} lần tải trang · cách nhau ${range(gaps)} · tải ${range(loads)} · ${Math.round((Date.now() - ctl.t0) / 1_000)}s`;
}

function crawlMeta(ctl: RunControl, request: DirectCheckRequest, concurrency: number, zipMs: number | null) {
  return {
    worker: WORKER_VERSION,
    concurrency,
    throttle: ctl.throttle,
    timing: {
      totalMs: Date.now() - ctl.t0,
      zipMs,
      keywords: ctl.timings,
      navigations: ctl.gate.log.map((entry) => ({ atMs: entry.at - ctl.t0, slot: entry.slot, kind: entry.kind, gapMs: entry.gapMs, waitMs: entry.waitMs, loadMs: entry.loadMs ?? null })),
      tabs: { created: ctl.tabs.created, reused: ctl.tabs.reused }
    },
    layout: ctl.layout,
    diagnostics: ctl.diagnostics,
    maxOrganic: request.maxOrganic
  };
}

async function crawl(request: DirectCheckRequest, ctl: RunControl): Promise<CrawlResult> {
  try {
    return await crawlInner(request, ctl);
  } finally {
    await ctl.tabs.closeAll();
    crawlWindow.reset();
  }
}

async function crawlInner(request: DirectCheckRequest, ctl: RunControl): Promise<CrawlResult> {
  const plans = buildDirectQueryPlans(request.groups);
  if (!plans.length) throw new Error("Không có ASIN/keyword hợp lệ để chạy.");
  ctl.total = plans.length;
  const startedAt = new Date(ctl.t0).toISOString();
  const snapshotDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(ctl.t0));
  const notes: string[] = [];
  let zipMs: number | null = null;
  if (request.setPostalCode) {
    ctl.progress({ phase: "zip", message: `Đặt Delivery location ZIP ${request.postalCode}…` }, true);
    const zipStart = Date.now();
    let zipError = "";
    for (let attempt = 1; attempt <= 2 && !ctl.stopped; attempt += 1) {
      try {
        await navigate(ctl, "keyword", 0);
        const location = (await setAmazonPostalCode(request.postalCode, ctl).finally(() => ctl.gate.settle(0))).replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
        notes.push(`Delivery location: ${location}`);
        zipError = "";
        break;
      } catch (error) {
        if (error instanceof RunStopped) throw error;
        zipError = error instanceof Error ? error.message : String(error);
        if (/captcha/i.test(zipError)) break;
      }
    }
    zipMs = Date.now() - zipStart;
    if (zipError) {
      stopRun(ctl, /captcha/i.test(zipError) ? "captcha" : "zip", `Không đặt được ZIP ${request.postalCode}: ${zipError}`);
      throw new RunStopped(ctl.stopped!, ctl.stopReason);
    }
  }
  ctl.progress({ phase: "crawl", message: `Bắt đầu ${plans.length} keyword…` }, true);
  const concurrency = Math.min(Math.max(1, request.concurrency), plans.length);
  let rowsByKeyword: Array<DirectRankRow[] | undefined>;
  try {
    rowsByKeyword = await runSlots(plans, concurrency, async (plan, slot) => {
      const rows = await crawlKeyword(plan.keyword, plan.targets, request, snapshotDay, ctl, slot);
      ctl.completed += 1;
      ctl.onKeywordDone(rows);
      ctl.progress({ completed: ctl.completed, inflightKey: plan.keyword, inflightValue: -1, message: `Xong ${ctl.completed}/${ctl.total} keyword · "${plan.keyword}"` }, true);
      return rows;
    }, () => Boolean(ctl.stopped));
  } catch (error) {
    if (!ctl.stopped) stopRun(ctl, "cancelled", error instanceof Error ? error.message : String(error));
    throw error instanceof RunStopped ? error : new RunStopped(ctl.stopped!, ctl.stopReason);
  }
  throwIfStopped(ctl);
  const rows = rowsByKeyword.flatMap((items) => items ?? []);
  // warnings = things that need attention; informational lines go to notes (shown in the UI, stored in meta)
  const warnings: string[] = [];
  if (ctl.totalBlocks) warnings.push(`Amazon CAPTCHA ${ctl.totalBlocks} lần trong lượt này.`);
  if (ctl.retried) warnings.push(`${ctl.retried} lần thử lại keyword (lỗi tải trang/CAPTCHA).`);
  const unverified = rows.filter((row) => row.status.startsWith("unverified_")).length;
  if (unverified) warnings.push(`${unverified} cặp ASIN/keyword chưa xác minh được (unverified).`);
  notes.push(navSummary(ctl, plans.length, concurrency));
  return { rows, warnings, notes, startedAt, completedAt: new Date().toISOString(), meta: { ...crawlMeta(ctl, request, concurrency, zipMs), notes } };
}

// ---------------------------------------------------------------------------
// Worker state (writes only on visible change)
// ---------------------------------------------------------------------------
const ALARM = "2j-wake";
const LONG_POLL_SECONDS = 20; // < 30 s: Chrome aborts extension fetches that wait longer
const PARTIAL_KEY = "runPartialRows";
const PENDING_MAX_AGE_MS = 24 * 3_600_000;
const CONTACT_WRITE_MS = 5 * 60_000;

let activeCtl: RunControl | null = null;
let pollInFlight: Promise<void> | null = null;
let bootChecked: Promise<void> | null = null;
let lastFingerprint = "";
let lastContactWrite = 0;
let stateQueue: Promise<unknown> = Promise.resolve();

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Serialized read-modify-write; skips the storage write when nothing visible changed. */
function mutateState(mutate: (state: WorkerState) => void, options: { force?: boolean } = {}): Promise<WorkerState> {
  const next = stateQueue.then(async () => {
    const state = await getWorkerState();
    mutate(state);
    const fingerprint = stateFingerprint(state);
    const contactDue = Date.now() - lastContactWrite > CONTACT_WRITE_MS;
    if (options.force || fingerprint !== lastFingerprint || contactDue) {
      lastFingerprint = fingerprint;
      if (contactDue) lastContactWrite = Date.now();
      await chrome.storage.local.set({ [STORAGE.state]: state });
      updateBadge(state);
    }
    return state;
  });
  stateQueue = next.catch(() => undefined);
  return next;
}

function logEvent(level: "info" | "warn" | "error", message: string) {
  return mutateState((state) => pushLog(state, level, message));
}

let lastBadge = "";
function updateBadge(state: WorkerState) {
  void getSettings().then((settings) => {
    const { text, color } = badgeFor(state, { enabled: settings.workerEnabled });
    if (text + color === lastBadge) return;
    lastBadge = text + color;
    void chrome.action?.setBadgeText?.({ text }).catch(() => undefined);
    void chrome.action?.setBadgeBackgroundColor?.({ color }).catch(() => undefined);
  }).catch(() => undefined);
}

async function notify(title: string, message: string) {
  await chrome.notifications?.create({ type: "basic", iconUrl: chrome.runtime.getURL("/icon-128.png"), title, message: message.slice(0, 250) }).catch(() => undefined);
}

async function syncGroups(settings: ExtensionSettings, version: string | null, force = false) {
  const cached = (await chrome.storage.local.get(STORAGE.groups))[STORAGE.groups] as GroupsCache | undefined;
  if (!force && cached && version && cached.version === version) return;
  const groups = await fetchGroups(settings);
  const cache: GroupsCache = { ...groups, version: groups.version ?? version ?? undefined, syncedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE.groups]: cache });
}

// ---------------------------------------------------------------------------
// Submission with retry + offline queue
// ---------------------------------------------------------------------------
async function submit(kind: "result" | "fail", body: ResultBody & { error?: string }, settings: ExtensionSettings) {
  let lastError: unknown = null;
  for (const delay of [0, 2_000, 6_000]) {
    if (delay) await pause(delay);
    try {
      return kind === "result" ? await postResult(body, settings) : await postFail({ ...body, error: body.error ?? "worker failure" }, settings);
    } catch (error) {
      lastError = error;
      if (error instanceof BackendError && error.status !== 0 && error.status < 500) throw error;
    }
  }
  const pending = await getPending();
  pending.push({ kind, body, savedAt: new Date().toISOString(), attempts: 3 });
  await setPending(pending);
  await logEvent("warn", `Chưa gửi được ${kind === "result" ? "kết quả" : "báo lỗi"} run ${body.run_id} (${errorText(lastError)}). Đã lưu, sẽ gửi lại tự động.`);
  return null;
}

async function flushPending(settings: ExtensionSettings) {
  const pending = await getPending();
  if (!pending.length) return;
  let keep: PendingSubmission[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]!;
    if (Date.now() - Date.parse(item.savedAt) > PENDING_MAX_AGE_MS) { await logEvent("warn", `Bỏ kết quả chờ gửi quá 24h của run ${item.body.run_id}.`); continue; }
    try {
      const response = item.kind === "result" ? await postResult(item.body, settings) : await postFail({ ...item.body, error: item.body.error ?? "worker failure" }, settings);
      await logEvent("info", `Đã gửi lại ${item.kind} run ${item.body.run_id} → ${response?.run_status ?? "ok"}.`);
    } catch (error) {
      if (error instanceof BackendError && error.status !== 0 && error.status < 500) { await logEvent("warn", `Backend từ chối kết quả chờ gửi của run ${item.body.run_id}: ${error.message}`); continue; }
      keep = [{ ...item, attempts: item.attempts + 1 }, ...pending.slice(index + 1)];
      break;
    }
  }
  await setPending(keep);
}

function resultBody(job: WorkerJob, settings: ExtensionSettings, rows: DirectRankRow[], warnings: string[], startedAt: string, meta?: Record<string, unknown>): ResultBody {
  return { lease_token: job.lease_token, run_id: job.run_id, job_id: job.job_id, watchlist_id: job.watchlist_id, rows, warnings, startedAt, completedAt: new Date().toISOString(), worker: { id: settings.workerId, version: WORKER_VERSION }, meta };
}

// ---------------------------------------------------------------------------
// Execute one leased run
// ---------------------------------------------------------------------------
type ProgressPatch = Partial<CurrentRun> & { inflightKey?: string; inflightValue?: number };

async function executeJob(job: WorkerJob, settings: ExtensionSettings) {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  let request: DirectCheckRequest;
  try {
    request = jobToRequest(job);
  } catch (error) {
    await logEvent("error", `Job ${job.run_id ?? "?"} không hợp lệ: ${errorText(error)}`);
    if (job.lease_token) await submit("fail", { ...resultBody(job, settings, [], [], startedAt), error: `invalid job: ${errorText(error)}` }, settings).catch(() => undefined);
    return;
  }
  const collected: DirectRankRow[] = [];
  const run: CurrentRun = { runId: job.run_id, jobId: job.job_id, watchlistId: job.watchlist_id, leaseToken: job.lease_token, startedAt, keywordsTotal: job.keywords_total, pairsTotal: job.pairs_total, completed: 0, phase: request.setPostalCode ? "zip" : "crawl", inflight: {}, message: "Bắt đầu…" };

  // progress writer: at most one storage write per 500 ms, but the latest value is always flushed (trailing edge)
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWrite = 0;
  const writeProgress = () => {
    writeTimer = null;
    lastWrite = Date.now();
    void mutateState((state) => { if (state.currentRun?.runId === run.runId) state.currentRun = { ...run, inflight: { ...run.inflight } }; });
  };
  const ctl: RunControl = {
    stopped: null, stopReason: "", pauseUntil: 0, consecutiveBlocks: 0, totalBlocks: 0, retried: 0, completed: 0, total: job.keywords_total,
    throttle: request.throttle ?? DEFAULT_THROTTLE, gate: new NavGate(request.throttle ?? DEFAULT_THROTTLE), t0,
    timings: [], diagnostics: {}, layout: {},
    tabs: new TabPool(chromeTabs, (ids) => void chrome.storage.local.set({ [RUN_TABS_KEY]: ids })),
    progress: (patch: ProgressPatch, flush = false) => {
      const { inflightKey, inflightValue, ...rest } = patch;
      Object.assign(run, rest, { completed: ctl.completed });
      if (!("pausedUntil" in rest) && run.pausedUntil && run.pausedUntil <= Date.now()) run.pausedUntil = undefined;
      if (inflightKey !== undefined) {
        if (inflightValue === undefined || inflightValue < 0) delete run.inflight[inflightKey];
        else run.inflight[inflightKey] = inflightValue;
      }
      if (flush || Date.now() - lastWrite >= 500) { if (writeTimer) clearTimeout(writeTimer); writeProgress(); }
      else if (!writeTimer) writeTimer = setTimeout(writeProgress, 500 - (Date.now() - lastWrite));
    },
    onKeywordDone: (rows) => {
      collected.push(...rows);
      void chrome.storage.local.set({ [PARTIAL_KEY]: { runId: job.run_id, job, rows: collected, startedAt } });
    }
  };
  activeCtl = ctl;
  await mutateState((state) => {
    state.currentRun = { ...run };
    pushLog(state, "info", `Nhận run ${job.run_id}${job.scope && job.scope !== "*" ? ` (${job.scope})` : ""}: ${job.keywords_total} keyword × ${job.pairs_total} cặp, nhóm ${[...new Set(job.groups.map((group) => group.name))].join(", ")}.`);
  });

  const beat = async () => {
    try {
      await keepAlive();
      await sendHeartbeat(job, { completed: ctl.completed, total: ctl.total, keyword: run.keyword, pageNumber: run.pageNumber, message: run.message }, settings);
      run.lastHeartbeatAt = new Date().toISOString();
      ctl.progress({}, true);
    } catch (error) {
      if (error instanceof BackendError && error.code === "LEASE_LOST") stopRun(ctl, "lease_lost", "Backend đã thu hồi lease (hết hạn hoặc bị huỷ).");
      else await mutateState((state) => { state.lastError = `Heartbeat lỗi: ${errorText(error)}`; });
    }
  };
  const heartbeatTimer = setInterval(() => void beat(), heartbeatInterval(job));
  const keepAliveTimer = setInterval(() => void keepAlive(), 20_000);

  try {
    const result = await crawl(request, ctl);
    ctl.progress({ phase: "submit", message: "Đang gửi kết quả về backend…", inflight: {} }, true);
    const body = resultBody(job, settings, result.rows, result.warnings, startedAt, result.meta);
    let backendStatus = "";
    let ok = true;
    try {
      const response = await submit("result", body, settings);
      backendStatus = response ? `${response.run_status} (done ${response.done}, requeued ${response.requeued}, failed ${response.failed})` : "chờ gửi lại";
    } catch (error) {
      ok = false;
      backendStatus = `bị từ chối: ${errorText(error)}`;
    }
    const summary = summarizeRows(result.rows);
    await chrome.storage.local.set({ [STORAGE.lastRows]: { runId: job.run_id, watchlistId: job.watchlist_id, completedAt: body.completedAt, rows: result.rows, warnings: result.warnings, notes: result.notes, navigations: ((result.meta.timing as { navigations?: NavTiming[] } | undefined)?.navigations ?? []) } satisfies LastRunRows });
    await mutateState((state) => {
      state.lastError = undefined;
      state.lastResult = { runId: job.run_id, watchlistId: job.watchlist_id, ok, finishedAt: body.completedAt, backendStatus, durationMs: Date.now() - t0, warnings: result.warnings, ...summary };
      pushLog(state, result.warnings.length ? "warn" : "info", `Xong run ${job.run_id} trong ${Math.round((Date.now() - t0) / 1_000)}s: ${summary.ranked} ranked, ${summary.notFound} not found, ${summary.unverified} unverified → ${backendStatus}.${result.warnings.length ? ` Cảnh báo: ${result.warnings.join(" ")}` : ""}`);
    });
  } catch (error) {
    const kind: StopKind | "error" = error instanceof RunStopped ? error.kind : "error";
    const reason = error instanceof RunStopped ? error.message : errorText(error);
    const body = { ...resultBody(job, settings, collected, [reason], startedAt, crawlMeta(ctl, request, request.concurrency, null)), error: `${kind === "captcha" ? "captcha/blocked" : kind}: ${reason}` };
    let backendStatus = "lease đã mất — backend tự chạy lại";
    if (kind !== "lease_lost") {
      try {
        const response = await submit("fail", body, settings);
        backendStatus = response ? `${response.run_status} (giữ ${response.done} keyword đã xong, requeued ${response.requeued}, failed ${response.failed})` : "chờ gửi lại";
      } catch (submitError) {
        backendStatus = `bị từ chối: ${errorText(submitError)}`;
      }
    }
    if (collected.length) await chrome.storage.local.set({ [STORAGE.lastRows]: { runId: job.run_id, watchlistId: job.watchlist_id, completedAt: body.completedAt, rows: collected, warnings: [reason] } satisfies LastRunRows });
    const summary = summarizeRows(collected);
    await mutateState((state) => {
      if (kind === "captcha") state.cooldownUntil = Date.now() + RUN_COOLDOWN_AFTER_CAPTCHA_MS;
      state.lastResult = { runId: job.run_id, watchlistId: job.watchlist_id, ok: false, finishedAt: body.completedAt, error: reason, backendStatus, durationMs: Date.now() - t0, ...summary };
      pushLog(state, kind === "cancelled" || kind === "lease_lost" ? "warn" : "error", `Run ${job.run_id} dừng (${kind}): ${reason} → ${backendStatus}.`);
    });
    if (kind === "captcha") await notify("2J: Amazon CAPTCHA", `${reason} Tạm dừng nhận job 15 phút.`);
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(keepAliveTimer);
    if (writeTimer) clearTimeout(writeTimer);
    activeCtl = null;
    await chrome.storage.local.remove(PARTIAL_KEY);
    await mutateState((state) => { if (state.currentRun?.runId === job.run_id) state.currentRun = null; }, { force: true });
  }
}

async function closeLeftoverTabs() {
  const ids = (await chrome.storage.local.get(RUN_TABS_KEY))[RUN_TABS_KEY] as number[] | undefined;
  if (Array.isArray(ids)) await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => undefined)));
  await chrome.storage.local.remove(RUN_TABS_KEY);
}

/** A service-worker restart kills an in-flight run: report finished keywords so the backend re-queues the rest now. */
async function recoverInterruptedRun() {
  const state = await getWorkerState();
  lastFingerprint = stateFingerprint(state);
  updateBadge(state);
  if (!state.currentRun || activeCtl) return;
  const lost = state.currentRun;
  const partial = (await chrome.storage.local.get(PARTIAL_KEY))[PARTIAL_KEY] as { runId: string; job: WorkerJob; rows: DirectRankRow[]; startedAt: string } | undefined;
  const settings = await getSettings();
  const job = partial?.runId === lost.runId ? partial.job : ({ lease_token: lost.leaseToken, run_id: lost.runId, job_id: lost.jobId, watchlist_id: lost.watchlistId } as WorkerJob);
  const rows = partial?.runId === lost.runId ? partial.rows : [];
  let outcome = "";
  try {
    const response = await submit("fail", { ...resultBody(job, settings, rows, [], partial?.startedAt ?? lost.startedAt), error: "worker restarted mid-run (Chrome/service worker restart)" }, settings);
    outcome = response ? `backend ${response.run_status}, requeued ${response.requeued}` : "chờ gửi lại";
  } catch (error) {
    outcome = errorText(error);
  }
  await chrome.storage.local.remove(PARTIAL_KEY);
  await closeLeftoverTabs();
  await mutateState((s) => { s.currentRun = null; pushLog(s, "warn", `Run ${lost.runId} bị gián đoạn (Chrome khởi động lại). Đã báo backend (${outcome}).`); });
}

// ---------------------------------------------------------------------------
// Poll (long-poll) — the only thing that happens while idle
// ---------------------------------------------------------------------------
async function pollOnce(options: { wait?: number; forceGroups?: boolean } = {}): Promise<void> {
  if (activeCtl) return;
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    bootChecked ??= recoverInterruptedRun().catch((error) => { void logEvent("error", `Khôi phục run dở dang lỗi: ${errorText(error)}`); });
    await bootChecked;
    const settings = await getSettings();
    if (!settings.workerEnabled) return;
    const state = await getWorkerState();
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return;
    try {
      await flushPending(settings);
      const { job, groupsVersion } = await claimJob(settings, options.wait ?? LONG_POLL_SECONDS);
      await syncGroups(settings, groupsVersion, options.forceGroups || Boolean(job)).catch(() => undefined);
      await mutateState((s) => {
        s.connected = true; s.lastPollAt = new Date().toISOString(); s.lastContactAt = s.lastPollAt; s.lastError = undefined;
        markConnectionErrorsResolved(s); // also cleans up stale lines left by older versions
      });
      if (!job) return;
      await executeJob(job, settings);
      setTimeout(() => void pollOnce({ wait: 0 }), 1_000); // drain the queue right away
    } catch (error) {
      await mutateState((s) => {
        s.connected = !(error instanceof BackendError && error.code === "UNREACHABLE");
        s.lastPollAt = new Date().toISOString();
        if (s.lastError !== errorText(error)) pushLog(s, "error", errorText(error));
        s.lastError = errorText(error);
      });
    }
  })().finally(() => { pollInFlight = null; });
  return pollInFlight;
}

type WorkerMessage =
  | { type: "WORKER_KICK" }
  | { type: "WORKER_CANCEL" }
  | { type: "WORKER_REFRESH_GROUPS" }
  | { type: "WORKER_CLEAR_COOLDOWN" }
  | { type: "WORKER_RUN_NOW"; group?: string; watchlistId?: string };

async function handleMessage(message: WorkerMessage): Promise<unknown> {
  switch (message.type) {
    case "WORKER_KICK":
      void pollOnce({ wait: 0, forceGroups: true });
      return { ok: true };
    case "WORKER_REFRESH_GROUPS":
      await syncGroups(await getSettings(), null, true);
      return { ok: true };
    case "WORKER_CANCEL":
      if (!activeCtl) return { ok: false, error: "Không có run nào đang chạy." };
      stopRun(activeCtl, "cancelled", "Đã dừng từ Chrome.");
      return { ok: true };
    case "WORKER_CLEAR_COOLDOWN":
      await mutateState((state) => { state.cooldownUntil = undefined; pushLog(state, "info", "Đã bỏ tạm dừng."); });
      void pollOnce({ wait: 0 });
      return { ok: true };
    case "WORKER_RUN_NOW": {
      const response = await requestRunNow(message.group, message.watchlistId);
      const runs = response?.runs ?? [];
      await logEvent("info", runs.length ? `Chạy ngay${message.group !== undefined ? ` nhóm "${groupLabel(message.group)}"` : ""}: ${runs.map((item) => `${item.run_id}${item.existing ? " (đang có)" : ""}`).join(", ")}` : "Chạy ngay: không có cặp ASIN/keyword nào đang bật.");
      void pollOnce({ wait: 0 }); // an in-flight long-poll also wakes up server-side
      return { ok: true, runs };
    }
    default:
      return { ok: false, error: "unknown message" };
  }
}

export default defineBackground(() => {
  const ensureAlarm = () => chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  // boot: answer immediately (wait=0) so the connection state is known within ~1 s, then alarms long-poll
  chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); void ensurePopup(); void pollOnce({ wait: 0, forceGroups: true }); });
  chrome.runtime.onStartup.addListener(() => { ensureAlarm(); void ensurePopup(); void pollOnce({ wait: 0, forceGroups: true }); });
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void pollOnce(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.backendUrl || changes.workerToken || changes.workerEnabled)) void pollOnce({ wait: 0, forceGroups: true });
  });
  chrome.runtime.onMessage.addListener((message: WorkerMessage, _sender, sendResponse) => {
    if (!message || typeof message !== "object" || !String(message.type ?? "").startsWith("WORKER_")) return false;
    handleMessage(message).then(sendResponse, (error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  });
  ensureAlarm();
  void ensurePopup();
  void pollOnce({ wait: 0, forceGroups: true });
});

/** The toolbar click must always open the popup (re-assert in case a runtime override cleared it). */
async function ensurePopup() {
  const current = await chrome.action?.getPopup?.({}).catch(() => "");
  if (!current) await chrome.action?.setPopup?.({ popup: "popup.html" }).catch(() => undefined);
}
