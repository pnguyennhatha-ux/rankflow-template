/**
 * Block configuration. Nothing here is user-specific:
 *  - APP_ID / BLOCK_TYPE_ID / BASE_URL / DEFAULT_WATCHLIST_ID / ORG_LABEL are injected at build time from env
 *    (see block-ui/.env.example and webpack DefinePlugin).
 *  - Table ids and field ids are resolved by NAME at runtime (resolveSchema() in src/data/schema.ts).
 *    The *_FIELDS maps below start out holding the Base column NAMES and are rewritten in place to field ids.
 */
declare const process: { env: Record<string, string | undefined> };
export const APP_ID = process.env.LARK_APP_ID || '';
export const BLOCK_TYPE_ID = process.env.BLOCK_TYPE_ID || '';
/** Default organic crawl depth (watchlist.top_n) when the Base row has no value; matches backend DEFAULT_TOP_N. */
export const DEFAULT_TOP_N = Number(process.env.DEPTH || 190) || 190;
/** Optional "Open Base" link, e.g. https://<tenant>.larksuite.com/base/<base_token>. */
export const BASE_URL = process.env.RANKFLOW_BASE_URL || '';
/** Display name of the organisation in the owner picker hint (optional). */
export const ORG_LABEL = process.env.RANKFLOW_ORG_LABEL || 'tổ chức';

/** Base table names (must match backend TABLE_NAMES / `rankflow.py schema`). */
export const TABLE_NAMES = {
  snapshot: 'snapshot',
  watchlist_item: 'watchlist_item',
  watchlist: 'watchlist',
  crawl_run: 'crawl_run',
  run_request: 'run_request',
  member: 'member',
} as const;

/** Filled by resolveSchema(); live ES-module bindings, so importers see the resolved ids. */
export let SNAPSHOT_TABLE_ID = '';
export let WATCHLIST_TABLE_ID = '';
export let CRAWL_RUN_TABLE_ID = '';
export let MEMBER_TABLE_ID = '';
export let WATCHLIST_SETTINGS_TABLE_ID = '';
export let RUN_REQUEST_TABLE_ID = '';
export function setTableIds(ids: Partial<Record<keyof typeof TABLE_NAMES, string>>): void {
  SNAPSHOT_TABLE_ID = ids.snapshot || SNAPSHOT_TABLE_ID;
  WATCHLIST_TABLE_ID = ids.watchlist_item || WATCHLIST_TABLE_ID;
  CRAWL_RUN_TABLE_ID = ids.crawl_run || CRAWL_RUN_TABLE_ID;
  MEMBER_TABLE_ID = ids.member || MEMBER_TABLE_ID;
  WATCHLIST_SETTINGS_TABLE_ID = ids.watchlist || WATCHLIST_SETTINGS_TABLE_ID;
  RUN_REQUEST_TABLE_ID = ids.run_request || RUN_REQUEST_TABLE_ID;
}

/** Field ids under tables.snapshot.fields */
export const SNAPSHOT_FIELDS = {
  price_cents: 'price_cents',
  marketplace: 'marketplace',
  snapshot_day: 'snapshot_day',
  image_url: 'image_url',
  run_id: 'run_id',
  zip: 'zip',
  status: 'status',
  organic_rank: 'organic_rank',
  position_on_page: 'position_on_page',
  asin: 'asin',
  keyword: 'keyword',
};

/** Field ids under tables.watchlist_item.fields */
export const WATCHLIST_FIELDS = {
  asin: 'asin',
  keyword: 'keyword',
  watchlist_id: 'watchlist_id',
  group: 'group',
  enabled: 'enabled',
  updated_at: 'updated_at',
  source: 'source',
  /** Lark "User" (person) field, single — owner per pair. Carried to snapshot.owner / crawl_run.owners by the backend. */
  owner: 'owner',
};

/** Optional result columns written by the backend (resolved by name, like snapshot.group). */
export const SNAPSHOT_OWNER_FIELD = 'owner';

/**
 * tables.member — name + avatar only (no email, by design). Org member list (Lark contact via the app token + lark-cli user identity) synced by the backend
 * (`rankflow.py members sync`, at serve start + daily). Source of the owner picker. Resolved by name.
 */
export const MEMBER_TABLE_NAME = 'member';
export const MEMBER_FIELDS = {
  name: 'name',
  open_id: 'open_id',
  person: 'person',
  en_name: 'en_name',
  avatar_url: 'avatar_url',
  departments: 'departments',
  active: 'active',
};

/** tables.watchlist — shared settings per key set (one row per watchlist_id). */
export const WATCHLIST_SETTINGS_FIELDS = {
  watchlist_id: 'watchlist_id',
  name: 'name',
  marketplace: 'marketplace',
  zip: 'zip',
  top_n: 'top_n',
  sponsored: 'sponsored',
  schedule_note: 'schedule_note',
  updated_at: 'updated_at',
  /** Text ICT ISO — written by pull_base_to_db.py (v0.2.1) */
  last_pulled_at: 'last_pulled_at',
  /** Text ICT ISO — derived by sync_db_to_base.py from latest crawl_run */
  last_run_at: 'last_run_at',
  /** Text — latest crawl_run.status (derived by sync_db_to_base.py) */
  last_run_status: 'last_run_status',
  /** Structured schedule — contract in PIPELINE.md "Schedule contract".
   *  Box cron pulls Base→DB 55 min before schedule_time, then runs run_pipeline.py at schedule_time. */
  /** Checkbox: cron runs the pipeline automatically on schedule */
  schedule_enabled: 'schedule_enabled',
  /** Text 'Tue,Wed,Thu,Fri' (Mon..Sun, comma, Mon-first) */
  schedule_days: 'schedule_days',
  /** Text 'HH:MM' 24 h, ICT (UTC+7) */
  schedule_time: 'schedule_time',
};

/** Default key set edited on the "Bộ key" page. */
export const DEFAULT_WATCHLIST_ID = process.env.RANKFLOW_DEFAULT_WATCHLIST || 'default';

/** Field ids under tables.crawl_run.fields */
export const CRAWL_RUN_FIELDS = {
  run_id: 'run_id',
  watchlist_id: 'watchlist_id',
  marketplace: 'marketplace',
  zip: 'zip',
  top_n: 'top_n',
  sponsored: 'sponsored',
  started_at: 'started_at',
  finished_at: 'finished_at',
  /** Select: running | success | partial | failed (legacy: ok = success, pending) */
  status: 'status',
  note: 'note',
  pairs_total: 'pairs_total',
  pairs_found: 'pairs_found',
  pairs_not_found: 'pairs_not_found',
  /** blocked/errored keywords — distinct from not_found */
  pairs_failed: 'pairs_failed',
  error: 'error',
};

/** tables.run_request — 'Chạy ngay' queue (v0.2.5). SoT for on-demand runs.
 *  Extension writes pending; wake routine wakes bot (WAKE_CONTRACT.md). No 2-min poller. */
export const RUN_REQUEST_FIELDS = {
  request_id: 'request_id',
  watchlist_id: 'watchlist_id',
  requested_by: 'requested_by',
  requested_at: 'requested_at',
  /** Select: pending | claimed | running | done | failed | cancelled */
  status: 'status',
  run_id: 'run_id',
  result_status: 'result_status',
  note: 'note',
  started_at: 'started_at',
  finished_at: 'finished_at',
  exit_code: 'exit_code',
};

/** HTTP wake for wake routine routine Rank Track Chạy ngay wake (v0.2.5). */
export const WAKE_WEBHOOK_URL = '';
/** Bearer for the webhook (Authorization header). Required by the wake webhook. */
export const WAKE_WEBHOOK_AUTH = '';

export type SnapshotFieldKey = keyof typeof SNAPSHOT_FIELDS;
