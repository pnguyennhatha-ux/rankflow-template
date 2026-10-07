# RankFlow (template)

Amazon keyword-rank tracker on Lark Base: Python backend + Base heatmap block + Chrome (MV3) crawler.
Clean, user-independent template — all ids/credentials come from `.env` (see `.env.example`), tables/fields are resolved by name.

## Quick start

```bash
git clone https://github.com/pnguyennhatha-ux/rankflow-template.git
cd rankflow-template
```

Then follow [SETUP.md](SETUP.md) to set everything up from zero.

**Start with [SETUP.md](SETUP.md).**

| Path | What |
|---|---|
| `backend/rankflow.py` | backend + CLI (`serve`, `schema`, `doctor`, `groups`, `run-now`, `members`, …); tests `backend/test_*.py` |
| `block-ui/` | Lark Base Table View Extension (React + webpack, `opdev upload`) |
| `extension/` | Chrome MV3 worker "2J" (WXT + React), build → `extension/.output/chrome-mv3` |
| `lark-schema/schema.json` | generated Base schema (`rankflow.py schema --print-json`) |
| `deploy/` | systemd unit + server env example |
| `docs/` | backend and block reference notes (historical changelog included) |

Quick checks: `python3 -m unittest discover -s backend -t .` · `cd block-ui && npm ci && npm test && npm run build` · `cd extension && npm ci && npm test && npm run build`.
