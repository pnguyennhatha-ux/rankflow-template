import { describe, expect, it } from "vitest";
import type { WorkerJob } from "./backend";
import { buildDirectQueryPlans } from "./rank";
import { heartbeatInterval, jobToRequest } from "./job";

const job: WorkerJob = {
  job_id: "run-1:abcd1234", lease_token: "tok", run_id: "run-1", watchlist_id: "team-a",
  groups: [
    { id: "team-a:B0TEST0008:Mugs", name: "Mugs", asins: ["b0test0008"], keywords: ["Halloween  Mug", "gift mug"] },
    { id: "team-a:B0AAAAAAAA:Mugs", name: "Mugs", asins: ["B0AAAAAAAA", "bad"], keywords: ["halloween mug"] },
    { id: "empty", name: "Empty", asins: [], keywords: ["x"] }
  ],
  keywords_total: 2, pairs_total: 3, postalCode: "10001", setPostalCode: true, includeSponsored: false,
  concurrency: 9, maxOrganic: 250, lease_seconds: 600, heartbeat_seconds: 60,
  throttle: { pageDelayMs: [1500, 4000], keywordDelayMs: [2000, 6000], captchaBackoffMs: 90000 }
};

describe("GET /job payload -> crawl request", () => {
  it("validates, normalizes and clamps", () => {
    const request = jobToRequest(job);
    expect(request.groups).toHaveLength(2);
    expect(request.groups[0]).toMatchObject({ asins: ["B0TEST0008"], keywords: ["Halloween Mug", "gift mug"] });
    expect(request.groups[1]!.asins).toEqual(["B0AAAAAAAA"]);
    expect(request).toMatchObject({ postalCode: "10001", setPostalCode: true, concurrency: 2, maxOrganic: 250 });
    expect(request.throttle?.captchaBackoffMs).toBe(90000);
  });
  it("crawls a shared keyword once (case-insensitive) but keeps the first display case", () => {
    const plans = buildDirectQueryPlans(jobToRequest(job).groups);
    expect(plans).toHaveLength(2);
    const halloween = plans.find((plan) => plan.normalizedKeyword === "halloween mug")!;
    expect(halloween.keyword).toBe("Halloween Mug");
    expect(halloween.targets.map((target) => target.asin)).toEqual(["B0TEST0008", "B0AAAAAAAA"]);
  });
  it("skips the ZIP step for an invalid ZIP and rejects empty jobs", () => {
    expect(jobToRequest({ ...job, postalCode: "1234" }).setPostalCode).toBe(false);
    expect(() => jobToRequest({ ...job, groups: [] })).toThrow();
    expect(() => jobToRequest({ ...job, lease_token: "" })).toThrow();
  });
  it("derives a safe heartbeat interval", () => {
    expect(heartbeatInterval({ heartbeat_seconds: 60, lease_seconds: 600 })).toBe(60000);
    expect(heartbeatInterval({ heartbeat_seconds: 5, lease_seconds: 600 })).toBe(15000);
    expect(heartbeatInterval({ heartbeat_seconds: 300, lease_seconds: 120 })).toBe(40000);
  });
});
