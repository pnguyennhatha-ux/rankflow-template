import { describe, expect, it } from "vitest";
import type { WorkerJob } from "./backend";
import { countPairs, groupOwners, ownerLabel, parseOwner } from "./groups";
import { jobToRequest } from "./job";
import { buildDirectQueryPlans } from "./rank";
import { createDirectRankXlsx } from "./xlsx-export";

const OU1 = "ou_" + "1".repeat(32);
const OU2 = "ou_" + "2".repeat(32);

describe("owner helpers", () => {
  it("parses backend owners and labels them", () => {
    expect(parseOwner({ id: OU1, name: " Hana " })).toEqual({ id: OU1, name: "Hana" });
    expect(parseOwner({ id: OU2 })).toEqual({ id: OU2, name: null });
    for (const bad of [null, undefined, "", "ou_x", {}, { name: "x" }, { id: "  " }]) expect(parseOwner(bad)).toBeNull();
    expect(ownerLabel({ id: OU1, name: "Hana" })).toBe("Hana");
    expect(ownerLabel({ id: OU2, name: null })).toBe(OU2);
    expect(ownerLabel(null)).toBe("");
  });
  it("collects distinct group owners from group.owners and per-keyword owners", () => {
    const owners = groupOwners({ owners: [{ id: OU2, name: "Lan" }], asins: [{ owners: { mug: { id: OU1, name: "Hana" }, cup: { id: OU2, name: "Lan" } } }, { owners: undefined }] });
    expect(owners.map((owner) => owner.name)).toEqual(["Hana", "Lan"]);
  });
  it("counts distinct pairs, not a summed counter", () => {
    const groups = [
      { watchlist_id: "w", pairs: 40, asins: [{ asin: "B0AAAAAAAA", keywords: ["Mug", "cup"] }] },
      { watchlist_id: "w", pairs: 40, asins: [{ asin: "b0aaaaaaaa", keywords: ["mug "] }, { asin: "B0BBBBBBBB", keywords: ["mug"] }] }
    ];
    expect(countPairs(groups)).toBe(3);
    expect(countPairs(undefined)).toBe(0);
  });
});

describe("owner flows job -> plan targets -> export", () => {
  const job = {
    job_id: "j", lease_token: "t", run_id: "r", watchlist_id: "w",
    groups: [
      { id: `w:B0AAAAAAAA:G@${OU1}`, name: "G", asins: ["B0AAAAAAAA"], keywords: ["mug"], owner: { id: OU1, name: "Hana" } },
      { id: "w:B0BBBBBBBB:G", name: "G", asins: ["B0BBBBBBBB"], keywords: ["mug"], owner: null },
      { id: `w:B0AAAAAAAA:G@${OU2}`, name: "G", asins: ["B0AAAAAAAA"], keywords: ["cup"], owner: { id: OU2, name: "Lan" } }
    ],
    keywords_total: 2, pairs_total: 3, postalCode: "10001", setPostalCode: false, includeSponsored: false,
    concurrency: 2, maxOrganic: 190, lease_seconds: 600, heartbeat_seconds: 60
  } satisfies WorkerJob;

  it("keeps owner per group and puts it on each query target", () => {
    const request = jobToRequest(job);
    expect(request.groups.map((group) => group.owner?.name ?? null)).toEqual(["Hana", null, "Lan"]);
    const plans = buildDirectQueryPlans(request.groups);
    const mug = plans.find((plan) => plan.normalizedKeyword === "mug")!;
    expect(mug.targets).toEqual([
      { groupId: `w:B0AAAAAAAA:G@${OU1}`, groupName: "G", asin: "B0AAAAAAAA", ownerId: OU1, ownerName: "Hana" },
      { groupId: "w:B0BBBBBBBB:G", groupName: "G", asin: "B0BBBBBBBB" }
    ]);
    expect(plans.find((plan) => plan.normalizedKeyword === "cup")!.targets[0]).toMatchObject({ ownerId: OU2, ownerName: "Lan" });
  });

  it("exports the owner column in Excel", async () => {
    const blob = createDirectRankXlsx([{ groupId: "g", groupName: "G", ownerId: OU1, ownerName: "Hana", keyword: "mug", asin: "B0AAAAAAAA", snapshotDay: "2026-10-07", scanDepth: 190, organicRank: 5, sponsoredRank: null, pageNumber: 1, positionOnPage: 5, status: "ranked", title: null, imageUrl: null, priceText: null, priceCents: null, currency: null }]);
    const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text).toContain("owner");
    expect(text).toContain("Hana");
  });
});
