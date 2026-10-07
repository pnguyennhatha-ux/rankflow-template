# RankFlow v2 — independent scheduled rank crawler

This is the backend and Chrome crawler. The Base block writes `watchlist_item`, `watchlist`, and `run_request`; this service reads them and writes `snapshot` and `crawl_run` back. Tables/fields are resolved by NAME; create them with `python3 backend/rankflow.py schema` (see ../SETUP.md).

## Architecture

```text
Lark Base UI → watchlist_item / watchlist / run_request
                  ↓ poll every minute (bot credential, only when live enabled)
Python service → SQLite runs, keyword jobs, snapshots, retrying sync outbox
                  ↓ authenticated claim + 10-minute renewable lease
Chrome MV3 worker → Amazon pages → authenticated result
                  ↓
SQLite commit → Lark Base snapshot + crawl_run + run_request + watchlist status
                  ↓
RankFlow_V2 Heatmap UI (after publishing and installing the updated block)
```

The scheduler and SQLite database, not the Chrome service worker or an agent, own the schedule and job state. Jobs are idempotent by source key. A worker crash causes lease expiry and reassignment (maximum three attempts). Explicit crawl errors get bounded retries. Base writes are retried from the SQLite outbox; snapshot and run sync check existing remote `run_id` keys first. CAPTCHA/parser uncertainty is never represented as a numeric rank.

## Status

Implemented and locally tested: backend API, schedule/request ingestion, SQLite job queue, claim/heartbeat/result protocol, retry/outbox, Base schema mapping, Chrome worker, and admin command API. A separate Base with five empty tables was created by bot; the old Base was not modified. **No live crawl, record sync, or Chrome installation has been performed.** `RANKFLOW_LIVE_ENABLED=0` is the default. The old wake webhook and its client-side token are not used.

Known limits before production: Chrome/Amazon crawl and ZIP selection need interactive validation in a real browser; Lark OpenAPI writes need a bot-credential smoke test; the Chrome MV3 worker may be interrupted during long keyword scans, which are recovered by lease/retry but not checkpointed mid-page. Run one controlled watchlist first. Amazon may change markup or issue CAPTCHA. The worker intentionally reports `unverified_*` instead of inventing a rank.

The new Base UI bundle must be uploaded, published in Lark Developer Console, and installed into the new Base before its Heatmap can be used. The source disables the legacy wake-webhook call; RankFlow v2 picks up `run_request` rows directly. Keep the old Base automation separate and do not enable the new schedule before acceptance testing.

## Local setup (Windows or Linux, Python 3.11+)

1. Copy `.env.example` to `.env` in this folder. Generate two distinct random tokens of at least 24 characters. Do not commit `.env` or put `LARK_APP_SECRET` in Chrome. Set `RANKFLOW_DB` to a persistent path, not a temporary directory.
2. Run `python backend/rankflow.py doctor` for a read-only DB/Lark check, then start `python backend/rankflow.py serve`. It listens on `127.0.0.1:8787` by default. `GET /health` returns `{"ok":true}`. `python backend/rankflow.py status` shows local DB state.
3. Open `chrome://extensions`, enable Developer mode, and “Load unpacked” from `extension/.output/chrome-mv3` (build with `npm run build` in `extension/`). In the popup enter the backend URL and worker token. Chrome must remain running in a signed-in desktop session for this browser-based crawler.
4. For a remote Linux backend, place a trusted HTTPS reverse proxy in front of it, expose only the required API, and enter that HTTPS origin in the popup. Do not expose the plain HTTP backend or its admin token to the internet. A Linux-only worker also needs a managed Chromium/Chrome browser session with the extension installed.
5. After read-only schema/auth verification and one controlled manual run, configure `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_BASE_TOKEN`, then explicitly set `RANKFLOW_LIVE_ENABLED=1` and restart. This enables Base polling and writes. Keep new `watchlist.schedule_enabled=false` until acceptance testing passes.

Acceptance checklist: (a) doctor shows all five tables and expected fields, (b) one manual job is claimed by Chrome and produces a real Amazon result, (c) the matching `snapshot`, `crawl_run`, and UI Heatmap update, (d) worker restart during a job retries without duplicate Base rows, (e) a scheduled test fires once in the chosen timezone, (f) an unavailable Lark API leaves outbox backlog that later drains. Only then enable the live schedule.

### Synthetic heatmap fixture (not Amazon ranks)

The new Base contains a clearly marked test fixture for 2026-09-17 through 2026-10-01: 26 `watchlist_item` pairs, 15 `crawl_run` rows and 390 `snapshot` rows. The exact batch inputs are in `lark-schema/demo-data/`. Fixture items use `source=synthetic_test`; runs use the `demo-synthetic-` prefix and a `SYNTHETIC TEST DATA` note. The 11 cat-costume keywords for `B0TEST0001` were supplied by the user. Halloween keywords for the other five ASINs are arbitrary UI samples, not verified product matches. These rankings must never be treated as observed Amazon data or used in reporting. The schedule remains disabled. Remove or archive the fixture before production use.

### Manual automation API

`POST /api/runs` with header `X-Admin-Token: <admin token>`:

```json
{
  "source_key": "automation:2026-10-01:team1",
  "watchlist_id": "team-a",
  "pairs": [{"asin": "B012345678", "keyword": "straw cup", "group": "test"}],
  "settings": {"zip": "10001", "top_n": 100, "sponsored": false}
}
```

The same `source_key` returns the existing run ID, so callers can retry safely. `GET /api/status` also requires the admin token. Worker endpoints require the separate worker token; never share the admin token with Chrome. Manual API runs are persisted locally even when Base sync is disabled.

For local scripts, save the same JSON payload in a file and run `python backend/rankflow.py enqueue --file job.json`. This writes directly to SQLite; the service and Chrome worker will pick it up. Keep a stable `source_key` for idempotent retries.

### v2.2: groups end to end, on-demand worker

- **Group names flow through:** the block UI “Bộ key” group → `watchlist_item.group` → backend groups → job targets → 2J (dashboard, results) → snapshot `grp` (Base field `group`) and crawl_run `groups` (+ a scope note). Both Base columns are **optional**: they are resolved by name and skipped while missing. Create them at go-live (after approval) with `RANKFLOW_LIVE_ENABLED=1 python3 backend/rankflow.py lark-fields --create`; `lark-fields` without `--create` only lists what is missing. `doctor` reports `lark_optional_missing`.
- **Long-poll:** `GET /job?wait=N` (N ≤ 25) holds the request until a run is queued (woken immediately by enqueue/run-now) and answers 204 otherwise. Every `/job` reply carries `X-Groups-Version` so the worker refetches `/worker/groups` only when groups change.
- **2J v0.3 idle behaviour:** a `chrome.alarms` tick every 30 s starts one `GET /job?wait=20`; no Amazon tab is opened unless a job is claimed; run-now from block/CLI/API is picked up within ~1 s while the long-poll is open (≈2/3 of the time) and ≤10 s otherwise.
- **Throttle:** `RANKFLOW_2J_CONCURRENCY` default **2**, capped at 2 (2J v0.3.1 crawls with 2 slots on 2 reused tabs). The worker waits a random page/keyword delay before every Amazon navigation: since the previous navigation of any slot (staggered) and since that slot's previous page finished loading; a CAPTCHA pauses both slots. Tile/sponsored counting rule: see `rankflow-ext/README.md`. `POST /result` stores the worker `meta` (timing per keyword, navigation gaps, tile layout, sponsored traces) and `warnings`; inspect with `python3 backend/rankflow.py runs <run_id>`.

### v2.3: owner (Lark person) end to end

- **Input:** `watchlist_item.owner` (Lark *User* field, single person, `<FIELD_ID>`). The backend pull stores `owner_id` (open_id, app-scoped to `<LARK_APP_ID>`), `owner_name` and `owner_email` (when Lark returns it) per pair; Base stays the source of truth (an owner changed/removed in Base wins on the next pull). Owner may be empty.
- **Flow:** owner → `enabled_pairs` → job targets → 2J job groups (`owner: {id, name}`; groups are keyed by ASIN + group + owner) → 2J dashboard/results/CSV/Excel → snapshot `owner` (User, single) on every new row and crawl_run `owners` (User, multiple). Both result columns are optional (resolved by name) and created idempotently by `lark-fields --create` (`type_mismatch` is reported, never changed).
- **Lark write format:** user cells are written as `[{"id": "ou_…"}]` (`[]` clears). Verified with a real write + read-back.
- **CLI/API:** `groups add|set … --owner <ou_… | name | ->`. A name resolves against the org member list (`members sync`) and existing owners; emails are not stored anywhere; `-` clears; omitting `--owner` leaves the existing owner untouched (Base is never cleared by accident). Import CSV accepts an `owner` column (`asin,keyword,group,owner`), JSON accepts `owner` on a group/item/pair; `POST /api/groups` accepts `owner` (top level or per item). Unknown/ambiguous names are rejected with HTTP 400 / an error.
- **Backfill:** `python3 backend/rankflow.py lark-backfill-owner` (dry run) / `RANKFLOW_LIVE_ENABLED=1 … lark-backfill-owner --write` fills only EMPTY `snapshot.owner` from the current `watchlist_item.owner` of the same ASIN + keyword.
- **Org member list (owner picker):** `python3 backend/rankflow.py members sync [--source auto|app|user] [--dry-run]`. `auto` (default, also used by `serve` 5 s after start and every `RANKFLOW_MEMBER_SYNC_HOURS`, default 24) merges by open_id: (1) the app tenant token's contact range (`/contact/v3/scopes`, departments walked recursively — today 4 people, with status) and (2) the **lark-cli user identity** (the owner's login on the same app `<LARK_APP_ID>`, scopes `contact:contact.base:readonly` + `contact:user.base:readonly`): department 0 + every sub-department (`departments/0/children?fetch_child=true`), `users/find_by_department`, paginated — the whole ACME ORG. Both sources use the same app, so open_ids are identical (checked on every run: `merge.open_id_matched`) and valid for User-field writes. Output: local cache + Base table `member` (`<TABLE_ID>`: name, open_id, person (User), en_name, avatar_url, departments, active, updated_at) — **name + avatar only, no email anywhere** (a legacy `email` column is deleted). Idempotent; people who disappear get `active=false` (never deleted). If the user listing fails (e.g. lark-cli refresh token expired — re-run `lark-cli auth login`), a warning is logged and existing rows are kept (no deactivation). `members list` shows the cache; the block's “Bộ key” cards read `member` for a searchable owner select (name / English name / department).
- **Notify the owner:** in Base → Automations: trigger “When a record is added” on `snapshot` (optionally with condition `owner` is not empty) → action “Send Lark message” to the person in field `owner` (e.g. “{keyword} · {asin}: rank {organic_rank} ({position_on_page}) · {status}”). For one message per run instead of per row, trigger on `crawl_run` when `status` changes to success/partial and send to `owners`.

### 2J worker + group management (v2.1)

Groups (ASIN × keyword pairs) live in the local DB and are mirrored to Base `watchlist`/`watchlist_item` (Base writes only when `RANKFLOW_LIVE_ENABLED=1`). Deletes are soft (`enabled=false`). Keyword display case is kept; matching is case-insensitive.

CLI (`python3 backend/rankflow.py …`, default watchlist `team-a`):

```sh
groups add --group Mugs --asin B0TEST0008 --keyword "Halloween Mug" --keyword "gift mug"
groups add --group Mugs --asin B0AAAAAAAA --keywords "halloween mug; spooky mug"
groups add --group Mugs --asin B0AAAAAAAA --keyword "gift mug" --owner "Hana Nguyen"   # or --owner ou_… ; --owner - clears
groups list [--all] [--json]
groups set --group Mugs --asin B0TEST0008 --keywords "a;b"   # replace the group's pairs
groups rm --group Mugs [--asin B0…] [--keyword "gift mug"]    # soft delete
groups import --file pairs.csv [--replace]                   # CSV asin,keyword[,group][,owner] or JSON
watchlist set --zip 10001 --top-n 250 --sponsored off ; watchlist show
run-now [--group Mugs] ; runs [RUN_ID] ; cancel RUN_ID ; status ; doctor
```

Admin API (`X-Admin-Token`): `GET /api/groups[?all=1]`, `POST /api/groups` (add), `PUT /api/groups/{group}` (replace), `DELETE /api/groups/{group}[?asin=&keyword=]`, `POST /api/items/delete`, `POST /api/import {format,data,replace}`, `POST /api/run-now {group?}`, `GET|PUT /api/watchlists/{id}`, `GET /api/runs/{id}`, `POST /api/runs/{id}/cancel`, `GET /api/status`.

Worker API used by 2J (`X-Worker-Id`, plus `X-Worker-Token` unless loopback): `GET /job` (200 job / 204), `POST /job/heartbeat {lease_token,progress}`, `POST /result {lease_token,run_id,rows,warnings}`, `POST /job/fail {lease_token,error,rows}` (finished keywords are kept, the rest re-queued; CAPTCHA errors back off 10 min × attempt), `GET /worker/groups`, `GET /worker/status`, `POST /worker/run-now`. A 409 means the lease is gone (the extension stops). Snapshots store `page_number` and `position_on_page` as `#pos Ppage` (e.g. `#18 P4`).

### Deployment shape

- **Windows Chrome + backend on the same machine:** run backend at system startup with Task Scheduler (restart on failure), keep a Chrome user session open with extension enabled. This is the easiest first acceptance target.
- **Linux backend + Windows Chrome:** run Python service under systemd using a persistent data directory and HTTPS reverse proxy. Windows Chrome worker connects to its HTTPS endpoint. Agent involvement is not required for scheduled runs.
- **Linux only:** install a managed graphical Chrome/Chromium session and the extension; verify restart/login behavior and CAPTCHA handling separately. A headless Python process alone cannot execute this extension's `chrome.tabs`/`chrome.scripting` crawl path.

The sample `deploy/rankflow.service.example` is a template; adjust user, paths, and HTTPS proxy. Keep the bot credential in an access-restricted `.env` file. Back up the SQLite DB (including `-wal`/`-shm` while running, or use SQLite's backup API). Watch `/api/status` for queued/leased jobs, failed runs and outbox backlog; add external alerting before unattended production use.

## Tests

From this folder:

```sh
python -m unittest discover -s backend -t . -v
```

`backend/test_twoj.py` covers group add/delete/import, run-now, the enqueue → `/job` → `/result` round trip with the real 2J fixture, partial fail + CAPTCHA backoff, watchdog re-queue, cancel, `#pos Ppage` mapping, Base mirroring (fake Lark), HTTP auth/CORS and the CLI. `backend/test_groupflow.py` covers group names on snapshots/crawl_run, the long-poll and optional Base fields. The redesigned extension lives in `/workspace/projects/rankflow-ext` (build: `build-v3/chrome-mv3`; `build-v2` kept); `chrome-extension/` here is the older worker and should not be loaded at the same time.

The tests cover idempotent enqueue, keyword grouping, lease ownership, retry/failure, local outbox, fake Base pull/sync, field-name mapping, and an HTTP enqueue→claim→complete loop. They do **not** substitute for real Chrome/Amazon and Lark API smoke tests.

