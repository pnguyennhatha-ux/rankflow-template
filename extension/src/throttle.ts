export type DelayRange = [number, number];

export type Throttle = {
  /** Random wait between two result pages of one keyword. */
  pageDelayMs: DelayRange;
  /** Random wait before starting the next keyword (per crawl slot). */
  keywordDelayMs: DelayRange;
  /** Base pause after Amazon shows a CAPTCHA; doubles per consecutive block. */
  captchaBackoffMs: number;
};

export const DEFAULT_THROTTLE: Throttle = { pageDelayMs: [1_500, 4_000], keywordDelayMs: [2_000, 6_000], captchaBackoffMs: 90_000 };

const MAX_DELAY_MS = 120_000;
const MAX_BACKOFF_MS = 15 * 60_000;

function clampRange(value: unknown, fallback: DelayRange): DelayRange {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const lo = Math.min(MAX_DELAY_MS, Math.max(0, Math.round(Number(value[0]))));
  const hi = Math.min(MAX_DELAY_MS, Math.max(0, Math.round(Number(value[1]))));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return fallback;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

export function normalizeThrottle(value: Partial<Throttle> | null | undefined): Throttle {
  const backoff = Math.round(Number(value?.captchaBackoffMs));
  return {
    pageDelayMs: clampRange(value?.pageDelayMs, DEFAULT_THROTTLE.pageDelayMs),
    keywordDelayMs: clampRange(value?.keywordDelayMs, DEFAULT_THROTTLE.keywordDelayMs),
    captchaBackoffMs: Number.isFinite(backoff) && backoff >= 0 ? Math.min(MAX_BACKOFF_MS, backoff) : DEFAULT_THROTTLE.captchaBackoffMs
  };
}

export function randomDelay([lo, hi]: DelayRange, random: () => number = Math.random): number {
  return Math.round(lo + (hi - lo) * random());
}

/** Backoff after the n-th consecutive CAPTCHA (n >= 1): base * 2^(n-1), capped at 15 min. */
export function captchaBackoff(baseMs: number, consecutiveBlocks: number): number {
  const n = Math.max(1, Math.floor(consecutiveBlocks));
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (n - 1));
}

export type NavKind = "keyword" | "page";

/**
 * Global spacing for Amazon navigations shared by all crawl slots. Before each navigation the caller
 * waits a random gap (page or keyword range, by the kind of the UPCOMING navigation) that must have
 * elapsed since BOTH (a) the previous navigation of any slot started — so slots are staggered and no
 * two page loads ever start together — and (b) this slot's own previous page finished loading
 * (`settle`) — real "reading time" per tab. With one slot this is simply "gap after the page loaded".
 * `delayUntil` pushes every slot out (CAPTCHA backoff).
 */
export class NavGate {
  private lastStart = 0;
  private readonly settledBySlot = new Map<number, number>();
  private blockedUntil = 0;
  /** One entry per navigation: scheduled start, slot, gap since the previous navigation start, time waited, page load time. */
  readonly log: Array<{ at: number; kind: NavKind; slot: number; gapMs: number; waitMs: number; loadMs?: number }> = [];
  constructor(private readonly throttle: Throttle, private readonly now: () => number = Date.now, private readonly random: () => number = Math.random) {}

  /** Reserve the next navigation slot; returns how long the caller must wait before navigating. */
  reserve(kind: NavKind, slot = 0): number {
    const now = this.now();
    const first = this.log.length === 0;
    const gap = first ? 0 : randomDelay(kind === "page" ? this.throttle.pageDelayMs : this.throttle.keywordDelayMs, this.random);
    const anchor = Math.max(this.lastStart, this.settledBySlot.get(slot) ?? 0);
    const startAt = Math.max(now, this.blockedUntil, first ? now : anchor + gap);
    const gapMs = first ? 0 : startAt - this.lastStart;
    this.lastStart = startAt;
    this.log.push({ at: startAt, kind, slot, gapMs, waitMs: startAt - now });
    return startAt - now;
  }

  /** Mark that a page has finished loading/parsing; the next gap is counted from here. */
  settle(slot = 0) {
    const now = this.now();
    this.settledBySlot.set(slot, Math.max(this.settledBySlot.get(slot) ?? 0, now));
    for (let index = this.log.length - 1; index >= 0; index -= 1) {
      const entry = this.log[index]!;
      if (entry.slot === slot) { if (entry.loadMs === undefined) entry.loadMs = Math.max(0, now - entry.at); break; }
    }
  }

  /** Push the next navigation out (e.g. after a CAPTCHA). */
  delayUntil(at: number) {
    this.blockedUntil = Math.max(this.blockedUntil, at);
  }
}
