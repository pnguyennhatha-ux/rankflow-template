import { describe, expect, it } from "vitest";
import { DEFAULT_SCAN_DEPTH, buildDirectQueryPlans, buildDirectRows, buildUnverifiedRows, scanPagePlan } from "./rank";
import { accumulatePage, newRankState, type SerpTile } from "./serp";
import { jobToRequest } from "./job";

describe("direct rank result mapping", () => {
  it("keeps sponsored and organic ranks separate", () => {
    const rows = buildDirectRows("grandma mug", ["B000000001", "B000000002"], [
      { asin: "B000000001", sponsored: true, rank: 2, pageNumber: 1, positionOnPage: 2 },
      { asin: "B000000001", sponsored: false, rank: 43, pageNumber: 3, positionOnPage: 7, title: "Grandma Mug", imageUrl: "https://images.example/mug.jpg", priceText: "$19.99", priceCents: 1999, currency: "USD" }
    ], "2026-09-14");

    expect(rows[0]).toMatchObject({ snapshotDay: "2026-09-14", scanDepth: 190, status: "ranked", organicRank: 43, sponsoredRank: 2, pageNumber: 3, positionOnPage: 7, title: "Grandma Mug", priceText: "$19.99", priceCents: 1999 });
    expect(rows[1]).toMatchObject({ status: "not_found_within_190", organicRank: null, sponsoredRank: null });
  });

  it("records a configurable organic scan depth", () => {
    expect(buildDirectRows("mug", ["B000000001"], [], "2026-09-14", 250)[0]).toMatchObject({
      scanDepth: 250,
      status: "not_found_within_250"
    });
  });

  it("fails closed when Amazon cannot be verified", () => {
    expect(buildUnverifiedRows("mug", ["B000000001"], "unverified_blocked", "CAPTCHA", "2026-09-14")[0]).toMatchObject({
      snapshotDay: "2026-09-14",
      status: "unverified_blocked",
      note: "CAPTCHA"
    });
  });

  it("keeps group cross-products separate while crawling a shared keyword once", () => {
    const plans = buildDirectQueryPlans([
      { id: "g1", name: "Group 1", asins: ["B000000001", "B000000002"], keywords: ["Grandma Mug", "gift mug"] },
      { id: "g2", name: "Group 2", asins: ["B000000003"], keywords: ["grandma mug"] }
    ]);
    expect(plans).toHaveLength(2);
    expect(plans.find((plan) => plan.normalizedKeyword === "grandma mug")?.targets).toEqual([
      { groupId: "g1", groupName: "Group 1", asin: "B000000001" },
      { groupId: "g1", groupName: "Group 1", asin: "B000000002" },
      { groupId: "g2", groupName: "Group 2", asin: "B000000003" }
    ]);
  });

  it("defaults to 190 organic and plans enough pages for both SERP layouts", () => {
    expect(DEFAULT_SCAN_DEPTH).toBe(190);
    expect(scanPagePlan(190)).toEqual({ expectedPages: 4, maxPages: 48 });
    expect(scanPagePlan(100).expectedPages).toBe(3);
    const tile = (asin: string, kind: SerpTile["kind"] = "organic"): SerpTile => ({ asin, sponsored: kind !== "organic", kind, signal: kind === "organic" ? "" : "label-class", component: "s-search-result", title: null, imageUrl: null, priceText: null, priceCents: null, currency: null });
    const layouts = {
      "48-tile (48 organic)": (p: number) => Array.from({ length: 48 }, (_, i) => tile(`B0P${p}O${String(i).padStart(5, "0")}`)),
      "60-tile (48 organic + 12 sponsored)": (p: number) => Array.from({ length: 60 }, (_, i) => tile(`B0P${p}X${String(i).padStart(5, "0")}`, i % 5 === 1 ? "sponsored" : "organic"))
    };
    for (const [name, page] of Object.entries(layouts)) {
      const { maxPages } = scanPagePlan(190);
      const state = newRankState();
      let pages = 0;
      for (let p = 1; p <= maxPages && state.organicScanned < 190; p += 1) { accumulatePage(state, page(p), p, new Set(["B0NOTHERE1"]), { maxOrganic: 190, includeSponsored: false }); pages = p; }
      expect({ name, organic: state.organicScanned, pages }).toEqual({ name, organic: 190, pages: 4 });
      expect(buildDirectRows("kw", ["B0NOTHERE1"], state.matches, "2026-10-07", 190)[0]!.status).toBe("not_found_within_190");
    }
    // a hit at organic #187 (page 4, position 43) is still reported
    const state = newRankState();
    for (let p = 1; p <= 4; p += 1) accumulatePage(state, layouts["48-tile (48 organic)"](p).map((t, i) => (p === 4 && i === 42 ? { ...t, asin: "B0TARGET01" } : t)), p, new Set(["B0TARGET01"]), { maxOrganic: 190, includeSponsored: false });
    expect(buildDirectRows("kw", ["B0TARGET01"], state.matches, "2026-10-07", 190)[0]).toMatchObject({ status: "ranked", organicRank: 187, pageNumber: 4, positionOnPage: 43 });
  });

  it("jobs without maxOrganic fall back to 190", () => {
    const base = { run_id: "r", lease_token: "t", groups: [{ id: "g", name: "G", asins: ["B0TEST0004"], keywords: ["mug"] }] };
    expect(jobToRequest(base as never).maxOrganic).toBe(190);
    expect(jobToRequest({ ...base, maxOrganic: 100 } as never).maxOrganic).toBe(100);
  });
});
