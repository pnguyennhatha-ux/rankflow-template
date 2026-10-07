import type { WorkerState } from "./worker-state";

export type StatusKind = "idle" | "running" | "paused" | "error" | "offline" | "disabled";
export type WorkerStatus = { kind: StatusKind; label: string; detail: string; percent: number | null };

/** One place that turns worker state into the badge shown in popup and dashboard. */
export function deriveStatus(state: WorkerState | undefined, options: { enabled: boolean; now?: number }): WorkerStatus {
  const now = options.now ?? Date.now();
  if (!state) return { kind: "idle", label: "Đang khởi động", detail: "", percent: null };
  const run = state.currentRun;
  if (run) {
    const percent = runPercent(run);
    if (run.phase === "zip") return { kind: "running", label: "Đang chạy · đặt ZIP", detail: run.message, percent };
    if (run.phase === "submit") return { kind: "running", label: `Đang gửi kết quả ${run.completed}/${run.keywordsTotal}`, detail: run.message, percent };
    if (run.pausedUntil && run.pausedUntil > now) return { kind: "paused", label: "Tạm dừng · CAPTCHA", detail: `Tiếp tục sau ${Math.ceil((run.pausedUntil - now) / 1_000)}s · ${run.completed}/${run.keywordsTotal} keyword`, percent };
    return { kind: "running", label: `Đang chạy ${run.completed}/${run.keywordsTotal} keyword`, detail: run.message, percent };
  }
  if (!options.enabled) return { kind: "disabled", label: "Worker đã tắt", detail: "Bật lại trong Cài đặt", percent: null };
  if (state.cooldownUntil && state.cooldownUntil > now) return { kind: "paused", label: "Tạm dừng · CAPTCHA", detail: `Nhận job lại lúc ${new Date(state.cooldownUntil).toLocaleTimeString("vi-VN", { timeZone: "Asia/Bangkok", hour12: false })}`, percent: null };
  if (state.connected === false) return { kind: "offline", label: "Mất kết nối backend", detail: state.lastError ?? "", percent: null };
  if (state.connected === undefined && !state.lastError) return { kind: "idle", label: "Đang kết nối backend…", detail: "", percent: null };
  if (state.lastError) return { kind: "error", label: "Lỗi", detail: state.lastError, percent: null };
  return { kind: "idle", label: "Rảnh · chờ yêu cầu", detail: "Chỉ mở Amazon khi backend có job", percent: null };
}

export function runPercent(run: { completed: number; keywordsTotal: number; inflight?: Record<string, number> }): number {
  const total = Math.max(1, run.keywordsTotal);
  const partial = Object.values(run.inflight ?? {}).reduce((sum, value) => sum + Math.min(0.95, Math.max(0, value)), 0);
  return Math.min(100, Math.round(((run.completed + partial) / total) * 100));
}

/**
 * Toolbar badge: running → "xx%" (blue), CAPTCHA pause → "II" (amber), error/offline → "!" (red).
 * Idle, disabled and "not contacted yet" show no badge.
 */
export function badgeFor(state: WorkerState | undefined, options: { enabled: boolean; now?: number }): { text: string; color: string } {
  const status = deriveStatus(state, options);
  switch (status.kind) {
    case "running": return { text: `${Math.min(99, status.percent ?? 0)}%`, color: "#2868ed" };
    case "paused": return { text: "II", color: "#b45309" };
    case "error":
    case "offline": return { text: "!", color: "#c0362c" };
    default: return { text: "", color: "#68728a" };
  }
}
