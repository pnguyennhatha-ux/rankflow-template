# RankFlow — setup from zero

Amazon keyword-rank tracking on Lark Base:

```
Lark Base (watchlist, watchlist_item, snapshot, crawl_run, run_request, member)
   ▲  block-ui (Table View Extension: heatmap + "Bộ key" editor + "Chạy ngay")
   │
backend/rankflow.py  (Python 3.11+, stdlib only, SQLite; Base <-> local DB sync, scheduler, worker API)
   ▲  HTTP (worker token)
extension/  (Chrome MV3 "2J" worker built with WXT: crawls amazon.com SERPs in the user's Chrome)
```

Follow the steps **in order**. Nothing writes to Lark until `RANKFLOW_LIVE_ENABLED=1`.

---

## 0. Prerequisites
- Python ≥ 3.11, Node ≥ 20, Google Chrome (signed-in desktop profile), a Lark (or Feishu) tenant where you may create custom apps.
- `cp .env.example .env` at the repo root. Everything below fills in this one file.

## 1. Create the Lark app (Developer Console)
1. https://open.larksuite.com/app → **Create custom app** (name e.g. "RankFlow"). Copy **App ID** → `LARK_APP_ID`, **App Secret** → `LARK_APP_SECRET` (keep it only in `.env` / env; never in the block or extension).
2. **Permissions & Scopes** — add (tenant + user where offered):
   - `bitable:app` (read/write Base records, tables, fields)
   - `contact:user.base:readonly`, `contact:contact.base:readonly`, `contact:department.base:readonly` (member list for the owner picker; no email scope needed — emails are never stored)
3. **Contact range / data permissions**: set the range to the departments (or "All members") whose people should appear in the owner picker. ⚠ The app token only sees people inside this range — see pitfalls.
4. **Features → Base (Bitable) extension / Table View**: enable it (needed for the block in step 4).
5. **Version Management → Create version → Publish**. Ask the tenant admin to approve. Scopes/range changes only take effect after a published version.

## 2. Install and log in to lark-cli (user identity)
The backend uses your **user** login (via `lark-cli`) to list the whole org for the member table, because the app's contact range is usually narrower.
```bash
# install the Lark CLI so that `lark-cli` is on PATH (or set RANKFLOW_LARK_CLI=/path/to/lark-cli)
lark-cli auth login          # log in as yourself against the same app (LARK_APP_ID)
```
Renew with `lark-cli auth login` when member sync logs "refresh token expired" (see §9).

## 3. Create the Base and its schema
1. In Lark create an empty Base. Copy the token from its URL (`…/base/<TOKEN>?table=…`) → `LARK_BASE_TOKEN`. Optionally put the full URL in `RANKFLOW_BASE_URL`.
2. Add the app to the Base: Base `…` menu → **Add document app / Advanced permissions → add app** "RankFlow" with **edit** access (otherwise API calls fail with permission errors).
3. Preview the schema (offline, no network):
   ```bash
   python3 backend/rankflow.py schema --create --dry-run      # plan only (default)
   python3 backend/rankflow.py schema --print-json            # full table/field definitions (also in lark-schema/schema.json)
   python3 backend/rankflow.py schema --online                # read-only diff against your Base
   ```
4. Create it (the only command here that writes):
   ```bash
   RANKFLOW_LIVE_ENABLED=1 python3 backend/rankflow.py schema --online --create --no-dry-run
   ```
   Tables: `watchlist`, `watchlist_item` (incl. `owner` person field), `snapshot` (incl. `owner`, `group`), `crawl_run` (incl. `groups`, `owners`), `run_request`, `member` (name/avatar only, **no email**). Table and field ids are never hard-coded — backend and block resolve them **by name**, so do not rename columns (or pin ids with `RANKFLOW_TABLE_*`).
5. Delete the empty default table Lark created with the Base, and add one `watchlist` row (see `lark-schema/watchlist-seed.json`, `watchlist_id = default`).

## 4. Block (heatmap Table View Extension)
1. Developer Console → your app → **Base extension / Table view** → **Create block**. Copy the **Block ID** (`blk_…`) → `BLOCK_TYPE_ID` in `.env`.
2. Build and upload (needs `opdev`: `npm i -g @lark-opdev/cli@latest`, then `opdev login`, choose Lark):
   ```bash
   cd block-ui && npm ci
   npm test                       # id guard + typecheck + owner logic tests
   npm run upload                 # STRICT build (fails if LARK_APP_ID / BLOCK_TYPE_ID missing) + opdev upload ./dist
   ```
   `app.json` / `block.json` only hold placeholders; the build injects ids from `.env` into `dist/`.
3. **You** publish it: Developer Console → block → select the uploaded version → Version Management → create + publish app version.
4. Open the Base → **Add view / extension** → pick the block on the `snapshot` table.
5. **Share** the Base with every person who edits key sets with **Can edit** (Share → people/department/whole org). View-only users can see the heatmap but cannot save (B4 error).

## 5. Backend
```bash
# fill RANKFLOW_WORKER_TOKEN / RANKFLOW_ADMIN_TOKEN: openssl rand -hex 32 (two different values)
python3 -m unittest discover -s backend -t .        # offline tests
python3 backend/rankflow.py doctor                  # read-only DB + Lark check
python3 backend/rankflow.py serve                   # listens on RANKFLOW_HOST:PORT (default 127.0.0.1:8787)
```
Keep `RANKFLOW_LIVE_ENABLED=0` until step 7. For a server install use `deploy/` (systemd unit + env example). Expose remote workers only through an HTTPS reverse proxy; never open the port directly.

## 6. Chrome extension (worker "2J")
```bash
cd extension && npm ci && npm test && npm run build      # output: extension/.output/chrome-mv3
```
`chrome://extensions` → Developer mode → **Load unpacked** → `extension/.output/chrome-mv3`. Open the popup → backend URL (`http://127.0.0.1:8787` or your HTTPS URL) + **worker token** (never the admin token or app secret). Keep the crawl window **normal, not minimized** (see pitfalls). Chrome assigns a random extension id per unpacked path; nothing in the code depends on it.

## 7. Acceptance run
1. In the block's **Bộ key** page add 1 ASIN with 3–4 keywords (owner optional), save.
2. **Live off** (`RANKFLOW_LIVE_ENABLED=0`): `python3 backend/rankflow.py groups list`, then `python3 backend/rankflow.py run-now --watchlist default`. The extension picks the job up; check `python3 backend/rankflow.py runs` — results land in SQLite only, nothing in Base.
3. **Live on**: set `RANKFLOW_LIVE_ENABLED=1`, restart `serve`, press **Chạy ngay** in the block (writes a `run_request`). Expect: `run_request` → claimed/running/done, a `crawl_run` row, `snapshot` rows, heatmap cells for today. Spot-check one rank by hand on amazon.com with the same ZIP.

## 8. Daily operation
- Schedule per watchlist in the block (`schedule_enabled`, days, `HH:MM` in `RANKFLOW_TIMEZONE`).
- `python3 backend/rankflow.py members sync --dry-run` → then without `--dry-run` (live) to refresh the owner picker (also runs automatically after `serve` starts and daily).

## 9. Token renewal
- **Tenant token**: the backend fetches/refreshes `tenant_access_token` from app id/secret automatically (2 h lifetime).
- **App secret rotated** in the console → update `.env`, restart `serve`.
- **User token** (lark-cli, member sync of the whole org): when sync warns "refresh token expired" re-run `lark-cli auth login`. Existing members are kept (no deactivation) while it fails.
- **opdev** login expires → `opdev login` again before uploading a new block version.
- **Worker token**: rotate both in `.env` and the extension popup together.

## Known pitfalls
- **Block error "B4" / "Something went wrong" on save** = the user has **view-only** permission on the Base. Share with **Can edit**.
- **URL fields need `{text, link}`** objects in the Bitable v1 API; a bare string fails with `1254068 URLFieldConvFail` (handled in `Lark.encode`).
- **Outbox order is snapshots → runs → requests**: snapshots are written first so a `crawl_run` / `run_request` never says "done" before its data is in Base. Don't reorder; a request is finalized only after its snapshots synced (or exhausted retries).
- **App contact range limits member sync**: the app token only sees people inside its contact range → use the lark-cli **user token** (`members sync --source auto|user`) for the whole org.
- **Sponsored banners count**: Amazon top brand banners / sponsored carousels are not organic tiles; the parser skips `AdHolder`/`sspa`/label-classed ads so organic rank is not shifted. If Amazon changes layout, check `extension/src/serp.ts` tests before trusting ranks.
- **Minimized window**: Chrome throttles/blocks rendering in minimized windows, so crawls stall or time out. Keep the crawl window open (it can be behind other windows) and the machine awake.
- **People field ids are app-scoped**: `owner` open_ids (`ou_…`) belong to *this* app; switching apps invalidates stored owners.
- Do not rename Base tables/columns: everything is matched by name.
