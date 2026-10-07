"""RankFlow v2: durable scheduler, 2J worker API, group admin API and Lark Base sync (stdlib only).

Sections
  1. helpers / normalisation / import parsing
  2. Store      - SQLite: watchlists, items (groups), runs, keyword jobs, leases, snapshots, outbox, events
  3. Lark       - Bitable OpenAPI client (bot credential)
  4. Engine     - Base pull (mirror + schedule + run_request), outbox sync, watchdog
  5. HTTP       - 2J worker endpoints, legacy worker endpoints, admin API
  6. CLI        - serve | status | doctor | enqueue | groups ... | watchlist | run-now | runs | cancel
Base is written only when RANKFLOW_LIVE_ENABLED=1 (the outbox simply accumulates otherwise).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

LOG = logging.getLogger("rankflow")
ROOT = Path(__file__).resolve().parent.parent
# Base tables are resolved by NAME at runtime (override with RANKFLOW_TABLE_<KIND>=tbl... if you renamed one).
TABLE_NAMES = {
    "items": "watchlist_item",
    "watchlists": "watchlist",
    "snapshots": "snapshot",
    "runs": "crawl_run",
    "requests": "run_request",
}
TABLES: dict[str, str] = {}  # kind -> table_id, filled by Lark.table_id()
# Required columns per table, matched by field NAME (the Base column name equals the logical name; see `rankflow.py schema`).
FIELDS = {
    "items": {"asin": "asin", "keyword": "keyword", "watchlist_id": "watchlist_id", "group": "group", "enabled": "enabled", "updated_at": "updated_at", "source": "source"},
    "watchlists": {"watchlist_id": "watchlist_id", "name": "name", "marketplace": "marketplace", "zip": "zip", "top_n": "top_n", "sponsored": "sponsored", "schedule_enabled": "schedule_enabled", "schedule_days": "schedule_days", "schedule_time": "schedule_time", "last_run_at": "last_run_at", "last_run_status": "last_run_status", "updated_at": "updated_at"},
    "snapshots": {"price_cents": "price_cents", "marketplace": "marketplace", "snapshot_day": "snapshot_day", "image_url": "image_url", "run_id": "run_id", "zip": "zip", "status": "status", "organic_rank": "organic_rank", "position_on_page": "position_on_page", "asin": "asin", "keyword": "keyword"},
    "runs": {"run_id": "run_id", "watchlist_id": "watchlist_id", "marketplace": "marketplace", "zip": "zip", "top_n": "top_n", "sponsored": "sponsored", "started_at": "started_at", "finished_at": "finished_at", "status": "status", "note": "note", "pairs_total": "pairs_total", "pairs_found": "pairs_found", "pairs_not_found": "pairs_not_found", "pairs_failed": "pairs_failed", "error": "error"},
    "requests": {"request_id": "request_id", "watchlist_id": "watchlist_id", "requested_at": "requested_at", "status": "status", "run_id": "run_id", "result_status": "result_status", "note": "note", "started_at": "started_at", "finished_at": "finished_at"},
}
# Optional Base columns, matched by field NAME. Written only if the column exists in Base (create once, see `rankflow.py lark-fields`).
# items.owner is the input person field (Lark "User" = type 11); snapshot.owner / crawl_run.owners carry it to results
OPTIONAL_FIELDS = {"snapshots": {"group": 1, "owner": 11}, "runs": {"groups": 1, "owners": 11}, "items": {"owner": 11}}  # name -> Lark field type (1 = text, 11 = user)
FIELD_PROPERTIES = {("snapshots", "owner"): {"multiple": False}, ("runs", "owners"): {"multiple": True}, ("items", "owner"): {"multiple": False}}
USER_FIELD = 11
OPEN_ID_RE = re.compile(r"^ou_[0-9a-f]{20,64}$")
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
ASIN_RE = re.compile(r"^(B0[A-Z0-9]{8}|\d{9}[\dX])$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FINAL_REQUEST_STATUSES = {"done", "failed", "cancelled"}
SNAPSHOT_WAIT_ATTEMPTS = 5  # a snapshot failing this often no longer holds back its run_request's final status
RESULT_STATUSES = {"found", "not_found", "unverified_blocked", "unverified_parser_error"}
MAX_ATTEMPTS = 3
MAX_TOP_N = 1000
DEFAULT_TOP_N = int(os.getenv("DEPTH", "190") or 190)  # organic results scanned per keyword (stop early when every target ASIN is found)
# Reserved run-now / job group filter meaning "only pairs WITHOUT a group" (items.grp = '').
# A missing/None group means "all groups". Never stored as a real group name.
NO_GROUP = "__none__"
DEFAULT_ZIP = os.getenv("ZIP", "10001") or "10001"
DEFAULT_MARKETPLACE = os.getenv("MARKETPLACE", "amazon.com") or "amazon.com"
NO_GROUP_LABEL = "(no group)"


# ---------------------------------------------------------------------------
# 1. helpers
# ---------------------------------------------------------------------------
def load_env(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def lark_api_base() -> str:
    """LARK_DOMAIN: https://open.larksuite.com (Lark intl, default) or https://open.feishu.cn."""
    return os.getenv("LARK_DOMAIN", "https://open.larksuite.com").rstrip("/") + "/open-apis"


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def now_dt() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_dt().isoformat(timespec="seconds")


def iso_in(seconds: float) -> str:
    return (now_dt() + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def tz() -> ZoneInfo:
    return ZoneInfo(os.getenv("RANKFLOW_TIMEZONE", "Asia/Bangkok"))


def local_day() -> str:
    return datetime.now(tz()).date().isoformat()


def local_iso() -> str:
    return datetime.now(tz()).isoformat(timespec="seconds")


def json_text(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def cell(value):
    if isinstance(value, list):
        if not value:
            return ""
        if isinstance(value[0], dict):
            return "".join(str(v.get("text", "")) for v in value)
        return value[0] if len(value) == 1 else value
    return value


def default_watchlist() -> str:
    return os.getenv("RANKFLOW_DEFAULT_WATCHLIST", "default")


def norm_keyword(value) -> str:
    """Trim + collapse whitespace; case is preserved (Base join is exact)."""
    return " ".join(str(value or "").split())


def kw_key(value) -> str:
    return norm_keyword(value).casefold()


def norm_asin(value) -> str:
    return str(value or "").strip().upper()


def item_key(watchlist_id: str, asin: str, keyword: str) -> str:
    return f"{watchlist_id}|{norm_asin(asin)}|{kw_key(keyword)}"


def clean_group(value) -> str:
    """Stored group name: stripped text; the reserved NO_GROUP sentinel is stored as '' (ungrouped)."""
    text = str(value or "").strip()[:100]
    return "" if text == NO_GROUP else text


def owner_from_cell(value) -> dict | None:
    """Lark user cell ([{id, name, en_name?, email?}] or {id,...} or 'ou_…') -> {id, name, email} (first person) or None."""
    if isinstance(value, list):
        value = next((v for v in value if v), None)
    if isinstance(value, str):
        value = {"id": value} if OPEN_ID_RE.fullmatch(value.strip()) else None
    if not isinstance(value, dict) or not str(value.get("id") or "").strip():
        return None
    # email is deliberately dropped (by design: no emails stored); lookups use open_id / name
    return {"id": str(value["id"]).strip(), "name": str(value.get("name") or value.get("en_name") or "").strip() or None, "email": None}


def group_filter(value) -> str | None:
    """run-now group argument -> SQL filter. None = all groups; NO_GROUP (or explicit '') = ungrouped only."""
    if value is None:
        return None
    return clean_group(value)


def scope_label(scope: str | None) -> str:
    return (scope or "*").replace(f"group:{NO_GROUP}", f"group:{NO_GROUP_LABEL}")


def page_pos_label(page_number, position_on_page) -> str | None:
    """Base snapshot.position_on_page text, e.g. '#7 P2'. Never invented."""
    if isinstance(page_number, int) and isinstance(position_on_page, int) and page_number > 0 and position_on_page > 0:
        return f"#{position_on_page} P{page_number}"
    return None


def as_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on", "x")


def split_keywords(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        parts = []
        for v in value:
            parts.extend(split_keywords(v) if isinstance(v, (list, tuple)) else [v])
        return [k for k in (norm_keyword(p) for p in parts) if k]
    return [k for k in (norm_keyword(p) for p in re.split(r"[;\n|]", str(value))) if k]


def expand_entries(body: dict, default_group: str | None = None) -> list[dict]:
    """Accepts {items:[{asin, keywords|keyword, group?}]}, {asins:[..], keywords:[..]} (cartesian),
    {pairs:[{asin, keyword, group?}]}; returns [{asin, keyword, group}]."""
    group = body.get("group", default_group)
    owner = body.get("owner")
    out: list[dict] = []
    for item in body.get("items") or []:
        for kw in split_keywords(item.get("keywords")) + split_keywords(item.get("keyword")):
            out.append({"asin": item.get("asin"), "keyword": kw, "group": item.get("group", group), "owner": item.get("owner", owner)})
    if body.get("asins") is not None or body.get("keywords") is not None:
        asins = body.get("asins") or []
        if isinstance(asins, str):
            asins = re.split(r"[\s,;]+", asins)
        for asin in [a for a in asins if str(a).strip()]:
            for kw in split_keywords(body.get("keywords")):
                out.append({"asin": asin, "keyword": kw, "group": group, "owner": owner})
    for pair in body.get("pairs") or []:
        for kw in split_keywords(pair.get("keywords")) + split_keywords(pair.get("keyword")):
            out.append({"asin": pair.get("asin"), "keyword": kw, "group": pair.get("group", group), "owner": pair.get("owner", owner)})
    return out


def parse_import(data, fmt: str | None = None) -> list[dict]:
    """Bulk import: CSV text (asin,keyword[,group]) or JSON (list of pairs, {groups:[...]}, {pairs:[...]},
    or {ASIN: [keywords]})."""
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8-sig")
    if isinstance(data, str):
        text = data.lstrip("\ufeff")
        if fmt is None:
            fmt = "json" if text.lstrip()[:1] in ("[", "{") else "csv"
        if fmt == "csv":
            rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
            if not rows:
                return []
            header = [c.strip().lower() for c in rows[0]]
            if "asin" in header and "keyword" in header:
                idx = {name: header.index(name) for name in ("asin", "keyword", "group", "owner") if name in header}
                body = rows[1:]
            else:
                idx = {"asin": 0, "keyword": 1, "group": 2}
                body = rows
            out = []
            for r in body:
                def get(name):
                    return r[idx[name]].strip() if name in idx and idx[name] < len(r) else ""
                out.append({"asin": get("asin"), "keyword": get("keyword"), "group": get("group") or None, "owner": get("owner") or None})
            return out
        data = json.loads(text)
    if isinstance(data, list):
        return expand_entries({"pairs": data})
    if isinstance(data, dict):
        if "groups" in data:
            out = []
            for g in data["groups"]:
                out.extend(expand_entries(g, g.get("group") or g.get("name")))
            return out
        if any(k in data for k in ("pairs", "items", "asins")):
            return expand_entries(data)
        if data and all(ASIN_RE.fullmatch(norm_asin(k)) for k in data):
            return expand_entries({"items": [{"asin": k, "keywords": v} for k, v in data.items()]})
    raise ValueError("unsupported import format")


class LeaseError(ValueError):
    """Lease token unknown, expired or cancelled (HTTP 409)."""


# ---------------------------------------------------------------------------
# 2. Store
# ---------------------------------------------------------------------------
class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=15)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.job_cond = threading.Condition(threading.Lock())
        self.workers_seen: dict[str, str] = {}
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, watchlist_id TEXT NOT NULL,
              settings TEXT NOT NULL, status TEXT NOT NULL, source_record_id TEXT,
              created_at TEXT NOT NULL, finished_at TEXT
            );
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), keyword TEXT NOT NULL,
              targets TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
              lease_token TEXT, lease_until TEXT, worker_id TEXT, error TEXT,
              UNIQUE(run_id, keyword)
            );
            CREATE TABLE IF NOT EXISTS snapshots (
              run_id TEXT NOT NULL REFERENCES runs(id), asin TEXT NOT NULL, keyword TEXT NOT NULL,
              snapshot_day TEXT NOT NULL, status TEXT NOT NULL, organic_rank INTEGER,
              position_on_page INTEGER, image_url TEXT, price_cents INTEGER,
              PRIMARY KEY(run_id, asin, keyword)
            );
            CREATE TABLE IF NOT EXISTS outbox (
              kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL,
              PRIMARY KEY(kind, key)
            );
            CREATE TABLE IF NOT EXISTS watchlists (
              watchlist_id TEXT PRIMARY KEY, name TEXT, zip TEXT NOT NULL DEFAULT '10001',
              top_n INTEGER NOT NULL DEFAULT 190, sponsored INTEGER NOT NULL DEFAULT 0,
              base_record_id TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS items (
              watchlist_id TEXT NOT NULL, asin TEXT NOT NULL, keyword TEXT NOT NULL, keyword_key TEXT NOT NULL,
              grp TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, base_record_id TEXT,
              source TEXT, updated_at TEXT NOT NULL,
              PRIMARY KEY(watchlist_id, asin, keyword_key)
            );
            CREATE TABLE IF NOT EXISTS leases (
              token TEXT PRIMARY KEY, run_id TEXT NOT NULL, worker_id TEXT, state TEXT NOT NULL,
              claimed_at TEXT NOT NULL, heartbeat_at TEXT, finished_at TEXT, progress TEXT, error TEXT
            );
            CREATE TABLE IF NOT EXISTS members (
                open_id TEXT PRIMARY KEY, name TEXT, en_name TEXT, email TEXT, avatar_url TEXT, departments TEXT,
                active INTEGER NOT NULL DEFAULT 1, updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL,
              kind TEXT NOT NULL, run_id TEXT, message TEXT
            );
            """)
            self._add_column("snapshots", "page_number", "INTEGER")
            self._add_column("runs", "scope", "TEXT")
            self._add_column("runs", "error", "TEXT")
            self._add_column("snapshots", "grp", "TEXT")
            self._add_column("leases", "meta", "TEXT")
            self._add_column("leases", "warnings", "TEXT")
            for table in ("items", "snapshots"):
                for column in ("owner_id", "owner_name"):
                    self._add_column(table, column, "TEXT")
            self._add_column("items", "owner_email", "TEXT")
            self.db.execute("UPDATE items SET owner_email=NULL WHERE owner_email IS NOT NULL")  # never keep emails
            self.db.execute("UPDATE members SET email=NULL WHERE email IS NOT NULL")

    # -- infrastructure ----------------------------------------------------
    def notify_jobs(self) -> None:
        with self.job_cond:
            self.job_cond.notify_all()

    def wait_for_jobs(self, timeout: float) -> None:
        with self.job_cond:
            self.job_cond.wait(timeout)

    def groups_version(self) -> str:
        with self.lock:
            a = self.db.execute("SELECT COUNT(*), COALESCE(SUM(enabled),0), COALESCE(MAX(updated_at),'') FROM items").fetchone()
            b = self.db.execute("SELECT COUNT(*), COALESCE(MAX(updated_at),'') FROM watchlists").fetchone()
        return hashlib.sha1(f"{tuple(a)}|{tuple(b)}".encode()).hexdigest()[:12]

    def _add_column(self, table: str, column: str, decl: str) -> None:
        cols = {r["name"] for r in self.db.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

    @contextmanager
    def tx(self):
        with self.lock:
            if self.db.in_transaction:
                yield
                return
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def event(self, kind: str, message: str, run_id: str | None = None, level: str = "info") -> None:
        self.db.execute("INSERT INTO events(at,level,kind,run_id,message) VALUES(?,?,?,?,?)", (now_iso(), level, kind, run_id, message[:1000]))
        self.db.execute("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - 2000")
        (LOG.warning if level != "info" else LOG.info)("[%s] %s %s", kind, run_id or "", message)

    def put_outbox(self, kind: str, key: str, payload: dict) -> None:
        self.db.execute("INSERT INTO outbox(kind,key,payload,next_at) VALUES(?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET payload=excluded.payload,next_at=excluded.next_at,attempts=0", (kind, key, json_text(payload), now_iso()))

    # -- watchlists / groups -------------------------------------------------
    def get_watchlist(self, watchlist_id: str) -> dict:
        with self.lock:
            row = self.db.execute("SELECT * FROM watchlists WHERE watchlist_id=?", (watchlist_id,)).fetchone()
        if row:
            return {"watchlist_id": watchlist_id, "name": row["name"], "zip": row["zip"], "top_n": row["top_n"], "sponsored": bool(row["sponsored"])}
        return {"watchlist_id": watchlist_id, "name": watchlist_id, "zip": DEFAULT_ZIP, "top_n": DEFAULT_TOP_N, "sponsored": False}

    def _ensure_watchlist(self, watchlist_id: str) -> None:
        self.db.execute("INSERT OR IGNORE INTO watchlists(watchlist_id,name,updated_at) VALUES(?,?,?)", (watchlist_id, watchlist_id, now_iso()))

    def set_watchlist(self, watchlist_id: str, zip_code: str | None = None, top_n: int | None = None, sponsored: bool | None = None, name: str | None = None) -> dict:
        if not watchlist_id or len(watchlist_id) > 100:
            raise ValueError("watchlist_id required")
        if zip_code is not None and not re.fullmatch(r"\d{5}", str(zip_code)):
            raise ValueError("zip must be 5 digits")
        if top_n is not None and not 1 <= int(top_n) <= MAX_TOP_N:
            raise ValueError(f"top_n must be 1..{MAX_TOP_N}")
        with self.tx():
            self._ensure_watchlist(watchlist_id)
            for column, value in (("zip", zip_code), ("top_n", None if top_n is None else int(top_n)), ("sponsored", None if sponsored is None else int(bool(sponsored))), ("name", name)):
                if value is not None:
                    self.db.execute(f"UPDATE watchlists SET {column}=?, updated_at=? WHERE watchlist_id=?", (value, now_iso(), watchlist_id))
            wl = self.get_watchlist(watchlist_id)
            self.put_outbox("watchlist_settings", watchlist_id, {"watchlist_id": watchlist_id, "name": wl["name"], "zip": wl["zip"], "top_n": wl["top_n"], "sponsored": wl["sponsored"], "updated_at": local_iso()})
        return wl

    def _queue_item_sync(self, watchlist_id: str, asin: str, keyword: str, group: str, enabled: bool, source: str, owner: dict | None | bool = False) -> None:
        """owner=False: leave Base owner untouched; None: clear it; {id,...}: set it."""
        payload = {"watchlist_id": watchlist_id, "asin": asin, "keyword": keyword, "group": group, "enabled": enabled, "source": source, "updated_at": local_iso()}
        if owner is not False:
            payload["owner"] = [owner["id"]] if owner else []
        self.put_outbox("items", item_key(watchlist_id, asin, keyword), payload)

    def known_owners(self) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT owner_id, MAX(owner_name) AS owner_name, MAX(owner_email) AS owner_email, COUNT(*) AS pairs FROM items WHERE owner_id IS NOT NULL AND owner_id<>'' GROUP BY owner_id ORDER BY owner_name").fetchall()
        return [{"id": r["owner_id"], "name": r["owner_name"], "email": r["owner_email"], "pairs": r["pairs"]} for r in rows]

    def save_members(self, members: list[dict], deactivate_missing: bool = True) -> dict:
        """Replace the local org member cache (Lark contact): upsert all, mark the rest inactive (unless the fetch was partial).
        Email is never stored (name/avatar only)."""
        with self.tx():
            self.db.execute("UPDATE members SET email=NULL WHERE email IS NOT NULL")
            seen = set()
            for m in members:
                seen.add(m["open_id"])
                self.db.execute("""INSERT INTO members(open_id,name,en_name,email,avatar_url,departments,active,updated_at) VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(open_id) DO UPDATE SET name=excluded.name, en_name=excluded.en_name, email=excluded.email, avatar_url=excluded.avatar_url,
                      departments=excluded.departments, active=excluded.active, updated_at=excluded.updated_at""",
                                (m["open_id"], m.get("name"), m.get("en_name"), None, m.get("avatar_url"), ", ".join(m.get("departments") or []), int(bool(m.get("active", True))), now_iso()))
            stale = [r["open_id"] for r in self.db.execute("SELECT open_id FROM members WHERE active=1") if r["open_id"] not in seen] if deactivate_missing else []
            for oid in stale:
                self.db.execute("UPDATE members SET active=0, updated_at=? WHERE open_id=?", (now_iso(), oid))
        return {"members": len(members), "deactivated": len(stale)}

    def list_members(self, include_inactive: bool = False) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT * FROM members" + ("" if include_inactive else " WHERE active=1") + " ORDER BY name").fetchall()
        return [dict(r) for r in rows]

    def resolve_owner(self, value) -> dict | None:
        """CLI/API owner argument: open_id (ou_…), or the name / English name of an org member or existing owner. ''/'-'/'none' = clear."""
        if isinstance(value, (dict, list)):
            owner = owner_from_cell(value)
            if owner:
                return owner
            raise ValueError(f"invalid owner: {value!r}")
        text = str(value or "").strip()
        if text.lower() in ("", "-", "none"):
            return None
        known = self.known_owners()
        ids = {o["id"] for o in known}
        for m in self.list_members():  # whole org (member sync), after people already used as owner
            if m["open_id"] not in ids:
                known.append({"id": m["open_id"], "name": m["name"], "email": m["email"], "en_name": m["en_name"], "pairs": 0})
        if OPEN_ID_RE.fullmatch(text):
            hit = next((o for o in known if o["id"] == text), None)
            return {"id": text, "name": hit["name"] if hit else None, "email": hit["email"] if hit else None}
        hits = [o for o in known if text.lower() in {str(o["name"] or "").lower(), str(o["email"] or "").lower(), str(o.get("en_name") or "").lower()} - {""}]
        if len(hits) == 1:
            return {"id": hits[0]["id"], "name": hits[0]["name"], "email": hits[0]["email"]}
        raise ValueError(f"owner {text!r} {'is ambiguous' if hits else 'not found'}: pass an open_id (ou_…) or the name of an org member (members sync) / existing watchlist_item owner (known: {', '.join(str(o['name'] or o['id']) for o in known[:30]) or 'none'}{' …' if len(known) > 30 else ''})")

    def upsert_items(self, watchlist_id: str, entries: list[dict], source: str = "rankflow") -> dict:
        """Add / re-enable / regroup pairs. entries: [{asin, keyword, group?}] (group None = keep)."""
        watchlist_id = (watchlist_id or default_watchlist()).strip()
        clean: dict[str, dict] = {}
        for entry in entries:
            asin, keyword = norm_asin(entry.get("asin")), norm_keyword(entry.get("keyword"))
            if not ASIN_RE.fullmatch(asin):
                raise ValueError(f"invalid ASIN: {entry.get('asin')!r}")
            if not keyword or len(keyword) > 200:
                raise ValueError(f"invalid keyword for {asin}: {entry.get('keyword')!r}")
            group = entry.get("group")
            owner = False if entry.get("owner") is None else self.resolve_owner(entry.get("owner"))  # False = keep
            clean[item_key(watchlist_id, asin, keyword)] = {"asin": asin, "keyword": keyword, "group": None if group is None else clean_group(group), "owner": owner}
        if not clean:
            raise ValueError("no ASIN/keyword pairs given")
        if len(clean) > 20000:
            raise ValueError("too many pairs in one call (max 20000)")
        stats = {"added": 0, "reenabled": 0, "regrouped": 0, "reowned": 0, "unchanged": 0}
        with self.tx():
            self._ensure_watchlist(watchlist_id)
            for e in clean.values():
                row = self.db.execute("SELECT * FROM items WHERE watchlist_id=? AND asin=? AND keyword_key=?", (watchlist_id, e["asin"], kw_key(e["keyword"]))).fetchone()
                owner = e["owner"]
                if row is None:
                    group = e["group"] or ""
                    o = owner or {}
                    self.db.execute("INSERT INTO items(watchlist_id,asin,keyword,keyword_key,grp,enabled,source,updated_at,owner_id,owner_name,owner_email) VALUES(?,?,?,?,?,1,?,?,?,?,?)",
                                    (watchlist_id, e["asin"], e["keyword"], kw_key(e["keyword"]), group, source, now_iso(), o.get("id"), o.get("name"), o.get("email")))
                    stats["added"] += 1
                    keyword = e["keyword"]
                else:
                    group = row["grp"] if e["group"] is None else e["group"]
                    owner_changed = owner is not False and (owner or {}).get("id") != row["owner_id"]
                    if row["enabled"] and group == row["grp"] and not owner_changed:
                        stats["unchanged"] += 1
                        continue
                    stats["reenabled" if not row["enabled"] else "regrouped" if group != row["grp"] else "reowned"] += 1
                    self.db.execute("UPDATE items SET enabled=1, grp=?, source=?, updated_at=? WHERE watchlist_id=? AND asin=? AND keyword_key=?", (group, source, now_iso(), watchlist_id, e["asin"], row["keyword_key"]))
                    if owner_changed:
                        o = owner or {}
                        self.db.execute("UPDATE items SET owner_id=?, owner_name=?, owner_email=? WHERE watchlist_id=? AND asin=? AND keyword_key=?", (o.get("id"), o.get("name"), o.get("email"), watchlist_id, e["asin"], row["keyword_key"]))
                    else:
                        owner = False
                    keyword = row["keyword"]
                self._queue_item_sync(watchlist_id, e["asin"], keyword, group, True, source, owner)
            self.event("groups", f"upsert {watchlist_id}: {stats}")
        return stats

    def disable_items(self, watchlist_id: str, group: str | None = None, asin: str | None = None, keywords: list[str] | None = None, pairs: list[dict] | None = None, everything: bool = False, source: str = "rankflow") -> int:
        """Soft delete (enabled=false), matching the block UI rule 'never hard-delete'."""
        watchlist_id = (watchlist_id or default_watchlist()).strip()
        where, args = ["watchlist_id=?", "enabled=1"], [watchlist_id]
        group = group_filter(group)  # NO_GROUP -> '' (ungrouped pairs)
        if group is not None:
            where.append("grp=?")
            args.append(group)
        if asin:
            where.append("asin=?")
            args.append(norm_asin(asin))
        if keywords:
            keys = [kw_key(k) for k in keywords]
            where.append(f"keyword_key IN ({','.join('?' * len(keys))})")
            args.extend(keys)
        if group is None and not asin and not keywords and not pairs and not everything:
            raise ValueError("refusing to delete without group/asin/keyword/pairs filter")
        with self.tx():
            if pairs:
                rows = []
                for p in pairs:
                    rows.extend(self.db.execute("SELECT * FROM items WHERE watchlist_id=? AND enabled=1 AND asin=? AND keyword_key=?", (watchlist_id, norm_asin(p.get("asin")), kw_key(p.get("keyword")))).fetchall())
            else:
                rows = self.db.execute(f"SELECT * FROM items WHERE {' AND '.join(where)}", args).fetchall()
            for row in rows:
                self.db.execute("UPDATE items SET enabled=0, source=?, updated_at=? WHERE watchlist_id=? AND asin=? AND keyword_key=?", (source, now_iso(), watchlist_id, row["asin"], row["keyword_key"]))
                self._queue_item_sync(watchlist_id, row["asin"], row["keyword"], row["grp"], False, source)
            if rows:
                self.event("groups", f"disabled {len(rows)} pair(s) in {watchlist_id} (group={group!r}, asin={asin!r})")
        return len(rows)

    def replace_group(self, watchlist_id: str, group: str, entries: list[dict], source: str = "rankflow") -> dict:
        watchlist_id = (watchlist_id or default_watchlist()).strip()
        group = clean_group(group)
        entries = [{**e, "group": group} for e in entries]
        with self.tx():
            stats = self.upsert_items(watchlist_id, entries, source)
            wanted = {(norm_asin(e["asin"]), kw_key(e["keyword"])) for e in entries}
            stale = [{"asin": r["asin"], "keyword": r["keyword"]} for r in self.db.execute("SELECT asin,keyword,keyword_key FROM items WHERE watchlist_id=? AND grp=? AND enabled=1", (watchlist_id, group)) if (r["asin"], r["keyword_key"]) not in wanted]
            stats["disabled"] = self.disable_items(watchlist_id, pairs=stale, source=source) if stale else 0
        return stats

    def import_entries(self, watchlist_id: str, entries: list[dict], replace: bool = False, source: str = "import") -> dict:
        if not replace:
            return self.upsert_items(watchlist_id, entries, source)
        total = {"added": 0, "reenabled": 0, "regrouped": 0, "unchanged": 0, "disabled": 0}
        by_group: dict[str, list[dict]] = {}
        for e in entries:
            by_group.setdefault(str(e.get("group") or ""), []).append(e)
        with self.tx():
            for group, group_entries in by_group.items():
                for k, v in self.replace_group(watchlist_id, group, group_entries, source).items():
                    total[k] = total.get(k, 0) + v
        return total

    def list_groups(self, watchlist_id: str | None = None, include_disabled: bool = False) -> list[dict]:
        clauses, args = [], []
        if watchlist_id:
            clauses.append("watchlist_id=?")
            args.append(watchlist_id)
        if not include_disabled:
            clauses.append("enabled=1")
        sql = "SELECT * FROM items" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY watchlist_id, grp, asin, rowid"
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        groups: dict[tuple, dict] = {}
        for r in rows:
            g = groups.setdefault((r["watchlist_id"], r["grp"]), {"watchlist_id": r["watchlist_id"], "group": r["grp"], "asins": {}, "pairs": 0, "disabled_pairs": 0, "owners": {}})
            a = g["asins"].setdefault(r["asin"], {"asin": r["asin"], "keywords": [], "disabled_keywords": [], "owners": {}})
            if r["owner_id"]:
                a["owners"][r["keyword"]] = {"id": r["owner_id"], "name": r["owner_name"]}
                if r["enabled"]:
                    g["owners"].setdefault(r["owner_id"], {"id": r["owner_id"], "name": r["owner_name"]})
            if r["enabled"]:
                a["keywords"].append(r["keyword"])
                g["pairs"] += 1
            else:
                a["disabled_keywords"].append(r["keyword"])
                g["disabled_pairs"] += 1
        out = []
        for g in groups.values():
            g["asins"] = list(g["asins"].values())
            g["owners"] = list(g["owners"].values())
            if not include_disabled:
                for a in g["asins"]:
                    a.pop("disabled_keywords")
                g.pop("disabled_pairs")
            out.append(g)
        return out

    def enabled_pairs(self, watchlist_id: str, group: str | None = None) -> list[dict]:
        sql, args = "SELECT asin,keyword,grp,owner_id,owner_name FROM items WHERE watchlist_id=? AND enabled=1", [watchlist_id]
        if group is not None:
            sql += " AND grp=?"
            args.append(group)
        with self.lock:
            return [{"asin": r["asin"], "keyword": r["keyword"], "group": r["grp"], **({"owner_id": r["owner_id"], "owner_name": r["owner_name"]} if r["owner_id"] else {})}
                    for r in self.db.execute(sql + " ORDER BY rowid", args)]

    def watchlist_ids(self) -> list[str]:
        with self.lock:
            return [r[0] for r in self.db.execute("SELECT DISTINCT watchlist_id FROM items WHERE enabled=1 ORDER BY watchlist_id")]

    def mirror_from_base(self, watchlists: list[tuple[str, dict]], items: list[tuple[str, dict]]) -> dict:
        """Live mode: Base is the source of truth except for keys with pending local writes."""
        stats = {"items": 0, "removed": 0, "watchlists": 0}
        with self.tx():
            pending_items = {r[0] for r in self.db.execute("SELECT key FROM outbox WHERE kind='items'")}
            pending_wl = {r[0] for r in self.db.execute("SELECT key FROM outbox WHERE kind='watchlist_settings'")}
            for record_id, w in watchlists:
                wid = str(w.get("watchlist_id") or "").strip()
                if not wid:
                    continue
                self._ensure_watchlist(wid)
                self.db.execute("UPDATE watchlists SET base_record_id=? WHERE watchlist_id=?", (record_id, wid))
                if wid in pending_wl:
                    continue
                zip_code = str(w.get("zip") or "").strip()
                top_n = as_int(w.get("top_n"))
                self.db.execute("UPDATE watchlists SET zip=COALESCE(?,zip), top_n=COALESCE(?,top_n), sponsored=?, name=COALESCE(?,name), updated_at=? WHERE watchlist_id=?",
                                (zip_code if re.fullmatch(r"\d{5}", zip_code) else None, top_n if top_n and 1 <= top_n <= MAX_TOP_N else None, int(w.get("sponsored") is True), str(w.get("name") or "").strip() or None, now_iso(), wid))
                stats["watchlists"] += 1
            seen: dict[str, tuple[str, bool]] = {}
            for record_id, it in items:
                wid, asin, keyword = str(it.get("watchlist_id") or "").strip(), norm_asin(it.get("asin")), norm_keyword(it.get("keyword"))
                if not wid or not ASIN_RE.fullmatch(asin) or not keyword:
                    continue
                key = item_key(wid, asin, keyword)
                enabled = it.get("enabled") is True
                if key in seen and (seen[key][1] or not enabled):
                    continue  # duplicate Base rows: an enabled record wins
                seen[key] = (record_id, enabled)
                self._ensure_watchlist(wid)
                if key in pending_items:
                    self.db.execute("UPDATE items SET base_record_id=COALESCE(base_record_id,?) WHERE watchlist_id=? AND asin=? AND keyword_key=?", (record_id, wid, asin, kw_key(keyword)))
                    continue
                owner = owner_from_cell(it.get("owner")) or {}
                self.db.execute("""INSERT INTO items(watchlist_id,asin,keyword,keyword_key,grp,enabled,base_record_id,source,updated_at,owner_id,owner_name,owner_email) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(watchlist_id,asin,keyword_key) DO UPDATE SET keyword=excluded.keyword, grp=excluded.grp, enabled=excluded.enabled, base_record_id=excluded.base_record_id, source=excluded.source, updated_at=excluded.updated_at,
                      owner_id=excluded.owner_id, owner_name=excluded.owner_name, owner_email=excluded.owner_email
                    WHERE items.keyword IS NOT excluded.keyword OR items.grp IS NOT excluded.grp OR items.enabled IS NOT excluded.enabled OR items.base_record_id IS NOT excluded.base_record_id OR items.source IS NOT excluded.source
                      OR items.owner_id IS NOT excluded.owner_id OR items.owner_name IS NOT excluded.owner_name OR items.owner_email IS NOT excluded.owner_email""",
                                (wid, asin, keyword, kw_key(keyword), clean_group(it.get("group")), int(enabled), record_id, str(it.get("source") or "base"), now_iso(), owner.get("id"), owner.get("name"), owner.get("email")))
                stats["items"] += 1
            for r in self.db.execute("SELECT watchlist_id,asin,keyword FROM items WHERE base_record_id IS NOT NULL").fetchall():
                key = item_key(r["watchlist_id"], r["asin"], r["keyword"])
                if key not in seen and key not in pending_items:
                    self.db.execute("DELETE FROM items WHERE watchlist_id=? AND asin=? AND keyword_key=?", (r["watchlist_id"], r["asin"], kw_key(r["keyword"])))
                    stats["removed"] += 1
        return stats

    # -- runs ------------------------------------------------------------------
    def enqueue(self, source_key: str, watchlist_id: str, pairs: list[dict], settings: dict, source_record_id: str | None = None, scope: str | None = None) -> str:
        if not watchlist_id or not pairs or len(pairs) > 5000:
            raise ValueError("watchlist_id and 1..5000 pairs required")
        grouped: dict[str, dict] = {}
        for pair in pairs:
            asin = norm_asin(pair.get("asin"))
            keyword = norm_keyword(pair.get("keyword"))
            if not ASIN_RE.fullmatch(asin) or not keyword or len(keyword) > 200:
                raise ValueError("invalid ASIN or keyword")
            slot = grouped.setdefault(kw_key(keyword), {"keyword": keyword, "targets": {}})
            target = {"asin": asin, "group": str(pair.get("group") or "")[:100]}
            if pair.get("owner_id"):
                target.update(owner_id=str(pair["owner_id"]), owner_name=pair.get("owner_name"))
            slot["targets"][asin] = target
        run_id = "rf2-" + uuid.uuid4().hex[:20]
        top_n = as_int(settings.get("top_n")) or DEFAULT_TOP_N
        safe_settings = {
            "marketplace": DEFAULT_MARKETPLACE, "zip": str(settings.get("zip") or DEFAULT_ZIP).strip()[:12] or DEFAULT_ZIP,
            "top_n": max(1, min(MAX_TOP_N, top_n)),
            "sponsored": settings.get("sponsored") is True,
        }
        with self.tx():
            existing = self.db.execute("SELECT id FROM runs WHERE source_key=?", (source_key,)).fetchone()
            if existing:
                return existing["id"]
            self.db.execute("INSERT INTO runs(id,source_key,watchlist_id,settings,status,source_record_id,created_at,scope) VALUES (?,?,?,?,?,?,?,?)", (run_id, source_key, watchlist_id, json_text(safe_settings), "queued", source_record_id, now_iso(), scope))
            for slot in grouped.values():
                self.db.execute("INSERT INTO jobs (id,run_id,keyword,targets,status) VALUES (?,?,?,?,?)", ("job-" + uuid.uuid4().hex, run_id, slot["keyword"], json_text(list(slot["targets"].values())), "queued"))
            if source_record_id:
                self.put_outbox("requests", source_record_id, {"status": "claimed", "run_id": run_id, "started_at": now_iso()})
            self.event("enqueue", f"{watchlist_id}: {len(pairs)} pairs / {len(grouped)} keywords ({source_key})", run_id)
        self.notify_jobs()
        return run_id

    def run_now(self, watchlist_id: str | None = None, group: str | None = None, requested_by: str = "admin") -> list[dict]:
        """group=None: every enabled pair. group=NO_GROUP (or ''): only enabled pairs without a group. Else: that group."""
        grp = group_filter(group)
        shown = None if grp is None else (grp or NO_GROUP)
        targets = [watchlist_id] if watchlist_id else self.watchlist_ids()
        if not targets:
            raise ValueError("no enabled groups to run")
        out = []
        for wid in targets:
            pairs = self.enabled_pairs(wid, grp)
            if not pairs:
                if watchlist_id:
                    raise ValueError(f"no enabled pairs for watchlist={wid} group={shown!r}")
                continue
            scope = "*" if grp is None else f"group:{shown}"
            with self.tx():
                active = self.db.execute("SELECT id FROM runs WHERE watchlist_id=? AND COALESCE(scope,'*')=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", (wid, scope)).fetchone()
                if active:
                    out.append({"watchlist_id": wid, "group": shown, "run_id": active["id"], "existing": True})
                    continue
                run_id = self.enqueue(f"runnow:{wid}:{scope}:{uuid.uuid4().hex[:12]}", wid, pairs, self.get_watchlist(wid), scope=scope)
                self.event("run-now", f"{wid} scope={scope} by {requested_by}", run_id)
            out.append({"watchlist_id": wid, "group": shown, "run_id": run_id, "existing": False, "pairs": len(pairs)})
        if not out:
            raise ValueError(f"no enabled pairs for group={shown!r}")
        return out

    def cancel_run(self, run_id: str, reason: str = "cancelled by admin") -> bool:
        with self.tx():
            run = self.db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if not run or run["status"] not in ("queued", "running"):
                return False
            self.db.execute("UPDATE jobs SET status='cancelled', error=?, lease_token=NULL, lease_until=NULL WHERE run_id=? AND status IN ('queued','leased')", (reason, run_id))
            self.db.execute("UPDATE leases SET state='cancelled', finished_at=?, error=? WHERE run_id=? AND state='active'", (now_iso(), reason, run_id))
            self.db.execute("UPDATE runs SET error=? WHERE id=?", (reason, run_id))
            self._finalize(run_id, force_status="cancelled")
            self.event("cancel", reason, run_id, "warning")
        return True

    # -- per-keyword job core (shared by legacy and 2J paths) ------------------
    def _write_snapshot(self, job, settings: dict, day: str, item: dict) -> None:
        status = item["status"]
        found = status == "found"
        rank = item.get("organic_rank") if found else None
        page = item.get("page_number") if found else None
        pos = item.get("position_on_page") if found else None
        asin = norm_asin(item["asin"])
        target = next((t for t in json.loads(job["targets"]) if norm_asin(t.get("asin")) == asin), {})
        group = str(target.get("group") or "")
        owner_id, owner_name = target.get("owner_id") or None, target.get("owner_name") or None
        self.db.execute("INSERT OR REPLACE INTO snapshots(run_id,asin,keyword,snapshot_day,status,organic_rank,position_on_page,image_url,price_cents,page_number,grp,owner_id,owner_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (job["run_id"], asin, job["keyword"], day, status, rank, pos, item.get("image_url"), item.get("price_cents"), page, group, owner_id, owner_name))
        self.put_outbox("snapshots", f'{job["run_id"]}:{asin}:{job["keyword"]}', {
            "run_id": job["run_id"], "asin": asin, "keyword": job["keyword"], "snapshot_day": day,
            "status": "ranked" if found else status, "organic_rank": rank,
            "position_on_page": page_pos_label(page, pos),
            "image_url": item.get("image_url"), "price_cents": item.get("price_cents"),
            "marketplace": settings["marketplace"], "zip": settings["zip"], "group": group or None, "owner": [owner_id] if owner_id else None})

    def _fail_job(self, job, error: str) -> None:
        run = self.db.execute("SELECT settings FROM runs WHERE id=?", (job["run_id"],)).fetchone()
        settings = json.loads(run["settings"])
        self.db.execute("UPDATE jobs SET status='failed', error=?, lease_token=NULL, lease_until=NULL WHERE id=?", (error[:500], job["id"]))
        for target in json.loads(job["targets"]):
            self._write_snapshot(job, settings, local_day(), {"asin": target["asin"], "status": "unverified_parser_error"})

    def _complete_job(self, job, rows: list[dict], error: str | None = None, day: str | None = None) -> str:
        """rows use the internal shape {asin,status,organic_rank,page_number,position_on_page,image_url,price_cents}.
        Returns 'done' | 'requeued' | 'failed'. Caller holds the transaction."""
        run = self.db.execute("SELECT * FROM runs WHERE id=?", (job["run_id"],)).fetchone()
        settings = json.loads(run["settings"])
        expected = {v["asin"] for v in json.loads(job["targets"])}
        if not isinstance(rows, list):
            raise ValueError("rows must be a list")
        if error:
            if job["attempts"] < MAX_ATTEMPTS:
                blocked = re.search(r"captcha|blocked|robot", error, re.I)
                delay = (600 if blocked else 30) * max(1, job["attempts"])
                self.db.execute("UPDATE jobs SET status='queued', error=?, lease_token=NULL, lease_until=? WHERE id=?", (error[:500], iso_in(delay), job["id"]))
                return "requeued"
            self._fail_job(job, error)
            self._finalize(job["run_id"])
            return "failed"
        received = {norm_asin(v.get("asin")) for v in rows}
        if received != expected or len(rows) != len(expected):
            raise ValueError("result must contain exactly one row per target ASIN")
        for item in rows:
            status = str(item.get("status") or "unverified_parser_error")
            if status not in RESULT_STATUSES:
                raise ValueError("invalid result status")
            item["status"] = status
            rank = item.get("organic_rank")
            if status == "found" and (not isinstance(rank, int) or isinstance(rank, bool) or rank < 1 or rank > settings["top_n"]):
                raise ValueError("invalid organic_rank")
        self.db.execute("UPDATE jobs SET status='done', error=NULL, lease_token=NULL, lease_until=NULL WHERE id=?", (job["id"],))
        for item in rows:
            self._write_snapshot(job, settings, day if day and DAY_RE.fullmatch(day) else local_day(), item)
        self._finalize(job["run_id"])
        return "done"

    def _finalize(self, run_id: str, force_status: str | None = None) -> None:
        jobs = self.db.execute("SELECT status,targets,error FROM jobs WHERE run_id=?", (run_id,)).fetchall()
        if not force_status and (not jobs or any(j["status"] in ("queued", "leased") for j in jobs)):
            return
        run = self.db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if run["status"] in ("cancelled",) and not force_status:
            return
        counts = {r["status"]: r["n"] for r in self.db.execute("SELECT status,COUNT(*) n FROM snapshots WHERE run_id=? GROUP BY status", (run_id,))}
        failed_jobs = sum(j["status"] in ("failed", "cancelled") for j in jobs)
        if force_status:
            status = force_status
        else:
            status = "failed" if failed_jobs == len(jobs) else ("partial" if failed_jobs or counts.get("unverified_blocked", 0) or counts.get("unverified_parser_error", 0) else "success")
        errors = sorted({j["error"] for j in jobs if j["error"] and j["status"] != "done"})
        error = "; ".join(errors)[:500] or None
        finished = now_iso()
        settings = json.loads(run["settings"])
        self.db.execute("UPDATE runs SET status=?, finished_at=?, error=COALESCE(error,?) WHERE id=?", (status, finished, error, run_id))
        base_status = "failed" if status == "cancelled" else status
        run_groups = sorted({str(t.get("group") or "") for j in jobs for t in json.loads(j["targets"])} - {""})
        run_owners = sorted({str(t.get("owner_id") or "") for j in jobs for t in json.loads(j["targets"])} - {""})
        scope_note = f" · {scope_label(run['scope'])}" if run["scope"] and run["scope"] != "*" else ""
        self.put_outbox("runs", run_id, {"run_id": run_id, "watchlist_id": run["watchlist_id"], "marketplace": settings["marketplace"], "zip": settings["zip"], "top_n": settings["top_n"], "sponsored": settings["sponsored"], "started_at": run["created_at"], "finished_at": finished, "status": base_status, "pairs_total": sum(len(json.loads(j["targets"])) for j in jobs), "pairs_found": counts.get("found", 0), "pairs_not_found": counts.get("not_found", 0), "pairs_failed": counts.get("unverified_blocked", 0) + counts.get("unverified_parser_error", 0), "note": "RankFlow v2 · 2J" + scope_note + (" · cancelled" if status == "cancelled" else ""), "error": error, "groups": ", ".join(run_groups)[:1000] or None, "owners": run_owners or None})
        self.put_outbox("watchlists", run["watchlist_id"], {"last_run_at": finished, "last_run_status": base_status})
        if run["source_record_id"]:
            self.put_outbox("requests", run["source_record_id"], {"status": "cancelled" if status == "cancelled" else ("failed" if status == "failed" else "done"), "run_id": run_id, "result_status": status, "finished_at": finished})
        unverified = counts.get("unverified_blocked", 0) + counts.get("unverified_parser_error", 0)
        self.event("finalize", f"status={status} found={counts.get('found', 0)} not_found={counts.get('not_found', 0)} unverified={unverified}", run_id, "info" if status == "success" else "warning")

    # -- legacy per-keyword worker API (rankflow-v2/chrome-extension) ---------------
    def claim(self, worker_id: str) -> dict | None:
        with self.tx():
            self._reap()
            row = self.db.execute("SELECT j.*,r.watchlist_id,r.settings FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.status='queued' AND (j.lease_until IS NULL OR j.lease_until<?) AND r.status IN ('queued','running') ORDER BY r.created_at,j.rowid LIMIT 1", (now_iso(),)).fetchone()
            if not row:
                return None
            token = secrets.token_urlsafe(32)
            self.db.execute("UPDATE jobs SET status='leased',attempts=attempts+1,lease_token=?,lease_until=?,worker_id=? WHERE id=?", (token, iso_in(env_int("RANKFLOW_LEASE_SECONDS", 600)), worker_id, row["id"]))
            self.db.execute("UPDATE runs SET status='running' WHERE id=? AND status='queued'", (row["run_id"],))
            return {"job_id": row["id"], "run_id": row["run_id"], "watchlist_id": row["watchlist_id"], "keyword": row["keyword"], "targets": json.loads(row["targets"]), "settings": json.loads(row["settings"]), "lease_token": token}

    def _lease(self, job_id: str, token: str):
        row = self.db.execute("SELECT * FROM jobs WHERE id=? AND lease_token=? AND status='leased' AND lease_until>?", (job_id, token, now_iso())).fetchone()
        if not row:
            raise LeaseError("lease expired or token invalid")
        return row

    def heartbeat(self, job_id: str, token: str) -> None:
        with self.tx():
            self._lease(job_id, token)
            self.db.execute("UPDATE jobs SET lease_until=? WHERE id=?", (iso_in(env_int("RANKFLOW_LEASE_SECONDS", 600)), job_id))

    def complete(self, job_id: str, token: str, rows: list[dict], error: str | None = None) -> None:
        with self.tx():
            job = self._lease(job_id, token)
            if isinstance(rows, list):
                rows = [{**r, "page_number": as_int(r.get("page_number")), "position_on_page": as_int(r.get("position_on_page"))} for r in rows]
            self._complete_job(job, rows, error)

    # -- 2J run-level worker API -----------------------------------------------------
    def claim_run(self, worker_id: str) -> dict | None:
        """Lease every claimable keyword job of the oldest run under one token and return a 2J job."""
        with self.tx():
            self._reap()
            head = self.db.execute("SELECT j.run_id FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.status='queued' AND (j.lease_until IS NULL OR j.lease_until<?) AND r.status IN ('queued','running') ORDER BY r.created_at,j.rowid LIMIT 1", (now_iso(),)).fetchone()
            if not head:
                return None
            run = self.db.execute("SELECT * FROM runs WHERE id=?", (head["run_id"],)).fetchone()
            jobs = self.db.execute("SELECT * FROM jobs WHERE run_id=? AND status='queued' AND (lease_until IS NULL OR lease_until<?) ORDER BY rowid", (run["id"], now_iso())).fetchall()
            token = secrets.token_urlsafe(32)
            lease_seconds = env_int("RANKFLOW_LEASE_SECONDS", 600)
            ids = [j["id"] for j in jobs]
            self.db.execute(f"UPDATE jobs SET status='leased', attempts=attempts+1, lease_token=?, lease_until=?, worker_id=? WHERE id IN ({','.join('?' * len(ids))})", (token, iso_in(lease_seconds), worker_id[:100], *ids))
            self.db.execute("UPDATE runs SET status='running' WHERE id=? AND status='queued'", (run["id"],))
            self.db.execute("INSERT INTO leases(token,run_id,worker_id,state,claimed_at,heartbeat_at) VALUES(?,?,?,?,?,?)", (token, run["id"], worker_id[:100], "active", now_iso(), now_iso()))
            self.event("claim", f"{worker_id} leased {len(jobs)} keyword job(s)", run["id"])
            settings = json.loads(run["settings"])
            groups: dict[tuple, dict] = {}
            for j in jobs:
                for t in json.loads(j["targets"]):
                    label = t.get("group") or ""
                    owner_id = t.get("owner_id") or ""
                    g = groups.setdefault((t["asin"], label, owner_id), {"id": f'{run["watchlist_id"]}:{t["asin"]}' + (f":{label}" if label else "") + (f"@{owner_id}" if owner_id else ""), "name": label or t["asin"], "asins": [t["asin"]], "keywords": [],
                                                                         "owner": {"id": owner_id, "name": t.get("owner_name")} if owner_id else None})
                    g["keywords"].append(j["keyword"])
            return {
                "job_id": run["id"] + ":" + token[:8], "lease_token": token, "run_id": run["id"], "watchlist_id": run["watchlist_id"],
                "groups": list(groups.values()), "keywords_total": len(jobs), "pairs_total": sum(len(g["keywords"]) for g in groups.values()),
                "postalCode": settings["zip"], "setPostalCode": True, "includeSponsored": settings["sponsored"],
                "concurrency": max(1, min(2, env_int("RANKFLOW_2J_CONCURRENCY", 2))), "scope": run["scope"] or "*", "maxOrganic": settings["top_n"],
                "lease_seconds": lease_seconds, "heartbeat_seconds": max(15, min(lease_seconds // 4, 60)),
                "throttle": {"pageDelayMs": [env_int("RANKFLOW_2J_PAGE_DELAY_MIN_MS", 1500), env_int("RANKFLOW_2J_PAGE_DELAY_MAX_MS", 4000)],
                             "keywordDelayMs": [env_int("RANKFLOW_2J_KW_DELAY_MIN_MS", 2000), env_int("RANKFLOW_2J_KW_DELAY_MAX_MS", 6000)],
                             "captchaBackoffMs": env_int("RANKFLOW_2J_CAPTCHA_BACKOFF_MS", 90000)},
            }

    def lease_for(self, run_id: str | None = None, watchlist_id: str | None = None) -> str | None:
        """Compat: find the single active lease for a result body without lease_token (original 2J build)."""
        with self.lock:
            rows = self.db.execute("SELECT token FROM leases WHERE state='active' AND run_id=?", (run_id,)).fetchall() if run_id else []
            if not rows and watchlist_id:
                rows = self.db.execute("SELECT l.token FROM leases l JOIN runs r ON r.id=l.run_id WHERE l.state='active' AND r.watchlist_id=?", (watchlist_id,)).fetchall()
            if not rows and not run_id and not watchlist_id:
                rows = self.db.execute("SELECT token FROM leases WHERE state='active'").fetchall()
        return rows[0]["token"] if len(rows) == 1 else None

    def _lease_jobs(self, token: str):
        jobs = self.db.execute("SELECT * FROM jobs WHERE lease_token=? AND status='leased' ORDER BY rowid", (token,)).fetchall()
        if not jobs:
            lease = self.db.execute("SELECT state FROM leases WHERE token=?", (token,)).fetchone()
            raise LeaseError(f"lease {lease['state'] if lease else 'unknown'}")
        return jobs

    def heartbeat_run(self, token: str, progress: dict | None = None) -> dict:
        with self.tx():
            jobs = self._lease_jobs(token)
            until = iso_in(env_int("RANKFLOW_LEASE_SECONDS", 600))
            self.db.execute("UPDATE jobs SET lease_until=? WHERE lease_token=? AND status='leased'", (until, token))
            self.db.execute("UPDATE leases SET heartbeat_at=?, progress=? WHERE token=?", (now_iso(), json_text(progress or {})[:4000], token))
            return {"ok": True, "lease_until": until, "run_id": jobs[0]["run_id"]}

    @staticmethod
    def map_2j_row(row: dict, top_n: int) -> dict:
        """2J DirectRankRow -> internal row. Never invents a rank/position."""
        raw = str(row.get("status") or "").strip().lower()
        rank = as_int(row.get("organicRank", row.get("organic_rank")))
        page = as_int(row.get("pageNumber", row.get("page_number")))
        pos = as_int(row.get("positionOnPage", row.get("position_on_page")))
        if raw in ("ranked", "found"):
            status = "found" if rank and rank >= 1 else "unverified_parser_error"
            if status == "found" and rank > top_n:
                status = "not_found"  # outside the requested depth
        elif raw.startswith("not_found"):
            status = "not_found"
        elif raw.startswith("unverified"):
            status = "unverified_blocked" if "blocked" in raw else "unverified_parser_error"
        else:
            status = "unverified_parser_error"
        found = status == "found"
        return {"asin": norm_asin(row.get("asin")), "status": status,
                "organic_rank": rank if found else None, "page_number": page if found else None, "position_on_page": pos if found else None,
                "image_url": row.get("imageUrl", row.get("image_url")) or None, "price_cents": as_int(row.get("priceCents", row.get("price_cents")))}

    def complete_run(self, token: str, body: dict, error: str | None = None) -> dict:
        """POST /result (error=None) and POST /job/fail (error set). Rows for a keyword complete that keyword;
        keywords without rows are re-queued (or failed after MAX_ATTEMPTS)."""
        rows = body.get("rows") or []
        if not isinstance(rows, list):
            raise ValueError("rows must be a list")
        with self.tx():
            jobs = self._lease_jobs(token)
            run = self.db.execute("SELECT * FROM runs WHERE id=?", (jobs[0]["run_id"],)).fetchone()
            settings = json.loads(run["settings"])
            by_kw: dict[str, list[dict]] = {}
            for r in rows:
                if isinstance(r, dict):
                    by_kw.setdefault(kw_key(r.get("keyword")), []).append(r)
            outcome = {"done": 0, "requeued": 0, "failed": 0}
            for job in jobs:
                expected = [t["asin"] for t in json.loads(job["targets"])]
                krows: dict[str, dict] = {}
                for r in by_kw.get(kw_key(job["keyword"]), []):
                    asin = norm_asin(r.get("asin"))
                    if asin in expected and asin not in krows:
                        krows[asin] = r
                if not krows:
                    result = self._complete_job(job, [], error or "worker returned no rows for this keyword")
                else:
                    mapped = [self.map_2j_row(krows[a], settings["top_n"]) if a in krows else {"asin": a, "status": "unverified_parser_error"} for a in expected]
                    days = [str(r.get("snapshotDay") or r.get("snapshot_day") or "") for r in krows.values()]
                    result = self._complete_job(job, mapped, None, next((d for d in days if DAY_RE.fullmatch(d)), None))
                outcome[result] += 1
            warnings = [str(w)[:300] for w in (body.get("warnings") or []) if str(w).strip()][:20]
            meta = body.get("meta") if isinstance(body.get("meta"), dict) else None
            meta_text = json_text(meta)[:60000] if meta else None
            self.db.execute("UPDATE leases SET state=?, finished_at=?, error=?, meta=?, warnings=? WHERE token=?", ("failed" if error else "done", now_iso(), error[:500] if error else None, meta_text, json_text(warnings) if warnings else None, token))
            if error:
                self.db.execute("UPDATE runs SET error=? WHERE id=?", (error[:500], run["id"]))
            message = f"{outcome}" + (f" error={error[:200]}" if error else "") + (f" warnings={len(warnings)}: " + " | ".join(warnings)[:400] if warnings else "")
            self.event("fail" if error else "result", message, run["id"], "warning" if error or warnings else "info")
            status = self.db.execute("SELECT status FROM runs WHERE id=?", (run["id"],)).fetchone()["status"]
            return {"ok": True, "run_id": run["id"], "run_status": status, **outcome}

    # -- watchdog -------------------------------------------------------------------
    def _reap(self) -> int:
        expired = self.db.execute("SELECT * FROM jobs WHERE status='leased' AND lease_until<?", (now_iso(),)).fetchall()
        runs = set()
        for job in expired:
            runs.add(job["run_id"])
            if job["attempts"] >= MAX_ATTEMPTS:
                self._fail_job(job, f"lease expired after {MAX_ATTEMPTS} attempts (worker silent)")
            else:
                self.db.execute("UPDATE jobs SET status='queued', error='lease expired (worker silent)', lease_token=NULL, lease_until=? WHERE id=?", (iso_in(30 * job["attempts"]), job["id"]))
        if expired:
            self.db.execute("UPDATE leases SET state='expired', finished_at=? WHERE state='active' AND token NOT IN (SELECT lease_token FROM jobs WHERE status='leased' AND lease_token IS NOT NULL)", (now_iso(),))
            for run_id in runs:
                n = sum(j["run_id"] == run_id for j in expired)
                self.event("watchdog", f"lease expired: re-queued/failed {n} keyword job(s)", run_id, "warning")
                self._finalize(run_id)
        return len(expired)

    def reap_expired(self) -> int:
        with self.tx():
            return self._reap()

    # -- status ---------------------------------------------------------------------
    def status(self) -> dict:
        with self.lock:
            return {"runs": [dict(r) for r in self.db.execute("SELECT id,watchlist_id,status,created_at,finished_at,scope,error FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 10")],
                    "jobs": {r["status"]: r["n"] for r in self.db.execute("SELECT status,COUNT(*) n FROM jobs GROUP BY status")},
                    "outbox": self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
                    "outbox_by_kind": {r["kind"]: r["n"] for r in self.db.execute("SELECT kind,COUNT(*) n FROM outbox GROUP BY kind")},
                    "leases": [dict(r) for r in self.db.execute("SELECT run_id,worker_id,state,claimed_at,heartbeat_at,progress FROM leases WHERE state='active'")],
                    "events": [dict(r) for r in self.db.execute("SELECT at,level,kind,run_id,message FROM events ORDER BY id DESC LIMIT 20")]}

    def run_detail(self, run_id: str) -> dict | None:
        with self.lock:
            run = self.db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if not run:
                return None
            return {**dict(run), "settings": json.loads(run["settings"]),
                    "jobs": [{"keyword": j["keyword"], "status": j["status"], "attempts": j["attempts"], "error": j["error"]} for j in self.db.execute("SELECT * FROM jobs WHERE run_id=? ORDER BY rowid", (run_id,))],
                    "snapshots": [{**dict(s), "position_label": page_pos_label(s["page_number"], s["position_on_page"])} for s in self.db.execute("SELECT * FROM snapshots WHERE run_id=? ORDER BY grp, keyword, asin", (run_id,))],
                    "leases": [{**{k: l[k] for k in ("worker_id", "state", "claimed_at", "heartbeat_at", "finished_at", "error")},
                                "warnings": json.loads(l["warnings"]) if l["warnings"] else [], "meta": json.loads(l["meta"]) if l["meta"] else None}
                               for l in self.db.execute("SELECT * FROM leases WHERE run_id=? ORDER BY claimed_at", (run_id,))]}

    def worker_status(self) -> dict:
        with self.lock:
            last = self.db.execute("SELECT id,watchlist_id,status,created_at,finished_at,error FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT 1").fetchone()
            counts = {r["status"]: r["n"] for r in self.db.execute("SELECT status,COUNT(*) n FROM snapshots WHERE run_id=? GROUP BY status", (last["id"],))} if last else {}
            return {"ok": True, "server_time": now_iso(), "live_enabled": os.getenv("RANKFLOW_LIVE_ENABLED", "0") == "1",
                    "queued_runs": self.db.execute("SELECT COUNT(*) FROM runs WHERE status IN ('queued','running')").fetchone()[0],
                    "active_leases": [dict(r) for r in self.db.execute("SELECT run_id,worker_id,claimed_at,heartbeat_at,progress FROM leases WHERE state='active'")],
                    "last_run": {**dict(last), "counts": counts} if last else None,
                    "pairs_enabled": self.db.execute("SELECT COUNT(*) FROM items WHERE enabled=1").fetchone()[0],
                    "outbox": self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
                    "workers_seen": dict(self.workers_seen), "groups_version": self.groups_version()}


# ---------------------------------------------------------------------------
# 3. Lark
# ---------------------------------------------------------------------------
class Lark:
    def __init__(self, app_id: str, app_secret: str, base: str):
        self.app_id, self.app_secret, self.base = app_id, app_secret, base
        self.token = ""
        self.token_until = 0.0
        self.names: dict[str, dict[str, str]] = {}
        self.types: dict[str, dict[str, int]] = {}  # kind -> Base field name -> Lark field type

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        if path != "/auth/v3/tenant_access_token/internal" and time.time() > self.token_until - 120:
            auth = self.call("POST", "/auth/v3/tenant_access_token/internal", {"app_id": self.app_id, "app_secret": self.app_secret})
            self.token, self.token_until = auth["tenant_access_token"], time.time() + auth.get("expire", 7200)
        data = json_text(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if path != "/auth/v3/tenant_access_token/internal":
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(lark_api_base() + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.load(response)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Lark HTTP {e.code}: {e.read(300)!r}") from e
        if result.get("code") != 0:
            raise RuntimeError(f'Lark API {result.get("code")}: {result.get("msg")}')
        return result.get("data", result)

    def table_id(self, kind: str) -> str:
        if kind not in TABLES:
            override = os.getenv(f"RANKFLOW_TABLE_{kind.upper()}", "")
            if override:
                TABLES[kind] = override
            else:
                wanted = TABLE_NAMES[kind]
                by_name, page_token = {}, ""
                while True:
                    query = "?page_size=100" + ("&page_token=" + urllib.parse.quote(page_token) if page_token else "")
                    data = self.call("GET", f"/bitable/v1/apps/{self.base}/tables" + query)
                    by_name.update({t.get("name"): t.get("table_id") for t in data.get("items") or []})
                    page_token = data.get("page_token") or ""
                    if not data.get("has_more") or not page_token:
                        break
                if wanted not in by_name:
                    raise RuntimeError(f"Base table {wanted!r} not found (run `rankflow.py schema --create`)")
                TABLES[kind] = by_name[wanted]
        return TABLES[kind]

    def path(self, kind: str) -> str:
        return f"/bitable/v1/apps/{self.base}/tables/{self.table_id(kind)}"

    def fields(self, kind: str) -> dict[str, str]:
        if kind not in self.names:
            result = self.call("GET", self.path(kind) + "/fields?page_size=500")
            by_id = {f["field_id"]: f["field_name"] for f in result.get("items", [])}
            by_name = set(by_id.values())
            self.types[kind] = {f["field_name"]: f.get("type") for f in result.get("items", [])}
            self.names[kind] = {
                logical: logical if logical in by_name else by_id[field_id]
                for logical, field_id in FIELDS[kind].items()
                if logical in by_name or field_id in by_id
            }
            missing = set(FIELDS[kind]) - set(self.names[kind])
            if missing:
                raise RuntimeError(f"Missing Lark fields in {kind}: {sorted(missing)}")
            for name in OPTIONAL_FIELDS.get(kind, {}):
                if name in by_name:
                    self.names[kind][name] = name
        return self.names[kind]

    def missing_optional(self) -> dict[str, list[str]]:
        out = {}
        for kind, names in OPTIONAL_FIELDS.items():
            present = self.fields(kind)
            missing = [n for n in names if n not in present]
            if missing:
                out[kind] = missing
        return out

    def optional_type_mismatch(self) -> dict[str, dict]:
        """Optional columns that exist under the right name but with a different Lark type (left untouched)."""
        out = {}
        for kind, names in OPTIONAL_FIELDS.items():
            present = self.fields(kind)
            for name, ftype in names.items():
                actual = self.types.get(kind, {}).get(present.get(name))
                if name in present and actual is not None and actual != ftype:
                    out.setdefault(kind, {})[name] = {"expected": ftype, "actual": actual}
        return out

    def create_field(self, kind: str, name: str, field_type: int = 1) -> None:
        body = {"field_name": name, "type": field_type}
        if (kind, name) in FIELD_PROPERTIES:
            body["property"] = FIELD_PROPERTIES[(kind, name)]
        self.call("POST", self.path(kind) + "/fields", body)
        self.names.pop(kind, None)

    def batch_update(self, kind: str, updates: dict[str, dict]) -> int:
        """updates: {record_id: {logical_field: value}} -> PUT batch_update (<=500 per call)."""
        names = self.fields(kind)
        records = [{"record_id": rid, "fields": {names[k]: self.encode(kind, names[k], v) for k, v in fields.items() if k in names}} for rid, fields in updates.items()]
        for i in range(0, len(records), 500):
            self.call("POST", self.path(kind) + "/records/batch_update", {"records": records[i:i + 500]})
        return len(records)

    def list_records(self, kind: str) -> list[dict]:
        items, page_token = [], ""
        while True:
            query = "?page_size=500" + ("&page_token=" + urllib.parse.quote(page_token) if page_token else "")
            data = self.call("GET", self.path(kind) + "/records" + query)
            items.extend(data.get("items") or [])
            if not data.get("has_more"):
                return items
            page_token = data.get("page_token")
            if not page_token:
                raise RuntimeError("Lark pagination missing page_token")

    def logical(self, kind: str, record: dict) -> dict:
        raw = record.get("fields", {})
        names = self.fields(kind)
        types = self.types.get(kind, {})
        # user cells keep their structure ([{id, name, email?}]); cell() would flatten them to ''
        return {key: (raw.get(name) or None) if types.get(name) == USER_FIELD else cell(raw.get(name)) for key, name in names.items()}

    def encode(self, kind: str, name: str, value):
        """Bitable v1 wants URL cells (type 15) as {text, link}; a bare string fails with 1254068 URLFieldConvFail."""
        ftype = self.types.get(kind, {}).get(name)
        if ftype == 15 and isinstance(value, str):
            return {"text": value, "link": value}
        if ftype == USER_FIELD:  # Bitable v1 user cell: [{"id": "ou_…"}] (open_id of this app); [] clears it
            values = value if isinstance(value, list) else [value]
            return [{"id": v["id"]} if isinstance(v, dict) else {"id": str(v)} for v in values if v]
        return value

    def write(self, kind: str, payload: dict, record_id: str | None = None) -> str:
        names = self.fields(kind)
        fields = {names[key]: self.encode(kind, names[key], value) for key, value in payload.items() if key in names and value is not None}
        path = self.path(kind) + "/records" + ("/" + record_id if record_id else "")
        data = self.call("PUT" if record_id else "POST", path, {"fields": fields})
        return record_id or data.get("record", {}).get("record_id", "")


# ---------------------------------------------------------------------------
# 4. Engine
# ---------------------------------------------------------------------------
# Org members (Lark contact) -> local cache + Base table `member` (source of the block's owner picker)
# ---------------------------------------------------------------------------
MEMBER_TABLE = "member"
# Name + avatar only (by design): no email in Base/block; a legacy `email` column is deleted.
MEMBER_FIELDS = [("name", 1, None), ("open_id", 1, None), ("person", USER_FIELD, {"multiple": False}), ("en_name", 1, None),
                 ("avatar_url", 15, None), ("departments", 1, None), ("active", 7, None), ("updated_at", 1, None)]
MEMBER_DROP_FIELDS = ("email",)
CONTACT_IDS = "user_id_type=open_id&department_id_type=open_department_id"


def _contact_pages(lark: "Lark", path: str, key: str = "items"):
    token = ""
    for _ in range(1000):
        sep = "&" if "?" in path else "?"
        data = lark.call("GET", path + sep + "page_size=50" + ("&page_token=" + urllib.parse.quote(token) if token else ""))
        yield data
        if not data.get("has_more"):
            return
        token = data.get("page_token") or ""
        if not token:
            return


def _member_from_user(u: dict, dept_names: dict[str, str]) -> dict:
    status = u.get("status") or {}
    avatar = u.get("avatar") or {}
    return {"open_id": u["open_id"], "name": u.get("name") or u.get("en_name") or u["open_id"], "en_name": u.get("en_name") or None,
            "avatar_url": avatar.get("avatar_240") or avatar.get("avatar_72") or None,
            "departments": sorted({dept_names.get(d, "") for d in (u.get("department_ids") or [])} - {""}),
            "active": not (status.get("is_resigned") or status.get("is_exited") or status.get("is_frozen"))}


def fetch_members(lark: "Lark") -> tuple[list[dict], dict]:
    """Every person in the app's contact data range: scope departments (recursive) + scope users. open_ids are this app's."""
    users, departments, scope_users = {}, set(), []
    for page in _contact_pages(lark, f"/contact/v3/scopes?{CONTACT_IDS}"):
        departments.update(page.get("department_ids") or [])
        scope_users.extend(page.get("user_ids") or [])
    dept_names: dict[str, str] = {}
    try:
        dept_names["0"] = (lark.call("GET", "/tenant/v2/tenant/query").get("tenant") or {}).get("name") or ""
    except Exception:
        dept_names["0"] = ""
    all_depts = set()
    for d in sorted(departments):
        all_depts.add(d)
        if d != "0" and d not in dept_names:
            try:
                dept_names[d] = (lark.call("GET", f"/contact/v3/departments/{d}?{CONTACT_IDS}").get("department") or {}).get("name") or ""
            except Exception:
                dept_names[d] = ""
        for page in _contact_pages(lark, f"/contact/v3/departments/{d}/children?fetch_child=true&{CONTACT_IDS}"):
            for item in page.get("items") or []:
                did = item.get("open_department_id") or item.get("department_id")
                if did:
                    all_depts.add(did)
                    dept_names.setdefault(did, item.get("name") or "")
    for d in sorted(all_depts):
        for page in _contact_pages(lark, f"/contact/v3/users/find_by_department?department_id={urllib.parse.quote(d)}&{CONTACT_IDS}"):
            for u in page.get("items") or []:
                if u.get("open_id"):
                    users[u["open_id"]] = u
    missing = [u for u in dict.fromkeys(scope_users) if u not in users]
    for i in range(0, len(missing), 50):
        chunk = missing[i:i + 50]
        try:
            data = lark.call("GET", "/contact/v3/users/batch?" + "&".join("user_ids=" + urllib.parse.quote(u) for u in chunk) + "&" + CONTACT_IDS)
            for u in data.get("items") or []:
                users[u["open_id"]] = u
        except Exception:
            for uid in chunk:
                users[uid] = lark.call("GET", f"/contact/v3/users/{uid}?{CONTACT_IDS}")["user"]
    members = sorted((_member_from_user(u, dept_names) for u in users.values() if u.get("open_id")), key=lambda m: m["name"].lower())
    return members, {"scope_departments": sorted(departments), "scope_users": len(scope_users), "departments_walked": len(all_depts), "members": len(members),
                     "active": sum(1 for m in members if m["active"]), "tenant": dept_names.get("0") or None}


class UserSourceError(RuntimeError):
    pass


def lark_cli_user_get(path: str, params: dict) -> dict:
    """GET an open-api path as the lark-cli USER identity (the operator's `lark-cli auth login`, same app as LARK_APP_ID). Never logs tokens."""
    exe = os.getenv("RANKFLOW_LARK_CLI") or shutil.which("lark-cli")
    if not exe:
        raise UserSourceError("lark-cli not found")
    env = {k: v for k, v in os.environ.items() if k != "LARKSUITE_CLI_APP_SECRET"}  # an injected secret without app id confuses lark-cli
    try:
        proc = subprocess.run([exe, "api", "GET", "/open-apis" + path, "--params", json.dumps(params), "--as", "user"],
                              capture_output=True, text=True, timeout=90, env=env, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise UserSourceError(f"lark-cli failed: {type(e).__name__}") from e
    try:
        out = json.loads(proc.stdout or "{}")
    except ValueError as e:
        raise UserSourceError(f"lark-cli returned non-JSON (exit {proc.returncode})") from e
    if not out.get("ok"):
        err = out.get("error") or {}
        raise UserSourceError(f'lark-cli {err.get("type", "error")}/{err.get("subtype", "")} {err.get("code", "")}: {str(err.get("message", ""))[:160]}')
    data = out.get("data") or {}
    return data.get("data", data) if isinstance(data.get("data"), dict) else data


def _user_pages(path: str, params: dict, get=lark_cli_user_get):
    token = ""
    for _ in range(1000):
        page = get(path, {**params, "page_size": 50, **({"page_token": token} if token else {})})
        yield page
        if not page.get("has_more"):
            return
        token = page.get("page_token") or ""
        if not token:
            return


def fetch_members_as_user(get=lark_cli_user_get, root_name: str = "") -> tuple[list[dict], dict]:
    """Whole org as the user identity: department 0 + every sub-department (recursive), paginated.
    Basic profile only (name, en_name, avatar, open_id); department = the department it was listed under."""
    ids = {"user_id_type": "open_id", "department_id_type": "open_department_id"}
    depts = {"0": root_name}
    for page in _user_pages("/contact/v3/departments/0/children", {**ids, "fetch_child": "true"}, get):
        for item in page.get("items") or []:
            did = item.get("open_department_id") or item.get("department_id")
            if did:
                depts[did] = item.get("name") or ""
    users: dict[str, dict] = {}
    for did in depts:
        for page in _user_pages("/contact/v3/users/find_by_department", {**ids, "department_id": did}, get):
            for u in page.get("items") or []:
                if not u.get("open_id"):
                    continue
                cur = users.setdefault(u["open_id"], {**u, "department_ids": []})
                cur["department_ids"].append(did)
    members = sorted((_member_from_user(u, depts) for u in users.values()), key=lambda m: m["name"].lower())
    return members, {"members": len(members), "departments_walked": len(depts)}


def merge_member_sources(app_members: list[dict], user_members: list[dict]) -> tuple[list[dict], dict]:
    """Union by open_id. The app token knows status (active) for its range; the user listing has everyone (basic profile)."""
    app_by = {m["open_id"]: m for m in app_members}
    merged = {m["open_id"]: dict(m) for m in user_members}
    for oid, m in app_by.items():
        cur = merged.get(oid)
        if cur is None:
            merged[oid] = dict(m)
            continue
        cur["active"] = m.get("active", True)
        for key in ("name", "en_name", "avatar_url"):
            cur[key] = cur.get(key) or m.get(key)
        cur["departments"] = sorted(set(cur.get("departments") or []) | set(m.get("departments") or []))
    both = sorted(set(app_by) & {m["open_id"] for m in user_members})
    members = sorted(merged.values(), key=lambda m: m["name"].lower())
    return members, {"app_only": len(set(app_by) - set(both)), "user_only": len(user_members) - len(both), "in_both": len(both),
                     "open_id_matched": bool(both) or not app_by or not user_members}


def ensure_member_table(lark: "Lark") -> tuple[str, list[str]]:
    """Create Base table `member` (and any missing column) idempotently; returns (table_id, created)."""
    base = f"/bitable/v1/apps/{lark.base}/tables"
    tables = [t for page in _contact_pages(lark, base) for t in page.get("items") or []]
    hit = next((t for t in tables if t.get("name") == MEMBER_TABLE), None)
    if not hit:
        body = {"table": {"name": MEMBER_TABLE, "default_view_name": "Grid", "fields": [{"field_name": n, "type": t, **({"property": p} if p else {})} for n, t, p in MEMBER_FIELDS]}}
        table_id = lark.call("POST", base, body)["table_id"]
        return table_id, ["table"] + [n for n, _, _ in MEMBER_FIELDS]
    table_id = hit["table_id"]
    metas = lark.call("GET", f"{base}/{table_id}/fields?page_size=500").get("items") or []
    present = {f["field_name"] for f in metas}
    created = []
    for f in metas:
        if f["field_name"] in MEMBER_DROP_FIELDS and f.get("field_id"):
            lark.call("DELETE", f"{base}/{table_id}/fields/{f['field_id']}")
            created.append("-" + f["field_name"])
    for name, ftype, prop in MEMBER_FIELDS:
        if name not in present:
            lark.call("POST", f"{base}/{table_id}/fields", {"field_name": name, "type": ftype, **({"property": prop} if prop else {})})
            created.append(name)
    return table_id, created


def _member_cells(m: dict) -> dict:
    return {"name": m["name"], "open_id": m["open_id"], "person": [{"id": m["open_id"]}], "en_name": m.get("en_name") or None,
            "avatar_url": {"text": m["avatar_url"], "link": m["avatar_url"]} if m.get("avatar_url") else None,
            "departments": ", ".join(m.get("departments") or []) or None, "active": bool(m.get("active", True))}


def _member_differs(raw: dict, want: dict) -> bool:
    for key, value in want.items():
        cur = raw.get(key)
        if key == "person":
            if (owner_from_cell(cur) or {}).get("id") != value[0]["id"]:
                return True
        elif key == "avatar_url":
            cur_link = cur.get("link") if isinstance(cur, dict) else cell(cur) or None
            if (cur_link or None) != (value or {}).get("link"):
                return True
        elif key == "active":
            if bool(cur) != value:
                return True
        elif (cell(cur) or None) != (value or None):
            return True
    return False


def sync_members_to_base(lark: "Lark", members: list[dict], deactivate_missing: bool = True) -> dict:
    table_id, created = ensure_member_table(lark)
    path = f"/bitable/v1/apps/{lark.base}/tables/{table_id}/records"
    existing: dict[str, tuple[str, dict]] = {}
    for page in _contact_pages(lark, path):
        for r in page.get("items") or []:
            oid = cell((r.get("fields") or {}).get("open_id"))
            if oid and oid not in existing:
                existing[oid] = (r["record_id"], r.get("fields") or {})
    creates, updates, now = [], [], local_iso()
    for m in members:
        want = _member_cells(m)
        if m["open_id"] not in existing:
            creates.append({"fields": {k: v for k, v in want.items() if v is not None} | {"updated_at": now}})
        else:
            rid, raw = existing[m["open_id"]]
            if _member_differs(raw, want):
                fields = {k: v for k, v in want.items() if v is not None or raw.get(k) not in (None, "", [])}
                updates.append({"record_id": rid, "fields": fields | {"updated_at": now}})
    seen = {m["open_id"] for m in members}
    deactivated = 0
    if members and deactivate_missing:  # never mass-deactivate on an empty/partial (failed) fetch
        for oid, (rid, raw) in existing.items():
            if oid not in seen and raw.get("active"):
                updates.append({"record_id": rid, "fields": {"active": False, "updated_at": now}})
                deactivated += 1
    for i in range(0, len(creates), 500):
        lark.call("POST", path + "/batch_create", {"records": creates[i:i + 500]})
    for i in range(0, len(updates), 500):
        lark.call("POST", path + "/batch_update", {"records": updates[i:i + 500]})
    return {"table_id": table_id, "created_columns": created, "created": len(creates), "updated": len(updates) - deactivated, "deactivated": deactivated, "unchanged": len(members) - len(creates) - (len(updates) - deactivated)}


# ---------------------------------------------------------------------------
class Engine:
    def __init__(self, store: Store, lark: Lark | None):
        self.store, self.lark = store, lark
        self.last_pull = -1e9
        self.last_sync = -1e9
        self.last_reap = -1e9
        self._tick_lock = threading.Lock()  # serve() ticks from 2 threads; overlapping sync() wrote every outbox row twice

    def sync_members(self, write_base: bool = True, source: str = "auto", user_get=None) -> dict:
        """Lark contact -> local members cache (+ Base table `member` when write_base).
        source: auto = app token (its contact range) + lark-cli user identity (whole org), merged by open_id;
        app / user = only that one. If the user listing fails, existing rows are kept (no deactivation) and a warning is logged."""
        if not self.lark:
            return {"skipped": "lark disabled"}
        app_members, stats = fetch_members(self.lark) if source in ("auto", "app") else ([], {"members": 0, "active": 0})
        complete = True
        if source in ("auto", "user"):
            try:
                user_members, ustats = fetch_members_as_user(user_get or lark_cli_user_get, stats.get("tenant") or "")
                stats["user_source"] = ustats
                members, mstats = merge_member_sources(app_members, user_members)
                stats["merge"] = mstats
                if not mstats["open_id_matched"]:
                    raise UserSourceError("open_ids of the user listing do not match the app token's (different app?)")
            except UserSourceError as e:
                LOG.warning("Member sync: user-identity listing failed (%s); keeping existing members, no deactivation", e)
                stats["user_source"] = {"error": str(e)}
                members, complete = app_members, False
        else:
            members = app_members
            complete = source == "app"
        stats["members"], stats["active"], stats["complete"] = len(members), sum(1 for m in members if m.get("active", True)), complete
        stats["local"] = self.store.save_members(members, deactivate_missing=complete)
        if write_base:
            stats["base"] = sync_members_to_base(self.lark, members, deactivate_missing=complete)
        self.store.event("members", f'{stats["members"]} members ({stats["active"]} active) · base {stats.get("base", {}).get("created", 0)} new / {stats.get("base", {}).get("updated", 0)} updated')
        return stats

    def pull(self) -> None:
        if not self.lark:
            return
        watchlists = self.lark.list_records("watchlists")
        items = self.lark.list_records("items")
        wl_rows = [(r["record_id"], self.lark.logical("watchlists", r)) for r in watchlists]
        self.store.mirror_from_base(wl_rows, [(r["record_id"], self.lark.logical("items", r)) for r in items])
        local_now = datetime.now(tz())
        for _, row in wl_rows:
            wid = str(row.get("watchlist_id") or "").strip()
            if not wid:
                continue
            days = {v.strip() for v in str(row.get("schedule_days") or "").split(",")}
            hhmm = str(row.get("schedule_time") or "")
            try:
                scheduled_at = local_now.replace(hour=int(hhmm[:2]), minute=int(hhmm[3:]), second=0, microsecond=0)
                in_window = 0 <= (local_now - scheduled_at).total_seconds() <= env_int("RANKFLOW_SCHEDULE_GRACE_MINUTES", 30) * 60
            except (ValueError, TypeError):
                in_window = False
            if row.get("schedule_enabled") is True and DAY_NAMES[local_now.weekday()] in days and in_window:
                try:
                    self.store.enqueue(f"schedule:{wid}:{local_now.date()}:{hhmm}", wid, self.store.enabled_pairs(wid), self.store.get_watchlist(wid), scope="*")
                except ValueError as e:
                    LOG.warning("Skipped schedule %s: %s", wid, e)
        known = {str(row.get("watchlist_id") or "").strip() for _, row in wl_rows}
        for record in self.lark.list_records("requests"):
            req = self.lark.logical("requests", record)
            if req.get("status") != "pending":
                continue
            try:
                requested_at = datetime.fromisoformat(str(req.get("requested_at") or "").replace("Z", "+00:00"))
                age_hours = (now_dt() - requested_at.astimezone(timezone.utc)).total_seconds() / 3600
                if not 0 <= age_hours <= float(os.getenv("RANKFLOW_REQUEST_MAX_AGE_HOURS", "2")):
                    continue
            except ValueError:
                LOG.warning("Pending request %s has invalid requested_at", record["record_id"])
                continue
            wid = str(req.get("watchlist_id") or "").strip()
            if wid not in known:
                LOG.warning("Pending request %s has no watchlist", record["record_id"])
                continue
            try:
                self.store.enqueue("request:" + str(req.get("request_id") or record["record_id"]), wid, self.store.enabled_pairs(wid), self.store.get_watchlist(wid), record["record_id"], scope="*")
            except ValueError as e:
                LOG.warning("Skipped request %s: %s", record["record_id"], e)

    def _watchlist_map(self, remote_maps: dict) -> dict:
        if "watchlists" not in remote_maps:
            remote_maps["watchlists"] = {str(self.lark.logical("watchlists", r).get("watchlist_id")): r["record_id"] for r in self.lark.list_records("watchlists")}
        return remote_maps["watchlists"]

    def sync(self, limit: int = 30) -> None:
        if not self.lark:
            return
        with self.store.lock:
            # snapshots before runs/requests: the block reloads the heatmap as soon as run_request turns done,
            # so a final request status must only reach Base after that run's snapshots are written.
            pending = [dict(r) for r in self.store.db.execute("SELECT * FROM outbox WHERE next_at<=? ORDER BY CASE kind WHEN 'watchlist_settings' THEN 0 WHEN 'items' THEN 1 WHEN 'snapshots' THEN 2 WHEN 'runs' THEN 3 WHEN 'requests' THEN 4 ELSE 5 END, next_at LIMIT ?", (now_iso(), limit))]
        if not pending:
            return
        remote_maps: dict[str, dict[str, str]] = {}
        for row in pending:
            kind, key, payload = row["kind"], row["key"], json.loads(row["payload"])
            if kind == "requests" and payload.get("status") in FINAL_REQUEST_STATUSES and payload.get("run_id"):
                with self.store.lock:
                    waiting = self.store.db.execute("SELECT COUNT(*) FROM outbox WHERE kind='snapshots' AND key LIKE ? AND attempts<?", (payload["run_id"] + ":%", SNAPSHOT_WAIT_ATTEMPTS)).fetchone()[0]
                if waiting:
                    continue  # keep the request "running" until its snapshots are in Base (a later tick retries)
            try:
                if kind in ("snapshots", "runs"):
                    if kind not in remote_maps:
                        remote_maps[kind] = {}
                        for remote in self.lark.list_records(kind):
                            values = self.lark.logical(kind, remote)
                            remote_key = values.get("run_id") if kind == "runs" else f'{values.get("run_id")}:{values.get("asin")}:{values.get("keyword")}'
                            remote_maps[kind][str(remote_key)] = remote["record_id"]
                    record_id = remote_maps[kind].get(key)
                    new_id = self.lark.write(kind, payload, record_id)
                    if not record_id:
                        remote_maps[kind][key] = new_id
                elif kind == "requests":
                    self.lark.write(kind, payload, key)
                elif kind == "items":
                    if "items" not in remote_maps:
                        remote_maps["items"] = {}
                        for remote in self.lark.list_records("items"):
                            v = self.lark.logical("items", remote)
                            k = item_key(str(v.get("watchlist_id") or "").strip(), v.get("asin"), v.get("keyword"))
                            if k not in remote_maps["items"] or v.get("enabled") is True:
                                remote_maps["items"][k] = remote["record_id"]
                    record_id = remote_maps["items"].get(key)
                    new_id = self.lark.write("items", payload, record_id)
                    remote_maps["items"][key] = new_id
                    with self.store.lock:
                        self.store.db.execute("UPDATE items SET base_record_id=? WHERE watchlist_id=? AND asin=? AND keyword_key=?", (new_id, payload["watchlist_id"], norm_asin(payload["asin"]), kw_key(payload["keyword"])))
                elif kind == "watchlist_settings":
                    wl_map = self._watchlist_map(remote_maps)
                    record_id = wl_map.get(key)
                    wl_map[key] = self.lark.write("watchlists", payload if record_id else {**payload, "marketplace": "US"}, record_id)
                else:
                    record_id = self._watchlist_map(remote_maps).get(key)
                    if not record_id:
                        raise RuntimeError(f"watchlist {key} not found")
                    self.lark.write("watchlists", payload, record_id)
                with self.store.lock:
                    self.store.db.execute("DELETE FROM outbox WHERE kind=? AND key=? AND payload=?", (kind, key, row["payload"]))
            except Exception as e:
                delay = min(3600, 15 * 2 ** min(row["attempts"], 8))
                with self.store.lock:
                    self.store.db.execute("UPDATE outbox SET attempts=attempts+1,next_at=? WHERE kind=? AND key=?", (iso_in(delay), kind, key))
                LOG.warning("Sync %s %s failed: %s", kind, key, e)

    def tick(self):
        if not self._tick_lock.acquire(blocking=False):
            return  # a tick (pull/sync) is already running in another thread
        try:
            self._tick()
        finally:
            self._tick_lock.release()

    def _tick(self):
        current = time.monotonic()
        if current - self.last_reap >= 15:
            try:
                self.store.reap_expired()
            except Exception:
                LOG.exception("Watchdog failed")
            self.last_reap = current
        if current - self.last_pull >= env_int("RANKFLOW_PULL_SECONDS", 30):
            try:
                self.pull()
            except Exception:
                LOG.exception("Lark pull failed")
            self.last_pull = current
        if current - self.last_sync >= 10:
            try:
                self.sync()
            except Exception:
                LOG.exception("Lark sync failed")
            self.last_sync = current


# ---------------------------------------------------------------------------
# 5. HTTP
# ---------------------------------------------------------------------------
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
WORKER_POSTS = ("/result", "/job/fail", "/job/heartbeat", "/worker/run-now")


def make_handler(engine: Engine, worker_token: str, admin_token: str):
    store = engine.store

    class Handler(BaseHTTPRequestHandler):
        server_version = "RankFlow/2"

        def log_message(self, fmt, *args):
            LOG.debug("%s %s", self.address_string(), fmt % args)

        def cors_origin(self) -> str | None:
            origin = self.headers.get("Origin", "")
            return origin if origin.startswith("chrome-extension://") else None

        def reply(self, code: int, data: dict | None, headers: dict | None = None):
            raw = b"" if data is None else json_text(data).encode()
            self.send_response(code)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            if data is not None:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            origin = self.cors_origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def admin_ok(self) -> bool:
            supplied = self.headers.get("X-Admin-Token", "")
            if not admin_token or not hmac.compare_digest(supplied, admin_token):
                self.reply(401, {"error": "unauthorized"})
                return False
            return True

        def worker_ok(self) -> bool:
            """Worker token (X-Worker-Token or Bearer) or, from loopback only, an extension request that
            carries X-Worker-Id and no web-page Origin (blocks drive-by requests from websites)."""
            supplied = self.headers.get("X-Worker-Token", "") or self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if supplied and worker_token and hmac.compare_digest(supplied, worker_token):
                return True
            origin = self.headers.get("Origin", "")
            if (self.client_address[0] in LOOPBACK and os.getenv("RANKFLOW_2J_LOOPBACK_NOAUTH", "1") == "1" and not supplied
                    and (not origin or origin.startswith("chrome-extension://"))
                    and (self.headers.get("X-Worker-Id") or os.getenv("RANKFLOW_2J_LEGACY_NOAUTH", "0") == "1")):
                return True
            self.reply(401, {"error": "unauthorized"})
            return False

        def body(self, max_size: int = 1_000_000) -> dict:
            size = int(self.headers.get("Content-Length", "0") or 0)
            if size < 1 or size > max_size:
                raise ValueError("invalid body size")
            if "json" not in self.headers.get("Content-Type", ""):
                raise ValueError("Content-Type application/json required")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError("JSON object required")
            return data

        def route(self):
            parts = urllib.parse.urlsplit(self.path)
            return parts.path.rstrip("/") or "/", {k: v[-1] for k, v in urllib.parse.parse_qs(parts.query).items()}

        def tail(self, path: str, prefix: str) -> str:
            return urllib.parse.unquote(path[len(prefix):])

        def handle_safely(self, fn):
            try:
                fn()
            except LeaseError as e:
                self.reply(409, {"error": str(e), "cancel": True})
            except (ValueError, KeyError, TypeError) as e:
                self.reply(400, {"error": str(e)})
            except Exception as e:  # pragma: no cover - defensive
                LOG.exception("handler error")
                self.reply(500, {"error": str(e)[:300]})

        def do_OPTIONS(self):
            self.send_response(204)
            origin = self.cors_origin()
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Worker-Id, X-Worker-Token, Authorization")
                self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            self.handle_safely(self._get)

        def _get(self):
            path, q = self.route()
            if path == "/health":
                return self.reply(200, {"ok": True, "service": "rankflow-v2", "api": "2j-worker/1"})
            if path in ("/job", "/worker/groups", "/worker/status", "/api/jobs/claim"):
                if not self.worker_ok():
                    return
                worker_id = self.headers.get("X-Worker-Id", "2j-legacy")[:100]
                if path == "/job":
                    # Long-poll: ?wait=N (<=25 s; Chrome aborts extension fetches that take >30 s). Wakes on enqueue.
                    try:
                        wait = max(0.0, min(25.0, float(q.get("wait") or 0)))
                    except ValueError:
                        wait = 0.0
                    deadline = time.monotonic() + wait
                    while True:
                        store.workers_seen[worker_id] = now_iso()
                        job = store.claim_run(worker_id)
                        remaining = deadline - time.monotonic()
                        if job is not None or remaining <= 0:
                            break
                        store.wait_for_jobs(min(1.0, remaining))
                    extra = {"X-Groups-Version": store.groups_version(), "Access-Control-Expose-Headers": "X-Groups-Version"}
                    return self.reply(204, None, extra) if job is None else self.reply(200, job, extra)
                if path == "/worker/groups":
                    wid = q.get("watchlist_id")
                    ids = [wid] if wid else store.watchlist_ids()
                    return self.reply(200, {"groups": store.list_groups(wid), "watchlists": {w: store.get_watchlist(w) for w in ids}, "server_time": now_iso(), "version": store.groups_version()})
                if path == "/worker/status":
                    return self.reply(200, store.worker_status())
                return self.reply(200, {"job": store.claim(worker_id)})
            if not path.startswith("/api/"):
                return self.reply(404, {"error": "not found"})
            if not self.admin_ok():
                return
            if path == "/api/status":
                return self.reply(200, store.status())
            if path == "/api/groups":
                return self.reply(200, {"groups": store.list_groups(q.get("watchlist_id"), as_bool(q.get("all", "0")))})
            if path.startswith("/api/watchlists/"):
                return self.reply(200, store.get_watchlist(self.tail(path, "/api/watchlists/")))
            if path.startswith("/api/runs/"):
                detail = store.run_detail(self.tail(path, "/api/runs/"))
                return self.reply(200, detail) if detail else self.reply(404, {"error": "run not found"})
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            self.handle_safely(self._post)

        def _post(self):
            path, _ = self.route()
            if path in WORKER_POSTS:
                if not self.worker_ok():
                    return
                body = self.body(100_000 if path == "/job/heartbeat" else 8_000_000)
                if path == "/worker/run-now":
                    return self.reply(202, {"runs": store.run_now(body.get("watchlist_id"), body.get("group"), "worker:" + self.headers.get("X-Worker-Id", "?")[:60])})
                token = str(body.get("lease_token") or "") or store.lease_for(body.get("run_id"), body.get("watchlist_id"))
                if not token:
                    raise LeaseError("lease_token required (no unique active lease)")
                if path == "/job/heartbeat":
                    return self.reply(200, store.heartbeat_run(token, body.get("progress")))
                if path == "/job/fail":
                    return self.reply(200, store.complete_run(token, body, str(body.get("error") or "worker reported failure")[:500]))
                return self.reply(200, store.complete_run(token, body))
            if path.startswith("/api/jobs/"):
                if not self.worker_ok():
                    return
                seg = path.split("/")
                if len(seg) != 5 or seg[4] not in ("heartbeat", "complete"):
                    return self.reply(404, {"error": "not found"})
                body = self.body()
                try:
                    if seg[4] == "heartbeat":
                        store.heartbeat(seg[3], body.get("lease_token", ""))
                    else:
                        store.complete(seg[3], body.get("lease_token", ""), body.get("rows", []), body.get("error"))
                except ValueError as e:
                    return self.reply(409, {"error": str(e)})
                return self.reply(200, {"ok": True})
            if not path.startswith("/api/"):
                return self.reply(404, {"error": "not found"})
            if not self.admin_ok():
                return
            body = self.body(6_000_000)
            wid = body.get("watchlist_id") or default_watchlist()
            if path == "/api/runs":
                source_key = body.get("source_key") or "api:" + uuid.uuid4().hex
                return self.reply(202, {"run_id": store.enqueue(source_key, body["watchlist_id"], body["pairs"], body.get("settings", {}))})
            if path == "/api/run-now":
                return self.reply(202, {"runs": store.run_now(body.get("watchlist_id"), body.get("group"), "admin-api")})
            if path == "/api/groups":
                return self.reply(200, {"ok": True, **store.upsert_items(wid, expand_entries(body), "api")})
            if path == "/api/items/delete":
                n = store.disable_items(wid, group=body.get("group"), asin=body.get("asin"), keywords=split_keywords(body.get("keywords")) or None, pairs=body.get("pairs"), source="api")
                return self.reply(200, {"ok": True, "disabled": n})
            if path == "/api/import":
                entries = parse_import(body.get("data"), body.get("format"))
                return self.reply(200, {"ok": True, **store.import_entries(wid, entries, bool(body.get("replace")), "import")})
            if path.startswith("/api/runs/") and path.endswith("/cancel"):
                ok = store.cancel_run(self.tail(path[: -len("/cancel")], "/api/runs/"), str(body.get("reason") or "cancelled by admin"))
                return self.reply(200 if ok else 409, {"ok": ok})
            self.reply(404, {"error": "not found"})

        def do_PUT(self):
            self.handle_safely(self._put)

        def _put(self):
            path, _ = self.route()
            if not self.admin_ok():
                return
            body = self.body(6_000_000)
            if path.startswith("/api/groups/"):
                group = self.tail(path, "/api/groups/")
                return self.reply(200, {"ok": True, **store.replace_group(body.get("watchlist_id") or default_watchlist(), group, expand_entries(body, group), "api")})
            if path.startswith("/api/watchlists/"):
                return self.reply(200, store.set_watchlist(self.tail(path, "/api/watchlists/"), body.get("zip"), body.get("top_n"), body.get("sponsored"), body.get("name")))
            self.reply(404, {"error": "not found"})

        def do_DELETE(self):
            self.handle_safely(self._delete)

        def _delete(self):
            path, q = self.route()
            if not self.admin_ok():
                return
            if path.startswith("/api/groups/"):
                n = store.disable_items(q.get("watchlist_id") or default_watchlist(), group=self.tail(path, "/api/groups/"), asin=q.get("asin"), keywords=split_keywords(q.get("keyword")) or None, source="api")
                return self.reply(200, {"ok": True, "disabled": n})
            self.reply(404, {"error": "not found"})

    return Handler


def serve(engine: Engine, host: str, port: int, worker_token: str, admin_token: str):
    server = ThreadingHTTPServer((host, port), make_handler(engine, worker_token, admin_token))
    LOG.info("RankFlow listening on %s:%d (2J worker API: GET /job, POST /result, /job/heartbeat, /job/fail)", host, port)
    stop = threading.Event()

    def loop():
        while not stop.wait(2):
            engine.tick()

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()

    def member_loop():
        # org member list for the block's owner picker: at start, then every RANKFLOW_MEMBER_SYNC_HOURS (default 24)
        if stop.wait(5):
            return
        while True:
            try:
                stats = engine.sync_members()
                LOG.info("Member sync: %s", {k: stats.get(k) for k in ("members", "active", "complete", "merge", "user_source", "base")})
            except Exception:
                LOG.exception("Member sync failed")
            if stop.wait(max(1, env_int("RANKFLOW_MEMBER_SYNC_HOURS", 24)) * 3600):
                return

    if engine.lark:
        threading.Thread(target=member_loop, daemon=True, name="members").start()
    try:
        engine.tick()
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


# ---------------------------------------------------------------------------
# 6. CLI
# ---------------------------------------------------------------------------
def backfill_snapshot_owners(lark: "Lark", write: bool = False) -> dict:
    """Only fills snapshots whose owner is empty, from the current watchlist_item owner of the same ASIN+keyword."""
    if "owner" not in lark.fields("snapshots"):
        raise SystemExit("snapshot.owner missing: run `rankflow.py lark-fields --create` first")
    if "owner" not in lark.fields("items"):
        raise SystemExit("watchlist_item.owner missing in Base")
    owners: dict[tuple[str, str], dict] = {}
    for r in lark.list_records("items"):
        v = lark.logical("items", r)
        owner = owner_from_cell(v.get("owner"))
        if owner:
            key = (norm_asin(v.get("asin")), kw_key(v.get("keyword")))
            if key not in owners or v.get("enabled") is True:
                owners[key] = owner
    stats = {"items_with_owner": len(owners), "snapshots": 0, "already_set": 0, "no_owner_for_pair": 0, "to_fill": 0, "written": 0}
    updates: dict[str, dict] = {}
    for r in lark.list_records("snapshots"):
        stats["snapshots"] += 1
        v = lark.logical("snapshots", r)
        if owner_from_cell(v.get("owner")):
            stats["already_set"] += 1
            continue
        owner = owners.get((norm_asin(v.get("asin")), kw_key(v.get("keyword"))))
        if not owner:
            stats["no_owner_for_pair"] += 1
            continue
        updates[r["record_id"]] = {"owner": [owner["id"]]}
    stats["to_fill"] = len(updates)
    if write and updates:
        stats["written"] = lark.batch_update("snapshots", updates)
    return stats


def print_groups(groups: list[dict]) -> None:
    if not groups:
        print("(no enabled groups)")
    for g in groups:
        disabled = f" (+{g['disabled_pairs']} disabled)" if g.get("disabled_pairs") else ""
        owners = ", ".join(str(o.get("name") or o["id"]) for o in g.get("owners") or [])
        print(f"[{g['watchlist_id']}] group={g['group'] or '(no group)'} · {len(g['asins'])} ASIN · {g['pairs']} pairs{disabled}" + (f" · owner: {owners}" if owners else ""))
        for a in g["asins"]:
            extra = f"  (disabled: {', '.join(a['disabled_keywords'])})" if a.get("disabled_keywords") else ""
            print(f"    {a['asin']}: {', '.join(a['keywords']) or '-'}{extra}")


# ---------------------------------------------------------------------------
# Base schema bootstrap (`rankflow.py schema [--create]`). Dry-run by default.
# Lark field types: 1 text, 2 number, 3 single select, 7 checkbox, 11 user (person), 15 url.
# ---------------------------------------------------------------------------
def _f(name, ftype=1, prop=None):
    return {"field_name": name, "type": ftype, **({"property": prop} if prop else {})}


_INT = {"formatter": "0"}
_opts = lambda *names: {"options": [{"name": n} for n in names]}
SCHEMA = {
    "watchlist": [_f("watchlist_id"), _f("name"), _f("marketplace"), _f("zip"), _f("top_n", 2, _INT), _f("sponsored", 7),
                  _f("schedule_enabled", 7), _f("schedule_days"), _f("schedule_time"), _f("schedule_note"), _f("updated_at"),
                  _f("last_pulled_at"), _f("last_run_at"), _f("last_run_status")],
    "watchlist_item": [_f("asin"), _f("keyword"), _f("watchlist_id"), _f("group"), _f("enabled", 7), _f("updated_at"), _f("source"),
                       _f("owner", USER_FIELD, {"multiple": False})],
    "snapshot": [_f("run_id"), _f("asin"), _f("keyword"), _f("snapshot_day"),
                 _f("status", 3, _opts("ranked", "not_found", "unverified_blocked", "unverified_parser_error")),
                 _f("organic_rank", 2, _INT), _f("position_on_page"), _f("image_url", 15), _f("price_cents", 2, _INT),
                 _f("marketplace"), _f("zip"), _f("group"), _f("owner", USER_FIELD, {"multiple": False})],
    "crawl_run": [_f("run_id"), _f("watchlist_id"), _f("marketplace"), _f("zip"), _f("top_n", 2, _INT), _f("sponsored", 7),
                  _f("started_at"), _f("finished_at"), _f("status", 3, _opts("pending", "running", "success", "partial", "failed")),
                  _f("note"), _f("pairs_total", 2, _INT), _f("pairs_found", 2, _INT), _f("pairs_not_found", 2, _INT),
                  _f("pairs_failed", 2, _INT), _f("error"), _f("groups"), _f("owners", USER_FIELD, {"multiple": True})],
    "run_request": [_f("request_id"), _f("watchlist_id"), _f("requested_by"), _f("requested_at"),
                    _f("status", 3, _opts("pending", "claimed", "running", "done", "failed", "cancelled")),
                    _f("run_id"), _f("result_status"), _f("note"), _f("started_at"), _f("finished_at"), _f("exit_code", 2, _INT)],
    MEMBER_TABLE: [_f(n, t, p) for n, t, p in MEMBER_FIELDS],  # name + avatar only, never email
}


def schema_check() -> list[str]:
    """Offline consistency check: every field the code reads/writes is defined in SCHEMA."""
    errors = []
    for kind, table in TABLE_NAMES.items():
        names = {f["field_name"] for f in SCHEMA.get(table, [])}
        need = set(FIELDS[kind]) | set(OPTIONAL_FIELDS.get(kind, {}))
        errors += [f"{table}.{n} missing from SCHEMA" for n in sorted(need - names)]
    return errors


def schema_plan(lark: "Lark | None") -> list[dict]:
    """Actions needed to bring the Base in line with SCHEMA. Without a Lark client: every table is 'create'."""
    if lark is None:
        return [{"action": "create_table", "table": t, "fields": [f["field_name"] for f in fs]} for t, fs in SCHEMA.items()]
    base = f"/bitable/v1/apps/{lark.base}/tables"
    existing = {t.get("name"): t.get("table_id") for page in _contact_pages(lark, base) for t in page.get("items") or []}
    plan = []
    for table, fs in SCHEMA.items():
        if table not in existing:
            plan.append({"action": "create_table", "table": table, "fields": [f["field_name"] for f in fs]})
            continue
        metas = lark.call("GET", f"{base}/{existing[table]}/fields?page_size=500").get("items") or []
        present = {m["field_name"]: m.get("type") for m in metas}
        for f in fs:
            if f["field_name"] not in present:
                plan.append({"action": "create_field", "table": table, "table_id": existing[table], "field": f["field_name"]})
            elif present[f["field_name"]] != f["type"]:
                plan.append({"action": "type_mismatch", "table": table, "field": f["field_name"], "expected": f["type"], "actual": present[f["field_name"]]})
    return plan


def schema_apply(lark: "Lark", plan: list[dict]) -> list[dict]:
    base = f"/bitable/v1/apps/{lark.base}/tables"
    done = []
    for step in plan:
        if step["action"] == "create_table":
            fs = SCHEMA[step["table"]]
            body = {"table": {"name": step["table"], "default_view_name": "Grid", "fields": fs}}
            step = {**step, "table_id": lark.call("POST", base, body).get("table_id")}
        elif step["action"] == "create_field":
            f = next(x for x in SCHEMA[step["table"]] if x["field_name"] == step["field"])
            lark.call("POST", f"{base}/{step['table_id']}/fields", f)
        else:
            continue  # type mismatches are reported, never changed automatically
        done.append(step)
    return done


def cmd_schema(args) -> int:
    errors = schema_check()
    if errors:
        print(json.dumps({"ok": False, "errors": errors}, indent=2))
        return 1
    if args.print_json:
        print(json.dumps(SCHEMA, indent=2, ensure_ascii=False))
        return 0
    creds = bool(os.getenv("LARK_APP_ID") and os.getenv("LARK_APP_SECRET") and os.getenv("LARK_BASE_TOKEN"))
    lark = Lark(os.environ["LARK_APP_ID"], os.environ["LARK_APP_SECRET"], os.environ["LARK_BASE_TOKEN"]) if creds and args.online else None
    plan = schema_plan(lark)
    apply = args.create and not args.dry_run
    if apply and (lark is None or os.getenv("RANKFLOW_LIVE_ENABLED", "0") != "1"):
        print(json.dumps({"ok": False, "error": "--create --no-dry-run needs --online, LARK_APP_ID/SECRET/BASE_TOKEN and RANKFLOW_LIVE_ENABLED=1", "plan": plan}, indent=2))
        return 2
    result = {"ok": True, "dry_run": not apply, "online": lark is not None, "plan": plan}
    if apply:
        result["applied"] = schema_apply(lark, plan)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rankflow.py", description="RankFlow v2 backend + CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve", help="HTTP server (2J worker API + admin API) with scheduler/sync loop")
    sub.add_parser("status", help="local DB status (runs, jobs, leases, outbox, events)")
    sub.add_parser("doctor", help="read-only DB / Lark check")
    sc = sub.add_parser("schema", help="Base schema bootstrap: show plan (dry-run, default) or create tables/fields")
    sc.add_argument("--create", action="store_true", help="intend to create missing tables/fields (still dry-run unless --no-dry-run)")
    sc.add_argument("--dry-run", dest="dry_run", action="store_true", default=True, help="print the plan only (default)")
    sc.add_argument("--no-dry-run", dest="dry_run", action="store_false", help="actually write to Base (needs --online + RANKFLOW_LIVE_ENABLED=1)")
    sc.add_argument("--online", action="store_true", help="read the real Base to diff against (read-only unless --no-dry-run)")
    sc.add_argument("--print-json", action="store_true", help="print the full SCHEMA definition")
    lf = sub.add_parser("lark-fields", help="show (or --create) optional Base columns snapshot.group/owner, crawl_run.groups/owners")
    lf.add_argument("--create", action="store_true", help="create missing optional columns in Base (requires RANKFLOW_LIVE_ENABLED=1)")
    mem = sub.add_parser("members", help="org members (Lark contact) for the owner picker")
    mem_sub = mem.add_subparsers(dest="mcmd", required=True)
    ms = mem_sub.add_parser("sync", help="fetch members from Lark contact -> local cache + Base table `member` (Base write requires RANKFLOW_LIVE_ENABLED=1)")
    ms.add_argument("--dry-run", action="store_true", help="fetch and print counts only (no DB/Base writes)")
    ms.add_argument("--source", choices=("auto", "app", "user"), default="auto", help="auto (default): app token + lark-cli user identity merged by open_id")
    ml = mem_sub.add_parser("list", help="list the local member cache")
    ml.add_argument("--all", action="store_true", help="include inactive")
    bo = sub.add_parser("lark-backfill-owner", help="fill EMPTY snapshot.owner in Base from the current watchlist_item owner (ASIN+keyword)")
    bo.add_argument("--write", action="store_true", help="actually write (default: dry run; requires RANKFLOW_LIVE_ENABLED=1)")
    enqueue_cmd = sub.add_parser("enqueue", help="enqueue one local JSON job file (does not require server)")
    enqueue_cmd.add_argument("--file", required=True, type=Path)

    groups = sub.add_parser("groups", help="manage ASIN/keyword groups (local DB; synced to Base when live)")
    gsub = groups.add_subparsers(dest="gcmd", required=True)
    for name, help_text in (("list", "list groups"), ("add", "add pairs (asins x keywords) to a group"), ("set", "replace a group's pairs"),
                            ("rm", "soft-delete pairs (enabled=false)"), ("import", "bulk import CSV/JSON (asin,keyword[,group][,owner])")):
        p = gsub.add_parser(name, help=help_text)
        p.add_argument("--watchlist", default=None, help="default: $RANKFLOW_DEFAULT_WATCHLIST or default")
        if name == "list":
            p.add_argument("--all", action="store_true", help="include disabled pairs")
            p.add_argument("--json", action="store_true")
        if name in ("add", "set", "rm"):
            p.add_argument("--group", default=None, required=name == "set")
            p.add_argument("--asin", action="append", default=[], help="repeatable")
            p.add_argument("--keyword", action="append", default=[], help="repeatable")
            p.add_argument("--keywords", default=None, help="';'-separated list")
        if name in ("add", "set"):
            p.add_argument("--owner", default=None, help="owner (Lark user): open_id ou_…, or name/email of a person already owner of some Base watchlist_item; '-' clears; omit = keep")
        if name == "rm":
            p.add_argument("--all-pairs", action="store_true", help="disable every pair of the watchlist")
        if name == "import":
            p.add_argument("--file", required=True, type=Path)
            p.add_argument("--replace", action="store_true", help="replace each group present in the file")
    wl = sub.add_parser("watchlist", help="watchlist settings (zip/top_n/sponsored)")
    wl_sub = wl.add_subparsers(dest="wcmd", required=True)
    ws = wl_sub.add_parser("set")
    ws.add_argument("--watchlist", default=None)
    ws.add_argument("--zip")
    ws.add_argument("--top-n", type=int)
    ws.add_argument("--sponsored", choices=("on", "off"))
    ws.add_argument("--name")
    wl_sub.add_parser("show").add_argument("--watchlist", default=None)
    rn = sub.add_parser("run-now", help="queue a crawl of enabled pairs (all watchlists, one watchlist, or one group)")
    rn.add_argument("--watchlist", default=None)
    rn_scope = rn.add_mutually_exclusive_group()
    rn_scope.add_argument("--group", default=None, help="only this group (omit for all groups)")
    rn_scope.add_argument("--no-group", dest="group", action="store_const", const=NO_GROUP, help=f"only pairs without a group (same as --group {NO_GROUP})")
    runs = sub.add_parser("runs", help="recent runs, or one run's detail")
    runs.add_argument("run_id", nargs="?")
    cancel = sub.add_parser("cancel", help="cancel a queued/running run")
    cancel.add_argument("run_id")
    return parser


def open_store() -> Store:
    db_path = os.getenv("RANKFLOW_DB", str(ROOT / "rankflow.sqlite3"))
    if not Path(db_path).is_absolute():
        db_path = str(ROOT / db_path)
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    return Store(db_path)


def run_cli(args, store: Store):
    def out(value):
        print(json.dumps(value, indent=2, ensure_ascii=False))

    if args.command == "status":
        return out(store.status())
    if args.command == "enqueue":
        request = json.loads(args.file.read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise SystemExit("JSON object required")
        return out({"run_id": store.enqueue(request.get("source_key") or "cli:" + uuid.uuid4().hex, request["watchlist_id"], request["pairs"], request.get("settings", {}))})
    if args.command == "groups":
        wid = args.watchlist or default_watchlist()
        if args.gcmd == "list":
            data = store.list_groups(args.watchlist, args.all)
            return out(data) if args.json else print_groups(data)
        if args.gcmd == "import":
            raw = args.file.read_text(encoding="utf-8-sig")
            suffix = args.file.suffix.lower()
            fmt = "json" if suffix == ".json" else "csv" if suffix == ".csv" else None
            return out(store.import_entries(wid, parse_import(raw, fmt), args.replace, "cli-import"))
        keywords = args.keyword + split_keywords(args.keywords)
        if args.gcmd == "rm":
            if not (args.group is not None or args.asin or keywords or args.all_pairs):
                raise SystemExit("groups rm needs --group, --asin, --keyword(s) or --all-pairs")
            total = 0
            for asin in (args.asin or [None]):
                total += store.disable_items(wid, group=args.group, asin=asin, keywords=keywords or None, everything=args.all_pairs, source="cli")
            return out({"disabled": total})
        if not args.asin or not keywords:
            raise SystemExit("need at least one --asin and one --keyword/--keywords")
        entries = expand_entries({"asins": args.asin, "keywords": keywords, "group": args.group, "owner": args.owner})
        return out(store.replace_group(wid, args.group, entries, "cli") if args.gcmd == "set" else store.upsert_items(wid, entries, "cli"))
    if args.command == "watchlist":
        wid = args.watchlist or default_watchlist()
        if args.wcmd == "show":
            return out(store.get_watchlist(wid))
        return out(store.set_watchlist(wid, args.zip, args.top_n, None if args.sponsored is None else args.sponsored == "on", args.name))
    if args.command == "run-now":
        return out(store.run_now(args.watchlist, args.group, "cli"))
    if args.command == "runs":
        if args.run_id:
            detail = store.run_detail(args.run_id)
            return out(detail) if detail else print("run not found")
        return out(store.status()["runs"])
    if args.command == "cancel":
        return out({"cancelled": store.cancel_run(args.run_id)})
    raise SystemExit(f"unknown command {args.command}")


def main(argv: list[str] | None = None):
    load_env()
    args = build_parser().parse_args(argv)
    if args.command == "schema":
        return cmd_schema(args)
    logging.basicConfig(level=logging.INFO if args.command == "serve" else logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
    store = open_store()
    if args.command == "doctor":
        check = store.db.execute("PRAGMA quick_check").fetchone()[0]
        result = {"sqlite": check, "live_enabled": os.getenv("RANKFLOW_LIVE_ENABLED", "0") == "1", "lark_credentials_present": bool(os.getenv("LARK_APP_ID") and os.getenv("LARK_APP_SECRET"))}
        if result["lark_credentials_present"]:
            try:
                probe = Lark(os.environ["LARK_APP_ID"], os.environ["LARK_APP_SECRET"], os.getenv("LARK_BASE_TOKEN", ""))
                result["lark_tables"] = {kind: len(probe.list_records(kind)) for kind in ("watchlists", "items", "requests", "snapshots", "runs")}
                result["lark_fields"] = {kind: len(probe.fields(kind)) for kind in FIELDS}
                result["lark_optional_missing"] = probe.missing_optional()
            except Exception as e:
                result["lark_error"] = str(e)
        print(json.dumps(result, indent=2))
        return
    if args.command == "lark-fields":
        if not (os.getenv("LARK_APP_ID") and os.getenv("LARK_APP_SECRET")):
            raise SystemExit("Lark credentials missing")
        probe = Lark(os.environ["LARK_APP_ID"], os.environ["LARK_APP_SECRET"], os.getenv("LARK_BASE_TOKEN", ""))
        missing = probe.missing_optional()
        if args.create and missing:
            if os.getenv("RANKFLOW_LIVE_ENABLED", "0") != "1":
                raise SystemExit("Refusing to modify Base: set RANKFLOW_LIVE_ENABLED=1 first (go-live step)")
            for kind, names in missing.items():
                for name in names:
                    probe.create_field(kind, name, OPTIONAL_FIELDS[kind][name])
            missing = probe.missing_optional()
        print(json.dumps({"optional_missing": missing, "type_mismatch": probe.optional_type_mismatch(), "optional": {k: list(v) for k, v in OPTIONAL_FIELDS.items()}}, indent=2))
        return
    if args.command == "members" and args.mcmd == "sync":
        if not (os.getenv("LARK_APP_ID") and os.getenv("LARK_APP_SECRET")):
            raise SystemExit("Lark credentials missing")
        lark = Lark(os.environ["LARK_APP_ID"], os.environ["LARK_APP_SECRET"], os.getenv("LARK_BASE_TOKEN", ""))
        if args.dry_run:
            members, stats = fetch_members(lark) if args.source != "user" else ([], {})
            if args.source != "app":
                umembers, stats["user_source"] = fetch_members_as_user(root_name=stats.get("tenant") or "")
                members, stats["merge"] = merge_member_sources(members, umembers)
            stats["members"] = len(members)
            stats["names"] = [m["name"] for m in members]
            print(json.dumps(stats, indent=2, ensure_ascii=False))
            return
        if os.getenv("RANKFLOW_LIVE_ENABLED", "0") != "1":
            raise SystemExit("Refusing to modify Base: set RANKFLOW_LIVE_ENABLED=1 first (or use --dry-run)")
        print(json.dumps(Engine(store, lark).sync_members(source=args.source), indent=2, ensure_ascii=False))
        return
    if args.command == "members" and args.mcmd == "list":
        rows = store.list_members(args.all)
        for m in rows:
            print(f'{m["open_id"]}  {m["name"]}' + (f' ({m["en_name"]})' if m["en_name"] else "") + ("" if m["active"] else "  (inactive)"))
        print(f"{len(rows)} member(s)")
        return
    if args.command == "lark-backfill-owner":
        if not (os.getenv("LARK_APP_ID") and os.getenv("LARK_APP_SECRET")):
            raise SystemExit("Lark credentials missing")
        if args.write and os.getenv("RANKFLOW_LIVE_ENABLED", "0") != "1":
            raise SystemExit("Refusing to modify Base: set RANKFLOW_LIVE_ENABLED=1 first")
        lark = Lark(os.environ["LARK_APP_ID"], os.environ["LARK_APP_SECRET"], os.getenv("LARK_BASE_TOKEN", ""))
        print(json.dumps(backfill_snapshot_owners(lark, write=args.write), indent=2, ensure_ascii=False))
        return
    if args.command != "serve":
        try:
            return run_cli(args, store)
        except ValueError as e:
            raise SystemExit(f"error: {e}")
    worker_token = os.getenv("RANKFLOW_WORKER_TOKEN", "")
    admin_token = os.getenv("RANKFLOW_ADMIN_TOKEN", "")
    if min(len(worker_token), len(admin_token)) < 24 or worker_token == admin_token:
        raise SystemExit("Set distinct RANKFLOW_WORKER_TOKEN and RANKFLOW_ADMIN_TOKEN (>=24 chars)")
    app_id, app_secret = os.getenv("LARK_APP_ID", ""), os.getenv("LARK_APP_SECRET", "")
    live = os.getenv("RANKFLOW_LIVE_ENABLED", "0") == "1"
    lark = Lark(app_id, app_secret, os.getenv("LARK_BASE_TOKEN", "")) if live and app_id and app_secret else None
    if not lark:
        LOG.warning("Lark pull/sync disabled (set credentials and RANKFLOW_LIVE_ENABLED=1 after verification); outbox accumulates locally")
    host = os.getenv("RANKFLOW_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost", "::1"):
        LOG.warning("Remote binding requires a trusted HTTPS reverse proxy/firewall; set RANKFLOW_2J_LOOPBACK_NOAUTH=0 when proxied")
    serve(Engine(store, lark), host, env_int("RANKFLOW_PORT", env_int("PORT", 8787)), worker_token, admin_token)


if __name__ == "__main__":
    raise SystemExit(main())
