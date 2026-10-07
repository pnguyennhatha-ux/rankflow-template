import type { Throttle } from "./throttle";

/** "not_found_within_<depth>" (e.g. not_found_within_190); "not_found_within_limit" only in rows stored by <= v0.3.3. */
export type DirectCheckStatus = "ranked" | `not_found_within_${number}` | "not_found_within_limit" | "unverified_blocked" | "unverified_parser_error";

/** Default organic depth when a job carries no maxOrganic (backend DEFAULT_TOP_N / Base watchlist.top_n = 190). */
export const DEFAULT_SCAN_DEPTH = 190;
/** Amazon shows 48 organic results per page on both the 48-tile and the 60-tile (48 organic + 12 sponsored) layouts. */
export const ORGANIC_PER_PAGE = 48;

export function notFoundStatus(scanDepth: number): `not_found_within_${number}` {
  return `not_found_within_${scanDepth}`;
}

/**
 * Pages for one keyword. expectedPages = pages needed to count maxOrganic organic results on a full layout
 * (190 -> 4); maxPages is the hard safety cap, generous enough for sparse pages (ad rows, short grids):
 * at least 10 and >= 1 organic per 4 results, capped at 200.
 */
export function scanPagePlan(maxOrganic: number): { expectedPages: number; maxPages: number } {
  return {
    expectedPages: Math.max(1, Math.ceil(maxOrganic / ORGANIC_PER_PAGE)),
    maxPages: Math.min(200, Math.max(10, Math.ceil(maxOrganic / 4)))
  };
}

export type DirectSerpMatch = {
  asin: string;
  sponsored: boolean;
  rank: number;
  pageNumber: number;
  positionOnPage: number;
  title?: string | null;
  imageUrl?: string | null;
  priceText?: string | null;
  priceCents?: number | null;
  currency?: string | null;
  sponsoredAbove?: number;
  featuredAbove?: number;
};

export type DirectRankRow = {
  groupId?: string;
  groupName?: string;
  /** watchlist_item.owner (Lark user open_id / display name) of this ASIN+keyword. */
  ownerId?: string | null;
  ownerName?: string | null;
  snapshotDay: string;
  scanDepth: number;
  keyword: string;
  asin: string;
  organicRank: number | null;
  sponsoredRank: number | null;
  pageNumber: number | null;
  positionOnPage: number | null;
  status: DirectCheckStatus;
  note?: string;
  /** Sponsored tiles above the organic hit on its page (diagnostic; compare with what you see on Amazon). */
  sponsoredAbove?: number | null;
  /** Ad slots without a Sponsored label above the hit (e.g. "Featured from Amazon brands"). */
  featuredAbove?: number | null;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  priceCents: number | null;
  currency: string | null;
};

export type DirectCheckRequest = {
  groups: DirectCheckInputGroup[];
  postalCode: string;
  setPostalCode: boolean;
  includeSponsored: boolean;
  concurrency: number;
  maxOrganic: number;
  throttle?: Throttle;
};

export type DirectCheckInputGroup = {
  id: string;
  name: string;
  asins: string[];
  keywords: string[];
  owner?: { id: string; name?: string | null } | null;
};

export type DirectQueryTarget = { groupId: string; groupName: string; asin: string; ownerId?: string; ownerName?: string | null };
export type DirectQueryPlan = { keyword: string; normalizedKeyword: string; targets: DirectQueryTarget[] };

export function buildDirectQueryPlans(groups: DirectCheckInputGroup[]): DirectQueryPlan[] {
  const plans = new Map<string, DirectQueryPlan>();
  for (const group of groups) {
    const asins = [...new Set(group.asins.map((asin) => asin.trim().toUpperCase()).filter(Boolean))];
    const keywords = [...new Set(group.keywords.map((keyword) => keyword.trim().replace(/\s+/g, " ")).filter(Boolean))];
    for (const keyword of keywords) {
      const normalizedKeyword = keyword.toLocaleLowerCase("en-US");
      const plan = plans.get(normalizedKeyword) ?? { keyword, normalizedKeyword, targets: [] };
      for (const asin of asins) {
        if (!plan.targets.some((target) => target.groupId === group.id && target.asin === asin)) plan.targets.push({ groupId: group.id, groupName: group.name, asin, ...(group.owner?.id ? { ownerId: group.owner.id, ownerName: group.owner.name ?? null } : {}) });
      }
      plans.set(normalizedKeyword, plan);
    }
  }
  return [...plans.values()];
}

export type DirectCheckResult = {
  rows: DirectRankRow[];
  warnings: string[];
  startedAt: string;
  completedAt: string;
};

export function buildDirectRows(keyword: string, asins: string[], matches: DirectSerpMatch[], snapshotDay = new Date().toISOString().slice(0, 10), scanDepth = DEFAULT_SCAN_DEPTH): DirectRankRow[] {
  return asins.map((asin) => {
    const organic = matches.find((item) => item.asin === asin && !item.sponsored);
    const sponsored = matches.find((item) => item.asin === asin && item.sponsored);
    const metadata = organic ?? sponsored;
    return {
      snapshotDay,
      scanDepth,
      keyword,
      asin,
      organicRank: organic?.rank ?? null,
      sponsoredRank: sponsored?.rank ?? null,
      pageNumber: organic?.pageNumber ?? null,
      positionOnPage: organic?.positionOnPage ?? null,
      sponsoredAbove: organic?.sponsoredAbove ?? null,
      featuredAbove: organic?.featuredAbove ?? null,
      status: organic ? "ranked" : notFoundStatus(scanDepth),
      title: metadata?.title ?? null,
      imageUrl: metadata?.imageUrl ?? null,
      priceText: metadata?.priceText ?? null,
      priceCents: metadata?.priceCents ?? null,
      currency: metadata?.currency ?? null
    };
  });
}

export function buildUnverifiedRows(keyword: string, asins: string[], status: Extract<DirectCheckStatus, `unverified_${string}`>, note: string, snapshotDay = new Date().toISOString().slice(0, 10), scanDepth = DEFAULT_SCAN_DEPTH): DirectRankRow[] {
  return asins.map((asin) => ({
    snapshotDay,
    scanDepth,
    keyword,
    asin,
    organicRank: null,
    sponsoredRank: null,
    pageNumber: null,
    positionOnPage: null,
    status,
    note,
    title: null,
    imageUrl: null,
    priceText: null,
    priceCents: null,
    currency: null
  }));
}

/** Base / block UI position format: "#<position on page> P<page>", e.g. "#18 P4". */
export function positionLabel(row: Pick<DirectRankRow, "pageNumber" | "positionOnPage">): string {
  return row.pageNumber && row.positionOnPage ? `#${row.positionOnPage} P${row.pageNumber}` : "";
}
