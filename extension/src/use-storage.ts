import { useEffect, useState } from "react";

/** Live value of a chrome.storage.local key (updates when the background writes it). */
export function useStorageValue<T>(key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void chrome.storage.local.get(key).then((stored) => { if (alive) setValue(stored[key] as T | undefined); });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[key]) setValue(changes[key]!.newValue as T | undefined);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => { alive = false; chrome.storage.onChanged.removeListener(listener); };
  }, [key]);
  return value;
}

export type WorkerReply = { ok: boolean; error?: string; runs?: Array<{ run_id: string; existing: boolean; group?: string | null }> };

export async function sendWorker(message: Record<string, unknown>): Promise<WorkerReply> {
  try {
    return (await chrome.runtime.sendMessage(message)) as WorkerReply ?? { ok: false, error: "Không có phản hồi từ background." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1_000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 5) return "vừa xong";
  if (seconds < 60) return `${seconds}s trước`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} phút trước`;
  return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok", hour12: false });
}
