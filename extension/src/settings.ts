export type ExtensionSettings = {
  /** RankFlow backend (2J worker API). Default: the local backend on this machine. */
  backendUrl: string;
  /** Optional X-Worker-Token. Required when the backend is not on localhost. */
  workerToken: string;
  /** Auto-claim jobs from the backend. */
  workerEnabled: boolean;
  /** Stable id of this Chrome profile, sent as X-Worker-Id. */
  workerId: string;
};

export const DEFAULT_BACKEND_URL = "http://localhost:8787";
const KEYS = ["backendUrl", "workerToken", "workerEnabled", "workerId"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https://any-host or http://localhost|127.0.0.1|[::1] (any port). Returns the normalized origin(+path) or throws. */
export function normalizeBackendUrl(value: string): string {
  const raw = (value || "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_BACKEND_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Backend URL không hợp lệ."); }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Backend URL phải là https://… hoặc http://localhost / http://127.0.0.1 (máy này).");
  }
  if (url.search || url.hash) throw new Error("Backend URL không được chứa ? hoặc #.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function isLoopbackUrl(value: string): boolean {
  try { return LOOPBACK_HOSTS.has(new URL(value).hostname); } catch { return false; }
}

/** Host-permission pattern needed for a backend URL (loopback hosts are granted in the manifest). */
export function originPattern(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

function newWorkerId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "2j-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get([...KEYS]) as Partial<ExtensionSettings>;
  let backendUrl = DEFAULT_BACKEND_URL;
  try { backendUrl = normalizeBackendUrl(String(stored.backendUrl ?? "")); } catch { /* fall back to default */ }
  let workerId = typeof stored.workerId === "string" && stored.workerId ? stored.workerId : "";
  if (!workerId) {
    workerId = newWorkerId();
    await chrome.storage.local.set({ workerId });
  }
  return {
    backendUrl,
    workerToken: typeof stored.workerToken === "string" ? stored.workerToken.trim() : "",
    workerEnabled: stored.workerEnabled !== false,
    workerId
  };
}

export async function saveSettings(patch: Partial<Omit<ExtensionSettings, "workerId">>): Promise<ExtensionSettings> {
  const next: Record<string, unknown> = {};
  if (patch.backendUrl !== undefined) {
    const backendUrl = normalizeBackendUrl(patch.backendUrl);
    if (!isLoopbackUrl(backendUrl) && chrome.permissions) {
      const origins = [originPattern(backendUrl)];
      const granted = await chrome.permissions.contains({ origins }) || await chrome.permissions.request({ origins });
      if (!granted) throw new Error("Chrome chưa cấp quyền truy cập backend này.");
    }
    next.backendUrl = backendUrl;
  }
  if (patch.workerToken !== undefined) next.workerToken = patch.workerToken.trim();
  if (patch.workerEnabled !== undefined) next.workerEnabled = Boolean(patch.workerEnabled);
  await chrome.storage.local.set(next);
  return getSettings();
}
