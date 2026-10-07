# RankFlow v2 — Ubuntu deployment

This package runs the scheduler/API on Ubuntu. The Chrome MV3 worker still needs a persistent Chrome/Chromium session; a headless Python process cannot crawl Amazon by itself.

## 1. Copy only the clean runtime

From the repository root, copy these paths to `/opt/rankflow`:

```text
backend/rankflow.py
backend/__init__.py
extension/ (built: extension/.output/chrome-mv3)
deploy/rankflow.service.example
deploy/rankflow.env.example
```

Do not copy `.env`, `*.sqlite3`, `backend/__pycache__`, `*.pyc`, `*-live.ndjson`, `*-manifest.json`, `amazon-image-batch-*.json`, or `lark-schema/demo-data` to production.

## 2. Install the service

```bash
sudo useradd --system --home /opt/rankflow --shell /usr/sbin/nologin rankflow || true
sudo mkdir -p /opt/rankflow /var/lib/rankflow /etc/rankflow
sudo chown -R rankflow:rankflow /opt/rankflow /var/lib/rankflow
sudo cp deploy/rankflow.env.example /etc/rankflow/rankflow.env
sudo chmod 600 /etc/rankflow/rankflow.env
sudo cp deploy/rankflow.service.example /etc/systemd/system/rankflow.service
sudo systemctl daemon-reload
sudo systemctl enable --now rankflow
```

Set real Lark credentials and two different random tokens in `/etc/rankflow/rankflow.env`. Run read-only checks first:

```bash
sudo -u rankflow /usr/bin/python3 /opt/rankflow/backend/rankflow.py doctor
curl http://127.0.0.1:8787/health
```

Only after a controlled Chrome smoke test, set `RANKFLOW_LIVE_ENABLED=1` and restart the service.

## 3. Chrome worker

Load the built extension (`extension/.output/chrome-mv3`) as an unpacked extension in a signed-in Chrome profile. Enter the HTTPS reverse-proxy URL and the worker token. Do not put the Lark app secret or admin token in the extension. For a remote Windows Chrome worker, expose only HTTPS through a reverse proxy and firewall; do not expose port 8787 directly.

## 4. Acceptance gate

Verify one manual run reaches `claimed → running → done`, creates one `crawl_run` and its snapshots, and updates the Heatmap. Then configure `schedule_enabled`, `schedule_days`, and `schedule_time` in the Base. The scheduler is owned by the service and runs without Codex/agent involvement.
