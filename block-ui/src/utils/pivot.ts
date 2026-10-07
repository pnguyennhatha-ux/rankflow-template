import type { FilterState, RankSnapshot } from '../types';

export interface PivotCell {
  organic_rank: number | null;
  page_number: number | null;
  position_on_page: number | null;
  status: string;
  asin: string;
  price_cents: number | null;
  image_url: string | null;
  run_id: string;
}

export interface AsinGroup {
  asin: string;
  image_url: string | null;
  keywords: string[];
  /** Group names (watchlist_item.group / snapshot.group) seen for this ASIN in the filtered rows. */
  groups: string[];
  /** Owner labels seen for this ASIN (snapshot.owner / watchlist_item.owner). */
  owners: string[];
  /** keyword → owner label (latest row with an owner). */
  keywordOwners: Record<string, string>;
}

export interface PivotResult {
  /** Flat keyword list (unique KW strings across groups; for filters/meta). */
  keywords: string[];
  days: string[];
  /** key = `${asin}||${keyword}||${day}` */
  cells: Map<string, PivotCell>;
  /** keyword → representative asin (first match; prefer asinGroups for display) */
  keywordAsin: Map<string, string>;
  /** keyword → product image_url from row (or null) */
  keywordImage: Map<string, string | null>;
  /** Rows grouped by ASIN, ordered by ASIN then keyword. */
  asinGroups: AsinGroup[];
}

function cellKey(asin: string, keyword: string, day: string): string {
  return `${asin}||${keyword}||${day}`;
}

export function ownerLabelOf(r: Pick<RankSnapshot, 'owner_id' | 'owner_name'>): string {
  return r.owner_id ? (r.owner_name || '').trim() || r.owner_id : '';
}

/** Distinct owners in the rows, for the owner filter dropdown. */
export function ownerOptions(rows: RankSnapshot[]): Array<{ id: string; label: string }> {
  const byId = new Map<string, string>();
  for (const r of rows) if (r.owner_id && (!byId.has(r.owner_id) || byId.get(r.owner_id) === r.owner_id)) byId.set(r.owner_id, ownerLabelOf(r));
  return Array.from(byId, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function matchesOwner(r: RankSnapshot, ownerId: string | undefined): boolean {
  if (!ownerId) return true;
  if (ownerId === '-') return !r.owner_id;
  return r.owner_id === ownerId;
}

function matchesGroupContains(r: RankSnapshot, groupContains: string): boolean {
  const q = groupContains.trim().toLowerCase();
  if (!q) return true;
  const hay = `${r.watchlist_id || ''}${r.group || ''}`.toLowerCase();
  return hay.includes(q);
}

export function applyFilters(
  rows: RankSnapshot[],
  filters: FilterState
): RankSnapshot[] {
  return rows.filter((r) => {
    if (filters.asins.length && !filters.asins.includes(r.asin)) return false;
    const asinQ = filters.asinContains.trim().toLowerCase();
    if (asinQ && !r.asin.toLowerCase().includes(asinQ)) return false;
    const kwQ = filters.keywordContains.trim().toLowerCase();
    if (kwQ && !r.keyword.toLowerCase().includes(kwQ)) return false;
    if (filters.dateFrom && r.snapshot_day < filters.dateFrom) return false;
    if (filters.dateTo && r.snapshot_day > filters.dateTo) return false;
    if (!matchesGroupContains(r, filters.groupContains)) return false;
    if (!matchesOwner(r, filters.ownerId)) return false;
    return true;
  });
}

export function buildPivot(
  rows: RankSnapshot[],
  filters: FilterState
): PivotResult {
  const filtered = applyFilters(rows, filters);

  const days = Array.from(new Set(filtered.map((r) => r.snapshot_day))).sort();
  const cells = new Map<string, PivotCell>();
  const keywordAsin = new Map<string, string>();
  const keywordImage = new Map<string, string | null>();
  /** `${asin}||${keyword}` → has at least one real rank */
  const pairHasRank = new Map<string, boolean>();
  /** asin → keywords set */
  const asinKw = new Map<string, Set<string>>();
  const asinImage = new Map<string, string | null>();
  const asinGroupNames = new Map<string, Set<string>>();
  const asinOwners = new Map<string, Set<string>>();
  /** `${asin}||${keyword}` → [day, owner label] of the latest row that has an owner */
  const pairOwner = new Map<string, [string, string]>();

  for (const r of filtered) {
    if (!keywordAsin.has(r.keyword)) {
      keywordAsin.set(r.keyword, r.asin);
      keywordImage.set(r.keyword, r.image_url ?? null);
    } else if (!keywordImage.get(r.keyword) && r.image_url) {
      keywordImage.set(r.keyword, r.image_url);
    }

    if (!asinKw.has(r.asin)) {
      asinKw.set(r.asin, new Set());
      asinImage.set(r.asin, r.image_url ?? null);
    } else if (!asinImage.get(r.asin) && r.image_url) {
      asinImage.set(r.asin, r.image_url);
    }
    asinKw.get(r.asin)!.add(r.keyword);
    if (r.group) {
      if (!asinGroupNames.has(r.asin)) asinGroupNames.set(r.asin, new Set());
      asinGroupNames.get(r.asin)!.add(r.group);
    }

    const pairKey = `${r.asin}||${r.keyword}`;
    const owner = ownerLabelOf(r);
    if (owner) {
      if (!asinOwners.has(r.asin)) asinOwners.set(r.asin, new Set());
      asinOwners.get(r.asin)!.add(owner);
      const prev = pairOwner.get(pairKey);
      if (!prev || r.snapshot_day >= prev[0]) pairOwner.set(pairKey, [r.snapshot_day, owner]);
    }
    const has =
      r.organic_rank != null &&
      Number.isFinite(r.organic_rank) &&
      r.status !== 'not_found';
    if (has) pairHasRank.set(pairKey, true);
    else if (!pairHasRank.has(pairKey)) pairHasRank.set(pairKey, false);

    cells.set(cellKey(r.asin, r.keyword, r.snapshot_day), {
      organic_rank: r.organic_rank,
      page_number: r.page_number,
      position_on_page: r.position_on_page,
      status: r.status,
      asin: r.asin,
      price_cents: r.price_cents,
      image_url: r.image_url ?? null,
      run_id: r.run_id,
    });
  }

  const asinGroups: AsinGroup[] = Array.from(asinKw.keys())
    .sort()
    .map((asin) => {
      let keywords = Array.from(asinKw.get(asin)!).sort();
      if (filters.onlyRankedKw) {
        keywords = keywords.filter((kw) =>
          pairHasRank.get(`${asin}||${kw}`)
        );
      }
      return {
        asin,
        image_url: asinImage.get(asin) ?? null,
        keywords,
        groups: Array.from(asinGroupNames.get(asin) ?? []).sort(),
        owners: Array.from(asinOwners.get(asin) ?? []).sort(),
        keywordOwners: Object.fromEntries(
          keywords.filter((kw) => pairOwner.has(`${asin}||${kw}`)).map((kw) => [kw, pairOwner.get(`${asin}||${kw}`)![1]])
        ),
      };
    })
    .filter((g) => g.keywords.length > 0);

  const keywords = Array.from(
    new Set(asinGroups.flatMap((g) => g.keywords))
  ).sort();

  return {
    keywords,
    days,
    cells,
    keywordAsin,
    keywordImage,
    asinGroups,
  };
}

export { cellKey };

/**
 * Date range after a (re)load. Empty → min→max (default). A range ending on the previous last day
 * extends to the new last day (a run that just finished adds today's column); a range starting on the
 * previous first day keeps starting on the first day. A custom range in the middle is left alone.
 */
export function nextDateRange<F extends Pick<FilterState, 'dateFrom' | 'dateTo'>>(
  f: F,
  prev: { minDay: string; maxDay: string },
  next: { minDay: string; maxDay: string }
): F {
  if (!f.dateFrom && !f.dateTo) return { ...f, dateFrom: next.minDay, dateTo: next.maxDay };
  const dateFrom = prev.minDay && f.dateFrom === prev.minDay ? next.minDay : f.dateFrom;
  const dateTo = prev.maxDay && f.dateTo === prev.maxDay ? next.maxDay : f.dateTo;
  return dateFrom === f.dateFrom && dateTo === f.dateTo ? f : { ...f, dateFrom, dateTo };
}
