# Rank Track — Table View Extension (heatmap)

KW × `snapshot_day` organic-rank heatmap for the owner’s Base. Reads **only** the `snapshot` table via `@lark-opdev/block-bitable-api`. Never invents `organic_rank`.

## Identity (from env, see ../.env.example)

| | |
|---|---|
| **App ID** | `LARK_APP_ID` |
| **BlockTypeID** | `BLOCK_TYPE_ID` (created in Developer Console) |
| **Base URL** | `RANKFLOW_BASE_URL` (optional "Open Base" link) |

Tables and fields are resolved **by name** at runtime (`src/data/schema.ts`); create them with `python3 backend/rankflow.py schema`.
The historical release notes below are kept for context; ids in them are placeholders.

## Layout (MVP)

- **Filter bar:** ASIN multi-select · date range · toggle **chỉ KW có rank** / tất cả
- **Grid:** rows = `keyword` · columns = `snapshot_day` · cell = `organic_rank` or `—` if `not_found` / null
- **Colors:** #1–10 dark green · 11–50 green · 51–190 yellow · ngoài/null gray · `unverified_*` light red
- **Click cell →** toast/detail: asin, price_cents, status, run_id

## DEMO mode

When the bitable-api host is unavailable (local `webpack` without Base iframe), the UI loads sample rows from `src/data/demo-snapshots.json` (copied from `docs/db/sync-export.json`) and shows a clear **DEMO** banner. Ranks are still only from that export — never fabricated.

## Prerequisites

- Node 18+ / npm 9+
- Lark Developer Tools CLI for upload: `npm i -g @lark-opdev/cli@latest`
- Logged in: `opdev login` (choose **Lark**, scan QR)

> `opdev create … -a bitable-extensions -s table-view` needs interactive login; this repo is a hand-built React+TS+Webpack project matching the published table-view structure (`app.json` + `block.json` + `@lark-opdev/block-bitable-webpack-utils`).

## Install & build

```bash
cd docs/lark-base/extension
npm install
npm run build
```

Dev (opens webpack-dev-server; expect **DEMO** outside Base):

```bash
npm start
# → http://localhost:8080
```

## Upload / publish (Base owner — console login required)

1. `opdev login` (Lark env).
2. From this folder:

```bash
npm run upload
# = npm run check && webpack --mode production
#   && opdev upload ./dist -t block -v $npm_package_version -d "Rank Track heatmap <version>"
# Bump "version" in package.json first — the block version must increase each upload.
# dist/project.config.json + dist/block.json are generated from ./app.json + ./block.json
# (build/opdev-manifest.js); `npm run check` fails the build if app/block/Base ids drift.
# If LARKSUITE_CLI_APP_SECRET is set in the shell, run: env -u LARKSUITE_CLI_APP_SECRET npm run upload
```

3. Developer Console → app `<LARK_APP_ID>` → **Multidimensional Table Add-In / Data Table View** → select uploaded widget version → save icon/name → **Version Management** → create app version → submit for admin approval if needed.
4. Open Base URL above → **Add plugin / Table View** → pick BlockTypeID `<BLOCK_TYPE_ID>`.

Permissions: grant bitable read (`bitable:app` or readonly) so `table.getRecords` works on `<TABLE_ID>`.
**Base sharing (required for Bộ key save by non-owners):** every ACME ORG member who adds ASIN/keyword must have **Can edit** on Base `<BASE_TOKEN>` (Share → group or person → Can edit). `Can view` alone yields Lark host error B4 on `addRecords`; the block maps that to a Vietnamese hint. Advanced permissions are off on this Base.

## Project layout

```
block-ui/
  app.json              # appId (single source of truth for the app)
  block.json            # blockTypeID + debug Base URL (single source of truth for the block)
  project.config.json   # opdev project file (kept equal to app.json/block.json by `npm run check`)
  package.json
  webpack.config.js     # HtmlWebpackPlugin + OpdevManifestPlugin
  build/opdev-manifest.js   # emits dist/project.config.json + dist/block.json; dev-server opdev middleware
  scripts/check-ids.js  # fails on app/block/Base/table id drift
  src/
    App.tsx             # filters + grid + toast
    config.ts           # IDs / field map
    data/loadSnapshots.ts   # bitable getRecords → DEMO fallback
    data/demo-snapshots.json
    components/FilterBar.tsx
    components/HeatmapGrid.tsx
    components/CellDetailToast.tsx
    utils/rankColor.ts
    utils/pivot.ts
    utils/cellValue.ts
```

## Sync DB → Base (data, not this UI)

```bash
python3 docs/lark-base/sync_db_to_base.py
```

Source of truth export: `docs/db/sync-export.json`.

## v0.2.0 — tab “Bộ key”
- Header tabs `Heatmap | Bộ key` (`#keyset` URL hash opens it directly — used for local demo screenshots).
- Groups from Base `watchlist_item` enabled rows (watchlist `team-a`) grouped by `group` (empty → per ASIN, “Nhóm n”); settings from Base `watchlist` (<TABLE_ID>).
- Lưu → confirm panel (thêm mới / bật lại / tắt / đổi nhóm / settings) → `addRecords` / `setRecords` (source=ui, updated_at ISO). Never deletes; removal = enabled=false. No crawl on save.
- Heatmap ASIN row has “✎ Bộ key” to jump + scroll to the group.
- DEMO (no Base host): read-only from `src/data/demo-watchlist.json`, Lưu disabled.
- Code: `src/components/KeySetPage.tsx`, `src/data/keyset.ts`.

## v0.2.1 — latest-run status line (2026-09-25)
- Compact line above both tabs: `Lần chạy gần nhất: <time ICT> · <status> · <found>/<total> cặp` (+ `· N lỗi/bị chặn` when `pairs_failed > 0`, `· ngoài Top: n`) · `Lần tới: <schedule_note>` · `Pull Base: <last_pulled_at>` · ↻ reload (header Refresh also reloads it).
- Styles: success/ok green · running blue · **partial or pairs_failed>0 = amber warning** · **failed = red** (+ `error` text line).
- Data: Base `crawl_run` latest row of `team-a` (by started_at) → status, pairs_total/found/not_found/failed, error; Base `watchlist` → schedule_note, last_pulled_at (fallback last_run_at/last_run_status). Text cells read via `asString` (segment arrays OK). Missing values show `—` (legacy ingest runs have NULL pairs_*). Legacy status `ok` is shown as `success`.
- DEMO: `src/data/demo-run-status.json` (real values copied from rank.db + Base on 2026-09-25 09:29 ICT).
- Code: `src/data/runStatus.ts`, `src/components/RunStatusLine.tsx`, CSS `.run-status` in `styles/app.css`.
- Screenshot: `screenshot-status-demo-1280.png` (DEMO, dark).
- Uploaded: `opdev upload ./dist -t block -v 0.2.1` → "Upload succeed" (2026-09-25 ~09:31 ICT). Still needs: console → select 0.2.1 in the Data Table View block → create app version → publish.

## v0.2.2 — "Chạy ngay" (2026-09-25) — REMOVED in 0.2.3 (dropped; Base run_request table unused)
- Button **▶ Chạy ngay** in the status line (both tabs) → `addRecord` on Base `run_request` (`<TABLE_ID>`): `request_id rr-YYYYMMDD-HHMMSS-xxxx`, `watchlist_id team-a`, `requested_by` = `bitable.bridge.getUserId()` (fallback `ui`), `requested_at` ICT ISO, `status pending`. Viewer's own Base permissions; no webhook/key in client code.
- Chip `Yêu cầu: đang chờ | đang chạy | xong · <result_status> | lỗi | đã gộp · <time ICT>` for the latest request of the watchlist (tooltip: request_id, run_id, note).
- Button disabled while the latest request is pending/claimed/running, while sending, and in DEMO. Status line auto-refreshes every 30 s while a request is active; heatmap reloads once when it finishes.
- Box side: `run_request_poller.py` (see `docs/PIPELINE.md`).
- Code: `src/data/runRequest.ts`, `src/components/RunStatusLine.tsx`, `config.ts` `RUN_REQUEST_*`. Screenshot: `screenshot-run-now-demo-1280.png`.
- Uploaded `opdev upload ./dist -t block -v 0.2.2` → "Upload succeed" (09:39 ICT).


## v0.2.5 — Chạy ngay wake webhook (2026-09-29)
- Sets `WAKE_WEBHOOK_URL` + `WAKE_WEBHOOK_AUTH` (Bearer) in `config.ts` for wake routine routine **Rank Track Chạy ngay wake**.
- `signalWake` POSTs JSON `{type, watchlist_id, request_id, source, requested_at}` with `Authorization` header.
- Base `run_request` write remains SoT; webhook is best-effort. Note field: "Chạy ngay (extension 0.2.5)".
- After upload: console → select **0.2.5** → create app version → publish. Then test Chạy ngay; interim 5-min pending poller can be paused once wake is solid.

## v0.2.4 — "Chạy ngay" restored (2026-09-29)
- Button **▶ Chạy ngay** on Bộ key **Lịch chạy** card + status line (both tabs).
- Click → `addRecord` on Base `run_request` (`<TABLE_ID>`): `request_id rr-YYYYMMDD-HHMMSS-xxxx`,
  `watchlist_id team-a`, `requested_by` = viewer user id (fallback `ui`), `requested_at` ICT ISO,
  `status pending`, `note` "Chạy ngay (extension 0.2.4)". Viewer's own Base permissions.
- Status chip: `idle | pending | running | done | failed` from latest `run_request` (+ watchlist last_run on status line).
- Button disabled while pending/claimed/running, while sending, and in DEMO. Status auto-refreshes every 30 s while active.
- **Wake:** wake routine → bot via `SendToAgent` with `{watchlist_id, request_id}` — see `docs/WAKE_CONTRACT.md`.
  Optional `WAKE_WEBHOOK_URL` in `config.ts` (empty = Base-only). **Do not** start `run_request_poller.py`.
- Code: `src/data/runRequest.ts`, `KeySetPage.tsx`, `RunStatusLine.tsx`, `App.tsx`, `config.ts` `RUN_REQUEST_*`.

## v0.2.3 — "Lịch chạy" (2026-09-25)
- Bộ key page → card **Lịch chạy**: on/off switch (`schedule_enabled`), weekday chips T2..CN = Mon..Sun (`schedule_days`,
  saved canonical `Tue,Wed,Thu,Fri`), time `HH:MM` 24h (`schedule_time`), label **Giờ Việt Nam (ICT, UTC+7)**, live `Lần tới: Thứ 3 09:55`.
- Saved with the same **Lưu** + confirm diff as keys → `setRecord` on Base `watchlist` row (schedule_* + display `schedule_note`
  + `updated_at` if that field exists). Status line `Lần tới` computed from the structured fields (ICT, independent of viewer TZ).
- DEMO: controls disabled. "Chạy ngay" button / run_request code removed (`src/data/runRequest.ts` deleted).
- Box side: cron pulls Base→DB 55 min before `schedule_time`, runs the pipeline at `schedule_time` (`PIPELINE.md` "Schedule contract").
- Screenshot: `screenshot-022-schedule-1280.png` (DEMO, dark).
- Uploaded `opdev upload ./dist -t block -v 0.2.3` → "Upload succeed" (2026-09-25 ~09:58 ICT). `-v 0.2.2` was rejected
  ("Version should be greater than the latest version: 0.2.2" — old Chạy ngay build). Still needs console: select 0.2.3 → create app version → publish.
