"""Tests for the 2J worker protocol, group admin, run-now, watchdog and Base mirror/sync (no network)."""
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.rankflow import ROOT, Engine, LeaseError, Store, item_key, make_handler, page_pos_label, parse_import
import backend.rankflow as _rf
_rf.TABLES.update({k: "tblTest" + k for k in _rf.TABLE_NAMES})  # offline: skip by-name table lookup


logging.getLogger("rankflow").setLevel(logging.CRITICAL)
FIXTURE = Path(os.getenv("RANKFLOW_2J_FIXTURE", ""))
LOCAL_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "2j-result-team-a-2026-09-29.json"
WORKER = "worker-token-for-local-testing-123"
ADMIN = "admin-token-for-local-testing-456"
A1, A2, A3 = "B0TEST0006", "B0TEST0008", "B0TEST0001"


def load_fixture() -> dict:
    path = FIXTURE if str(FIXTURE) not in ("", ".") and FIXTURE.is_file() else LOCAL_FIXTURE
    return json.loads(path.read_text(encoding="utf-8"))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "t.sqlite3"))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def outbox(self, kind):
        return {r["key"]: json.loads(r["payload"]) for r in self.store.db.execute("SELECT key,payload FROM outbox WHERE kind=?", (kind,))}

    def expire_leases(self):
        self.store.db.execute("UPDATE jobs SET lease_until='2000-01-01T00:00:00+00:00' WHERE status='leased'")

    def make_ready(self):
        self.store.db.execute("UPDATE jobs SET lease_until=NULL WHERE status='queued'")


class GroupTests(Base):
    def test_add_update_delete_groups_soft_and_synced(self):
        s = self.store.upsert_items("team", [{"asin": A1, "keyword": "Ghost Mug", "group": "G1"}, {"asin": A1, "keyword": "  halloween   mug ", "group": "G1"}, {"asin": A2, "keyword": "ghost mug", "group": "G2"}])
        self.assertEqual(s["added"], 3)
        self.assertEqual(self.store.upsert_items("team", [{"asin": A1, "keyword": "ghost mug"}])["unchanged"], 1)  # case-insensitive identity
        groups = {g["group"]: g for g in self.store.list_groups("team")}
        self.assertEqual(groups["G1"]["asins"][0]["keywords"], ["Ghost Mug", "halloween mug"])  # case kept, spaces collapsed
        self.assertEqual(self.store.upsert_items("team", [{"asin": A1, "keyword": "Ghost Mug", "group": "G2"}])["regrouped"], 1)
        self.assertEqual(self.store.disable_items("team", group="G2", asin=A2), 1)
        self.assertEqual(self.store.upsert_items("team", [{"asin": A2, "keyword": "ghost mug", "group": "G2"}])["reenabled"], 1)
        with self.assertRaises(ValueError):
            self.store.disable_items("team")  # never delete everything by accident
        with self.assertRaises(ValueError):
            self.store.upsert_items("team", [{"asin": "NOTANASIN", "keyword": "x"}])
        stats = self.store.replace_group("team", "G2", [{"asin": A3, "keyword": "cat costume"}])
        self.assertEqual((stats["added"], stats["disabled"]), (1, 2))
        all_groups = self.store.list_groups("team", include_disabled=True)
        g2 = next(g for g in all_groups if g["group"] == "G2")
        self.assertEqual(g2["pairs"], 1)
        self.assertEqual(g2["disabled_pairs"], 2)
        items = self.outbox("items")
        self.assertFalse(items[item_key("team", A2, "ghost mug")]["enabled"])
        self.assertTrue(items[item_key("team", A3, "cat costume")]["enabled"])
        self.assertEqual(items[item_key("team", A3, "cat costume")]["group"], "G2")

    def test_bulk_import_csv_and_json(self):
        csv_text = "asin,keyword,group\nB0TEST0006,ghost mug,Mugs\nb0test0006,Halloween Mug,Mugs\nB0TEST0001,cat costume,\n"
        self.assertEqual(self.store.import_entries("team", parse_import(csv_text))["added"], 3)
        self.assertEqual(len(parse_import("B0TEST0006,ghost mug\n")), 1)  # headerless
        doc = {"groups": [{"group": "Cats", "items": [{"asin": A3, "keywords": ["cat costume", "cat halloween costume"]}]},
                          {"name": "Mugs", "asins": [A1], "keywords": "ghost mug;spooky mug"}]}
        stats = self.store.import_entries("team", parse_import(json.dumps(doc)), replace=True)
        self.assertEqual(stats["disabled"], 1)  # Mugs/Halloween Mug no longer listed
        self.assertEqual(len(parse_import({A1: ["a", "b"], A2: "c"})), 3)
        self.assertEqual(len(parse_import([{"asin": A1, "keyword": "x", "group": "g"}])), 1)
        groups = {g["group"]: g["pairs"] for g in self.store.list_groups("team")}
        self.assertEqual(groups, {"Cats": 2, "Mugs": 2})


class RunNowTests(Base):
    def test_run_now_all_and_by_group_idempotent(self):
        self.store.upsert_items("team", [{"asin": A1, "keyword": "ghost mug", "group": "G1"}, {"asin": A2, "keyword": "Ghost Mug", "group": "G2"}, {"asin": A2, "keyword": "halloween mug", "group": "G2"}])
        self.store.set_watchlist("team", zip_code="90001", top_n=150, sponsored=True)
        first = self.store.run_now("team")
        self.assertFalse(first[0]["existing"])
        self.assertTrue(self.store.run_now("team")[0]["existing"])  # double click = same run
        g1 = self.store.run_now("team", "G1")
        self.assertNotEqual(g1[0]["run_id"], first[0]["run_id"])
        job = self.store.claim_run("w")
        self.assertEqual(job["run_id"], first[0]["run_id"])
        self.assertEqual(job["keywords_total"], 2)  # "ghost mug"/"Ghost Mug" crawled once
        self.assertEqual((job["postalCode"], job["maxOrganic"], job["includeSponsored"]), ("90001", 150, True))
        self.assertEqual(sorted((g["asins"][0], g["name"], tuple(g["keywords"])) for g in job["groups"]),
                         [(A1, "G1", ("ghost mug",)), (A2, "G2", ("ghost mug", "halloween mug"))])
        with self.assertRaises(ValueError):
            self.store.run_now("team", "nope")
        self.assertIn("watchlist_settings", {r[0] for r in self.store.db.execute("SELECT kind FROM outbox")})


class ProtocolTests(Base):
    def seed_fixture(self, data):
        pairs = [{"asin": r["asin"], "keyword": r["keyword"], "group": r.get("groupName")} for r in data["rows"]]
        self.store.upsert_items(data["watchlist_id"], pairs, "test")
        self.store.set_watchlist(data["watchlist_id"], top_n=250)
        return self.store.run_now(data["watchlist_id"])[0]["run_id"]

    def test_fixture_round_trip_store(self):
        data = load_fixture()
        run_id = self.seed_fixture(data)
        job = self.store.claim_run("chrome-test")
        self.assertEqual(job["run_id"], run_id)
        self.assertEqual(job["keywords_total"], len({r["keyword"].lower() for r in data["rows"]}))
        self.assertEqual(self.store.heartbeat_run(job["lease_token"], {"completed": 3})["run_id"], run_id)
        result = self.store.complete_run(job["lease_token"], {"rows": data["rows"], "warnings": data["warnings"]})
        self.assertEqual(result["run_status"], "success")
        self.assertEqual(result["done"], job["keywords_total"])
        snaps = self.outbox("snapshots")
        self.assertEqual(len(snaps), len(data["rows"]))
        ranked = [r for r in data["rows"] if r["status"] == "ranked"]
        for r in ranked:
            p = snaps[f'{run_id}:{r["asin"]}:{r["keyword"]}']
            self.assertEqual((p["status"], p["organic_rank"], p["position_on_page"], p["snapshot_day"]), ("ranked", r["organicRank"], f'#{r["positionOnPage"]} P{r["pageNumber"]}', "2026-09-29"))
        p = snaps[f"{run_id}:B0TEST0008:halloween mug"]
        self.assertEqual(p["position_on_page"], "#18 P4")
        nf = next(r for r in data["rows"] if r["status"].startswith("not_found"))
        self.assertEqual(snaps[f'{run_id}:{nf["asin"]}:{nf["keyword"]}']["status"], "not_found")
        self.assertIsNone(snaps[f'{run_id}:{nf["asin"]}:{nf["keyword"]}']["position_on_page"])
        run = self.outbox("runs")[run_id]
        self.assertEqual((run["pairs_total"], run["pairs_found"], run["pairs_not_found"], run["pairs_failed"]), (41, len(ranked), 41 - len(ranked), 0))
        row = self.store.db.execute("SELECT page_number, position_on_page FROM snapshots WHERE asin='B0TEST0008' AND keyword='halloween mug'").fetchone()
        self.assertEqual(tuple(row), (4, 18))
        with self.assertRaises(LeaseError):
            self.store.complete_run(job["lease_token"], {"rows": data["rows"]})  # replay rejected

    def test_partial_fail_requeues_missing_keywords_and_blocked_backoff(self):
        self.store.upsert_items("team", [{"asin": A1, "keyword": k} for k in ("k1", "k2", "k3")])
        self.store.run_now("team")
        job = self.store.claim_run("w")
        rows = [{"asin": A1, "keyword": "K1", "status": "ranked", "organicRank": 5, "pageNumber": 1, "positionOnPage": 5},
                {"asin": A1, "keyword": "k2", "status": "unverified_blocked", "organicRank": None}]
        out = self.store.complete_run(job["lease_token"], {"rows": rows}, "Amazon CAPTCHA backoff")
        self.assertEqual((out["done"], out["requeued"], out["run_status"]), (2, 1, "running"))
        k3 = self.store.db.execute("SELECT status, error, lease_until FROM jobs WHERE keyword='k3'").fetchone()
        self.assertEqual(k3["status"], "queued")
        self.assertIn("CAPTCHA", k3["error"])
        self.assertIsNone(self.store.claim_run("w"))  # blocked => 10 min backoff, nothing claimable now
        self.make_ready()
        job2 = self.store.claim_run("w")
        self.assertEqual(job2["keywords_total"], 1)
        out = self.store.complete_run(job2["lease_token"], {"rows": [{"asin": A1, "keyword": "k3", "status": "not_found_within_100"}]})
        self.assertEqual(out["run_status"], "partial")  # k2 was blocked

    def test_watchdog_requeues_then_fails_silent_worker(self):
        self.store.upsert_items("team", [{"asin": A1, "keyword": "k1"}])
        run_id = self.store.run_now("team")[0]["run_id"]
        for attempt in range(1, 4):
            self.make_ready()
            job = self.store.claim_run("silent")
            self.assertIsNotNone(job, attempt)
            self.expire_leases()
            self.assertEqual(self.store.reap_expired(), 1)
            with self.assertRaises(LeaseError):
                self.store.heartbeat_run(job["lease_token"])
        self.assertEqual(self.store.db.execute("SELECT status FROM runs WHERE id=?", (run_id,)).fetchone()[0], "failed")
        self.assertEqual(self.outbox("snapshots")[f"{run_id}:{A1}:k1"]["status"], "unverified_parser_error")
        events = [e["kind"] for e in self.store.status()["events"]]
        self.assertIn("watchdog", events)

    def test_cancel_stops_worker(self):
        self.store.upsert_items("team", [{"asin": A1, "keyword": "k1"}])
        run_id = self.store.run_now("team")[0]["run_id"]
        job = self.store.claim_run("w")
        self.assertTrue(self.store.cancel_run(run_id))
        with self.assertRaises(LeaseError):
            self.store.heartbeat_run(job["lease_token"])
        self.assertEqual(self.outbox("runs")[run_id]["status"], "failed")

    def test_position_label_and_row_mapping(self):
        self.assertEqual(page_pos_label(2, 7), "#7 P2")
        self.assertIsNone(page_pos_label(None, 7))
        self.assertIsNone(page_pos_label(2, None))
        m = Store.map_2j_row({"asin": "b0test0006", "status": "ranked", "organicRank": 120, "pageNumber": 3, "positionOnPage": 9}, 100)
        self.assertEqual((m["status"], m["organic_rank"], m["page_number"]), ("not_found", None, None))
        m = Store.map_2j_row({"asin": A1, "status": "ranked", "organicRank": None}, 100)
        self.assertEqual(m["status"], "unverified_parser_error")  # never invent ranks
        self.assertEqual(Store.map_2j_row({"asin": A1, "status": "unverified_blocked"}, 100)["status"], "unverified_blocked")


class FakeLark:
    def __init__(self):
        self.records = {"watchlists": [{"record_id": "rw", "fields": {"watchlist_id": "team", "zip": "10001", "top_n": 100}}],
                        "items": [{"record_id": "ri1", "fields": {"watchlist_id": "team", "asin": A1, "keyword": "Ghost Mug", "group": "UI", "enabled": True}}],
                        "requests": [], "snapshots": [], "runs": []}
        self.writes = []

    def list_records(self, kind):
        return self.records[kind]

    def logical(self, kind, record):
        return record["fields"]

    def write(self, kind, payload, record_id=None):
        self.writes.append((kind, dict(payload), record_id))
        if record_id:
            next(r for r in self.records[kind] if r["record_id"] == record_id)["fields"].update(payload)
            return record_id
        record_id = f"r-{kind}-{len(self.records[kind])}"
        self.records[kind].append({"record_id": record_id, "fields": dict(payload)})
        return record_id


class BaseMirrorTests(Base):
    def test_mirror_pull_and_item_sync(self):
        fake = FakeLark()
        engine = Engine(self.store, fake)
        engine.pull()
        self.assertEqual(self.store.enabled_pairs("team"), [{"asin": A1, "keyword": "Ghost Mug", "group": "UI"}])
        self.store.upsert_items("team", [{"asin": A2, "keyword": "Spooky Mug", "group": "API"}])
        self.store.disable_items("team", asin=A1)
        engine.pull()  # pending local writes win over Base
        self.assertEqual([p["asin"] for p in self.store.enabled_pairs("team")], [A2])
        engine.sync(100)
        items = {r["fields"]["keyword"]: r["fields"] for r in fake.records["items"]}
        self.assertFalse(items["Ghost Mug"]["enabled"])
        self.assertEqual((items["Spooky Mug"]["enabled"], items["Spooky Mug"]["group"]), (True, "API"))
        self.assertEqual(self.store.status()["outbox_by_kind"].get("items"), None)
        fake.records["items"] = [r for r in fake.records["items"] if r["fields"]["keyword"] != "Spooky Mug"]
        engine.pull()  # removed in Base -> removed locally
        self.assertEqual(self.store.enabled_pairs("team"), [])


class HTTPTests(Base):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Engine(self.store, None), WORKER, ADMIN))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, path, method="GET", body=None, headers=None, raw=None):
        h = {"Content-Type": "application/json"} if body is not None or raw is not None else {}
        h.update(headers or {})
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        with urlopen(Request(self.base + path, data=data, headers=h, method=method), timeout=5) as resp:
            text = resp.read()
            return resp.status, (json.loads(text) if text else None)

    def status_of(self, *args, **kwargs):
        try:
            return self.call(*args, **kwargs)[0]
        except HTTPError as e:
            return e.code

    def test_admin_groups_run_now_and_worker_round_trip(self):
        adm = {"X-Admin-Token": ADMIN}
        ext = {"X-Worker-Id": "2j-test", "Origin": "chrome-extension://abcdefghijklmnop"}
        self.assertEqual(self.status_of("/api/groups"), 401)
        self.call("/api/groups", "POST", {"watchlist_id": "team", "group": "Mugs", "items": [{"asin": A1, "keywords": ["ghost mug", "Spooky Mug"]}]}, adm)
        self.call("/api/groups/Cats", "PUT", {"watchlist_id": "team", "asins": [A3], "keywords": ["cat costume"]}, adm)
        self.call("/api/watchlists/team", "PUT", {"zip": "10001", "top_n": 100}, adm)
        _, groups = self.call("/worker/groups?watchlist_id=team", headers=ext)
        self.assertEqual(sorted(g["group"] for g in groups["groups"]), ["Cats", "Mugs"])
        _, deleted = self.call("/api/groups/Mugs?watchlist_id=team&keyword=spooky%20mug", "DELETE", headers=adm)
        self.assertEqual(deleted["disabled"], 1)
        self.assertEqual(self.status_of("/job", headers=ext), 204)
        _, runs = self.call("/api/run-now", "POST", {"watchlist_id": "team", "group": "Mugs"}, adm)
        run_id = runs["runs"][0]["run_id"]
        code, job = self.call("/job", headers=ext)
        self.assertEqual((code, job["run_id"], job["keywords_total"]), (200, run_id, 1))
        _, hb = self.call("/job/heartbeat", "POST", {"lease_token": job["lease_token"], "progress": {"completed": 0}}, ext)
        self.assertTrue(hb["ok"])
        _, st = self.call("/worker/status", headers=ext)
        self.assertEqual(st["active_leases"][0]["run_id"], run_id)
        row = {"asin": A1, "keyword": "ghost mug", "status": "ranked", "organicRank": 14, "pageNumber": 1, "positionOnPage": 14, "snapshotDay": "2026-10-06", "priceCents": 1599, "imageUrl": "https://m.media-amazon.com/x.jpg"}
        _, res = self.call("/result", "POST", {"lease_token": job["lease_token"], "rows": [row]}, ext)
        self.assertEqual(res["run_status"], "success")
        _, detail = self.call(f"/api/runs/{run_id}", headers=adm)
        self.assertEqual(detail["snapshots"][0]["position_label"], "#14 P1")
        self.assertEqual(self.status_of("/job/heartbeat", "POST", {"lease_token": job["lease_token"]}, ext), 409)

    def test_compat_result_without_token_uses_unique_lease(self):
        data = load_fixture()
        self.store.upsert_items(data["watchlist_id"], [{"asin": r["asin"], "keyword": r["keyword"]} for r in data["rows"]])
        self.store.set_watchlist(data["watchlist_id"], top_n=250)
        self.store.run_now(data["watchlist_id"])
        ext = {"X-Worker-Id": "2j-test"}
        _, job = self.call("/job", headers=ext)
        _, res = self.call("/result", "POST", data, ext)  # original 2J body: watchlist_id + rows, no lease_token
        self.assertEqual((res["run_status"], res["done"]), ("success", job["keywords_total"]))

    def test_worker_auth_blocks_web_pages(self):
        self.store.upsert_items("team", [{"asin": A1, "keyword": "k"}])
        self.assertEqual(self.status_of("/job"), 401)  # no X-Worker-Id
        self.assertEqual(self.status_of("/job", headers={"X-Worker-Id": "x", "Origin": "https://evil.example"}), 401)
        self.assertEqual(self.status_of("/job", headers={"X-Worker-Token": "wrong-token-xxxxxxxxxxxxxxxx"}), 401)
        self.assertEqual(self.status_of("/job", headers={"Authorization": f"Bearer {WORKER}"}), 204)
        self.assertEqual(self.status_of("/result", "POST", headers={"X-Worker-Id": "x", "Content-Type": "text/plain"}, raw=b'{"rows":[]}'), 400)
        self.assertEqual(self.status_of("/worker/run-now", "POST", {"watchlist_id": "team"}, {"X-Worker-Id": "x"}), 202)
        self.assertEqual(self.status_of("/api/import", "POST", {"watchlist_id": "team", "format": "csv", "data": "asin,keyword\nB0TEST0006,new kw\n"}, {"X-Admin-Token": ADMIN}), 200)


class CLITests(unittest.TestCase):
    def test_cli_groups_and_run_now(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, RANKFLOW_DB=str(Path(tmp) / "cli.sqlite3"), RANKFLOW_LIVE_ENABLED="0", RANKFLOW_DEFAULT_WATCHLIST="team")
            run = lambda *a: subprocess.run([sys.executable, str(ROOT / "backend" / "rankflow.py"), *a], env=env, capture_output=True, text=True, timeout=30)
            r = run("groups", "add", "--group", "Mugs", "--asin", A1, "--asin", A2, "--keywords", "ghost mug;Spooky Mug")
            self.assertEqual(json.loads(r.stdout)["added"], 4, r.stderr)
            csv_path = Path(tmp) / "bulk.csv"
            csv_path.write_text("asin,keyword,group\nB0TEST0001,cat costume,Cats\n", encoding="utf-8")
            self.assertEqual(json.loads(run("groups", "import", "--file", str(csv_path)).stdout)["added"], 1)
            self.assertEqual(json.loads(run("groups", "rm", "--group", "Mugs", "--asin", A2).stdout)["disabled"], 2)
            listing = run("groups", "list").stdout
            self.assertIn("group=Cats", listing)
            self.assertIn("Spooky Mug", listing)
            self.assertEqual(json.loads(run("watchlist", "set", "--zip", "90001", "--top-n", "120").stdout)["top_n"], 120)
            runs = json.loads(run("run-now", "--group", "Cats").stdout)
            self.assertEqual(runs[0]["pairs"], 1)
            self.assertEqual(run("groups", "add", "--asin", "BAD", "--keyword", "x").returncode, 1)


if __name__ == "__main__":
    unittest.main()
