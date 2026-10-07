import type { WorkerJob } from "./backend";
import { parseOwner } from "./groups";
import { DEFAULT_SCAN_DEPTH, type DirectCheckRequest } from "./rank";
import { normalizeThrottle } from "./throttle";

/** Fixed crawl width: 2 keyword slots (2 reused tabs). Backend hint is clamped to [1, 2]; default 2. */
export const MAX_CONCURRENCY = 2;
export const DEFAULT_CONCURRENCY = 2;

/** Validate a GET /job payload and turn it into a crawl request. Throws on malformed jobs. */
export function jobToRequest(job: WorkerJob): DirectCheckRequest {
  if (!job || typeof job !== "object" || !job.lease_token || !job.run_id) throw new Error("Job từ backend thiếu lease_token/run_id.");
  const groups = (Array.isArray(job.groups) ? job.groups : []).map((group, index) => ({
    id: String(group.id ?? `g${index + 1}`),
    name: String(group.name ?? group.id ?? `Group ${index + 1}`),
    asins: (Array.isArray(group.asins) ? group.asins : []).map((asin) => String(asin).trim().toUpperCase()).filter((asin) => /^[A-Z0-9]{10}$/.test(asin)),
    keywords: (Array.isArray(group.keywords) ? group.keywords : []).map((keyword) => String(keyword).trim().replace(/\s+/g, " ")).filter(Boolean),
    owner: parseOwner(group.owner)
  })).filter((group) => group.asins.length && group.keywords.length);
  if (!groups.length) throw new Error("Job từ backend không có ASIN/keyword hợp lệ.");
  const zip = String(job.postalCode ?? "").trim();
  return {
    groups,
    postalCode: zip,
    setPostalCode: Boolean(job.setPostalCode) && /^\d{5}$/.test(zip),
    includeSponsored: Boolean(job.includeSponsored),
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(Number(job.concurrency) || DEFAULT_CONCURRENCY))),
    maxOrganic: Math.min(1_000, Math.max(1, Math.round(Number(job.maxOrganic) || DEFAULT_SCAN_DEPTH))),
    throttle: normalizeThrottle(job.throttle)
  };
}

/** Heartbeat interval in ms: backend hint, clamped to [15s, lease/3]. */
export function heartbeatInterval(job: Pick<WorkerJob, "heartbeat_seconds" | "lease_seconds">): number {
  const lease = Math.max(60, Number(job.lease_seconds) || 600);
  const hint = Number(job.heartbeat_seconds) || 60;
  return Math.round(Math.min(Math.max(15, hint), lease / 3) * 1_000);
}
