import React, { useEffect, useState } from "react";
import { getSettings, type ExtensionSettings } from "./settings";
import { deriveStatus, type WorkerStatus } from "./status";
import { STORAGE, type WorkerState } from "./worker-state";
import { useStorageValue } from "./use-storage";

export function StatusPill({ status, large = false }: { status: WorkerStatus; large?: boolean }) {
  return <span className={`pill ${status.kind}${large ? " lg" : ""}`}><i />{status.label}</span>;
}

export function Progress({ percent }: { percent: number | null }) {
  return <div className={`progress${percent === null ? " indeterminate" : ""}`} role="progressbar" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent ?? 0}%` }} /></div>;
}

/** Worker state + derived status, re-evaluated every second so countdowns stay fresh. */
export function useWorker(): { state?: WorkerState; settings: ExtensionSettings | null; status: WorkerStatus } {
  const state = useStorageValue<WorkerState>(STORAGE.state);
  const enabledFlag = useStorageValue<boolean>("workerEnabled");
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { void getSettings().then(setSettings); }, [enabledFlag]);
  useEffect(() => { const timer = setInterval(() => tick((value) => value + 1), 1_000); return () => clearInterval(timer); }, []);
  return { state, settings, status: deriveStatus(state, { enabled: settings?.workerEnabled ?? true }) };
}

export function statusClass(status: string): "ranked" | "not_found" | "unverified" {
  return status === "ranked" ? "ranked" : status.startsWith("not_found") ? "not_found" : "unverified";
}

export function duration(ms?: number | null): string {
  if (!ms && ms !== 0) return "—";
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
