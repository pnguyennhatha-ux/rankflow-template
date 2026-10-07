/** One rank snapshot row — values come ONLY from API / export, never invented. */
export interface RankSnapshot {
  snapshot_day: string; // YYYY-MM-DD
  asin: string;
  keyword: string;
  /** Present only when status implies a real rank; never fabricated in UI. */
  organic_rank: number | null;
  page_number: number | null;
  position_on_page: number | null;
  status: string;
  price_cents: number | null;
  image_url?: string | null;
  run_id: string;
  marketplace?: string;
  zip?: string;
  /** Enriched from watchlist_item or crawl_run — never invented. */
  watchlist_id?: string | null;
  /** snapshot.group (group at crawl time) when that column exists, else watchlist_item.group — may be null. */
  group?: string | null;
  /** snapshot.owner (owner at crawl time) when set, else current watchlist_item.owner — Lark user open_id / name. */
  owner_id?: string | null;
  owner_name?: string | null;
}

export type DataSourceMode = 'bitable' | 'unavailable';

export type ThemeMode = 'dark' | 'light';

export interface LoadResult {
  rows: RankSnapshot[];
  mode: DataSourceMode;
  error?: string;
}

export interface FilterState {
  asins: string[]; // empty = all
  dateFrom: string; // YYYY-MM-DD or ''
  dateTo: string;
  /** true = chỉ KW có rank (at least one non-null organic_rank in range) */
  onlyRankedKw: boolean;
  /** GRID: asin includes (case-insensitive). Applied on Enter / Lọc. */
  asinContains: string;
  /** GRID: keyword includes (case-insensitive). Applied on Enter / Lọc. */
  keywordContains: string;
  /** GRID: watchlist_id|group includes (case-insensitive). Applied on Enter / Lọc. */
  groupContains: string;
  /** '' = all owners, '-' = rows without owner, else owner open_id. */
  ownerId: string;
}

export interface CellDetail {
  keyword: string;
  snapshot_day: string;
  asin: string;
  organic_rank: number | null;
  page_number: number | null;
  position_on_page: number | null;
  status: string;
  price_cents: number | null;
  image_url?: string | null;
  run_id: string;
}
