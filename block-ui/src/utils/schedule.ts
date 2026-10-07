/**
 * Structured schedule (v0.2.2) — contract: docs/PIPELINE.md
 * "Schedule contract". Box cron pulls Base→DB 55 min before schedule_time and runs the
 * pipeline at schedule_time (no agent, no polling).
 *   schedule_enabled  Checkbox
 *   schedule_days     Text 'Tue,Wed,Thu,Fri' (Mon..Sun tokens, comma, Mon-first order)
 *   schedule_time     Text 'HH:MM' 24 h, ICT (Asia/Bangkok, UTC+7) — independent of viewer TZ.
 */
export const DAY_TOKENS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type DayToken = (typeof DAY_TOKENS)[number];

/** Vietnamese labels: chip (short) + long ('Thứ 3'). */
export const DAY_SHORT_VI: Record<DayToken, string> = {
  Mon: 'T2', Tue: 'T3', Wed: 'T4', Thu: 'T5', Fri: 'T6', Sat: 'T7', Sun: 'CN',
};
export const DAY_LONG_VI: Record<DayToken, string> = {
  Mon: 'Thứ 2', Tue: 'Thứ 3', Wed: 'Thứ 4', Thu: 'Thứ 5', Fri: 'Thứ 6', Sat: 'Thứ 7', Sun: 'Chủ nhật',
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ICT_MS = 7 * 3600 * 1000;

export interface Schedule {
  enabled: boolean;
  days: DayToken[]; // normalized Mon→Sun order, unique
  time: string; // raw trimmed text; valid iff TIME_RE
}

/** Parse Base text → tokens (case-insensitive, spaces ignored). Unknown tokens returned separately. */
export function parseDays(raw: string): { days: DayToken[]; unknown: string[] } {
  const set = new Set<DayToken>();
  const unknown: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const p = part.trim();
    if (!p) continue;
    const hit = DAY_TOKENS.find((d) => d.toLowerCase() === p.slice(0, 3).toLowerCase() && p.length <= 9);
    if (hit) set.add(hit);
    else unknown.push(p);
  }
  return { days: DAY_TOKENS.filter((d) => set.has(d)), unknown };
}

export const formatDays = (days: DayToken[]): string => DAY_TOKENS.filter((d) => days.includes(d)).join(',');

/** 'T3–T6' for consecutive runs, else 'T2, T4, T6'. */
export function daysLabelVi(days: DayToken[]): string {
  const idx = DAY_TOKENS.map((d, i) => (days.includes(d) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return '—';
  if (idx.length === 7) return 'mỗi ngày';
  const contiguous = idx.length >= 3 && idx[idx.length - 1] - idx[0] === idx.length - 1;
  if (contiguous) return `${DAY_SHORT_VI[DAY_TOKENS[idx[0]]]}–${DAY_SHORT_VI[DAY_TOKENS[idx[idx.length - 1]]]}`;
  return idx.map((i) => DAY_SHORT_VI[DAY_TOKENS[i]]).join(', ');
}

/** Human display text written to schedule_note on save (display only, not parsed). */
export function scheduleNoteText(s: Schedule): string {
  const days = s.days;
  const idx = DAY_TOKENS.map((d, i) => (days.includes(d) ? i : -1)).filter((i) => i >= 0);
  const contiguous = idx.length >= 3 && idx[idx.length - 1] - idx[0] === idx.length - 1;
  const d =
    idx.length === 7 ? 'Daily' : contiguous ? `${DAY_TOKENS[idx[0]]}–${DAY_TOKENS[idx[idx.length - 1]]}` : formatDays(days);
  const rule = days.length && s.time ? `${d} ${s.time} ICT` : '';
  if (!s.enabled) return rule ? `Tắt lịch (${rule})` : 'Tắt lịch';
  return rule;
}

export function scheduleErrors(s: Schedule): string[] {
  const errs: string[] = [];
  // time is required when the schedule is on; when off, only validate if something was typed
  if ((s.enabled || s.time.trim() !== '') && !TIME_RE.test(s.time.trim()))
    errs.push('Giờ chạy phải dạng HH:MM (00:00–23:59, ICT).');
  if (s.enabled && !s.days.length) errs.push('Bật lịch cần chọn ít nhất 1 ngày.');
  return errs;
}

/** First slot strictly after `now` (epoch ms), or null when disabled/invalid. */
export function nextRun(s: Schedule | null, now = Date.now()): number | null {
  if (!s || !s.enabled || !s.days.length || !TIME_RE.test(s.time)) return null;
  const [hh, mm] = s.time.split(':').map(Number);
  const ict = new Date(now + ICT_MS); // read as UTC = ICT wall clock
  for (let add = 0; add <= 7; add += 1) {
    const dayStartIct = Date.UTC(ict.getUTCFullYear(), ict.getUTCMonth(), ict.getUTCDate() + add);
    const slotIct = dayStartIct + (hh * 60 + mm) * 60_000;
    const slot = slotIct - ICT_MS;
    if (slot <= now) continue;
    const dow = new Date(dayStartIct).getUTCDay(); // 0 = Sun
    const tok = DAY_TOKENS[(dow + 6) % 7];
    if (s.days.includes(tok)) return slot;
  }
  return null;
}

/** 'Thứ 3 09:52' (ICT). */
export function formatNextRun(ms: number): string {
  const d = new Date(ms + ICT_MS);
  const tok = DAY_TOKENS[(d.getUTCDay() + 6) % 7];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAY_LONG_VI[tok]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** '29/09/2026 09:52 ICT' for tooltips. */
export function formatNextRunFull(ms: number): string {
  const d = new Date(ms + ICT_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ICT`;
}

/** ISO-8601 in ICT (+07:00) regardless of the viewer's time zone. */
export function isoIct(d = new Date()): string {
  const t = new Date(d.getTime() + ICT_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+07:00`
  );
}

export function asBoolCell(v: unknown, text: string): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = text.toLowerCase();
  return s === 'true' || s === '1';
}
