import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from backend.rankflow import Engine, Lark, Store, FIELDS, ROOT
import backend.rankflow as _rf
_rf.TABLES.update({k: "tblTest" + k for k in _rf.TABLE_NAMES})  # offline: skip by-name table lookup



ASIN_A = "B012345678"
ASIN_B = "B087654321"


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "test.sqlite3"))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_enqueue_idempotent_and_keyword_grouping(self):
        pairs = [{"asin": ASIN_A, "keyword": "Straw Cup"}, {"asin": ASIN_B, "keyword": "straw cup"}]
        first = self.store.enqueue("manual:1", "team", pairs, {"top_n": 100})
        second = self.store.enqueue("manual:1", "team", pairs, {"top_n": 100})
        self.assertEqual(first, second)
        job = self.store.claim("worker-1")
        self.assertEqual(job["keyword"], "Straw Cup")  # first-seen case is kept (Base join is exact)
        self.assertEqual(len(job["targets"]), 2)
        self.assertIsNone(self.store.claim("worker-2"))

    def test_complete_outbox_and_final_status(self):
        self.store.enqueue("manual:2", "team", [{"asin": ASIN_A, "keyword": "straw"}, {"asin": ASIN_B, "keyword": "straw"}], {"top_n": 100})
        job = self.store.claim("worker")
        self.store.heartbeat(job["job_id"], job["lease_token"])
        self.store.complete(job["job_id"], job["lease_token"], [{"asin": ASIN_A, "status": "found", "organic_rank": 11, "position_on_page": 3}, {"asin": ASIN_B, "status": "not_found"}])
        self.assertEqual(self.store.status()["runs"][0]["status"], "success")
        self.assertEqual(self.store.status()["outbox"], 4)
        row = self.store.db.execute("SELECT payload FROM outbox WHERE kind='snapshots' AND key LIKE ?", (f"%:{ASIN_A}:%",)).fetchone()
        self.assertEqual(json.loads(row[0])["status"], "ranked")
        with self.assertRaises(ValueError):
            self.store.complete(job["job_id"], job["lease_token"], [])

    def test_retries_and_failed_snapshots(self):
        self.store.enqueue("manual:3", "team", [{"asin": ASIN_A, "keyword": "straw"}], {})
        for attempt in range(3):
            job = self.store.claim("worker")
            self.store.complete(job["job_id"], job["lease_token"], [], "navigation error")
            self.assertEqual(self.store.status()["runs"][0]["status"], "failed" if attempt == 2 else "running")
            self.store.db.execute("UPDATE jobs SET lease_until=NULL WHERE id=?", (job["job_id"],))
        row = self.store.db.execute("SELECT status FROM snapshots").fetchone()
        self.assertEqual(row[0], "unverified_parser_error")

    def test_invalid_payload_rejected_without_losing_lease(self):
        self.store.enqueue("manual:4", "team", [{"asin": ASIN_A, "keyword": "straw"}], {})
        job = self.store.claim("worker")
        with self.assertRaises(ValueError):
            self.store.complete(job["job_id"], job["lease_token"], [{"asin": ASIN_A, "status": "found", "organic_rank": 999}])
        self.assertEqual(self.store.status()["jobs"], {"leased": 1})


class FakeLark:
    def __init__(self):
        self.records = {
            "watchlists": [{"record_id": "rec-w", "fields": {"watchlist_id": "team", "schedule_enabled": True, "schedule_days": "Mon,Tue,Wed,Thu,Fri,Sat,Sun", "schedule_time": datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%H:%M"), "top_n": 100}}],
            "items": [{"record_id": "rec-i", "fields": {"watchlist_id": "team", "enabled": True, "asin": ASIN_A, "keyword": "straw"}}],
            "requests": [{"record_id": "rec-r", "fields": {"request_id": "req-1", "watchlist_id": "team", "status": "pending", "requested_at": datetime.now(timezone.utc).isoformat()}}],
            "snapshots": [], "runs": [],
        }
        self.writes = []

    def list_records(self, kind):
        return self.records[kind]

    def logical(self, kind, record):
        return record["fields"]

    def write(self, kind, payload, record_id=None):
        self.writes.append((kind, payload, record_id))
        if record_id:
            for record in self.records[kind]:
                if record["record_id"] == record_id:
                    record["fields"].update(payload)
        else:
            record_id = f"rec-{len(self.records[kind])}"
            self.records[kind].append({"record_id": record_id, "fields": payload})
        return record_id


class EngineTests(StoreTests):
    def test_pull_schedule_and_request_then_sync(self):
        fake = FakeLark()
        engine = Engine(self.store, fake)
        engine.pull()
        engine.pull()
        self.assertEqual(len(self.store.status()["runs"]), 2)
        jobs = [self.store.claim("worker"), self.store.claim("worker")]
        for job in jobs:
            self.store.complete(job["job_id"], job["lease_token"], [{"asin": ASIN_A, "status": "found", "organic_rank": 4}])
        engine.sync(100)
        self.assertEqual(self.store.status()["outbox"], 0)
        self.assertEqual(fake.records["requests"][0]["fields"]["status"], "done")
        self.assertEqual(len(fake.records["snapshots"]), 2)

    def test_request_done_only_after_its_snapshots_are_in_base(self):
        fake = FakeLark()
        engine = Engine(self.store, fake)
        engine.pull()
        pairs = [{"asin": ASIN_A, "keyword": f"kw {i}"} for i in range(5)]
        req = fake.records["requests"][0]
        run_id = self.store.status()["runs"][0]["id"]
        self.store.enqueue("extra:1", "team", pairs, {})  # unrelated run, keeps outbox busy
        while True:
            job = self.store.claim("worker")
            if job is None:
                break
            self.store.complete(job["job_id"], job["lease_token"], [{"asin": t["asin"], "status": "found", "organic_rank": 3} for t in job["targets"]])
        order = []
        slow_write = fake.write
        def write(kind, payload, record_id=None):
            order.append((kind, payload.get("status"), payload.get("run_id")))
            return slow_write(kind, payload, record_id)
        fake.write = write
        engine.sync(3)  # small batches: the request must not jump ahead of its snapshots
        while self.store.status()["outbox"]:
            engine.sync(3)
        done_at = order.index(("requests", "done", run_id))
        snap_at = [i for i, (k, _, r) in enumerate(order) if k == "snapshots" and r == run_id]
        self.assertTrue(snap_at and max(snap_at) < done_at, order)
        self.assertEqual(req["fields"]["status"], "done")

    def test_failing_snapshot_does_not_block_request_forever(self):
        fake = FakeLark()
        engine = Engine(self.store, fake)
        engine.pull()
        while (job := self.store.claim("worker")) is not None:
            self.store.complete(job["job_id"], job["lease_token"], [{"asin": ASIN_A, "status": "found", "organic_rank": 4}])
        self.store.db.execute("UPDATE outbox SET attempts=5, next_at='9999' WHERE kind='snapshots'")
        engine.sync(100)
        self.assertEqual(fake.records["requests"][0]["fields"]["status"], "done")
        self.store.db.execute("UPDATE outbox SET attempts=1 WHERE kind='snapshots'")

    def test_concurrent_ticks_do_not_double_write(self):
        import threading
        fake = FakeLark()
        engine = Engine(self.store, fake)
        engine.pull()
        jobs = [self.store.claim("worker"), self.store.claim("worker")]
        for job in jobs:
            self.store.complete(job["job_id"], job["lease_token"], [{"asin": ASIN_A, "status": "found", "organic_rank": 4}])
        slow_write = fake.write
        def write(kind, payload, record_id=None):
            time.sleep(0.05)  # widen the race window like a real Lark round-trip
            return slow_write(kind, payload, record_id)
        fake.write = write
        engine.last_pull = time.monotonic()  # only exercise sync
        threads = [threading.Thread(target=engine.tick) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        while self.store.status()["outbox"]:
            engine.last_sync = -1e9
            engine.tick()
        self.assertEqual(len(fake.records["snapshots"]), 2)
        self.assertEqual(len({r["fields"]["run_id"] for r in fake.records["runs"]}), len(fake.records["runs"]))


class LarkMappingTests(unittest.TestCase):
    def test_field_names_and_record_payload(self):
        class Recorder(Lark):
            def __init__(self):
                super().__init__("id", "secret", "base")
                self.requests = []

            def call(self, method, path, body=None):
                self.requests.append((method, path, body))
                if path.endswith("/fields?page_size=500"):
                    return {"items": [{"field_id": field_id, "field_name": name} for name, field_id in FIELDS["snapshots"].items()]}
                return {"record": {"record_id": "rec-created"}}

        lark = Recorder()
        self.assertEqual(lark.write("snapshots", {"run_id": "rf-1", "status": "ranked", "position_on_page": "3"}), "rec-created")
        self.assertEqual(lark.requests[-1][2]["fields"], {"run_id": "rf-1", "status": "ranked", "position_on_page": "3"})

    def test_url_field_written_as_link_object(self):
        class Recorder(Lark):
            def __init__(self):
                super().__init__("id", "secret", "base")
                self.requests = []

            def call(self, method, path, body=None):
                self.requests.append((method, path, body))
                if path.endswith("/fields?page_size=500"):
                    return {"items": [{"field_id": fid, "field_name": name, "type": 15 if name == "image_url" else 1} for name, fid in FIELDS["snapshots"].items()]}
                return {"record": {"record_id": "rec-created"}}

        lark = Recorder()
        url = "https://m.media-amazon.com/images/I/x.jpg"
        lark.write("snapshots", {"run_id": "rf-1", "image_url": url, "price_cents": None})
        self.assertEqual(lark.requests[-1][2]["fields"], {"run_id": "rf-1", "image_url": {"text": url, "link": url}})


class HTTPTests(unittest.TestCase):
    def test_enqueue_claim_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            env = dict(__import__("os").environ, RANKFLOW_DB=str(Path(tmp) / "test.sqlite3"), RANKFLOW_PORT=str(port), RANKFLOW_HOST="127.0.0.1", RANKFLOW_WORKER_TOKEN="worker-token-for-local-testing-123", RANKFLOW_ADMIN_TOKEN="admin-token-for-local-testing-456", RANKFLOW_LIVE_ENABLED="0")
            process = subprocess.Popen([sys.executable, str(ROOT / "backend" / "rankflow.py"), "serve"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            base = f"http://127.0.0.1:{port}"
            def request(path, method="GET", body=None, admin=False):
                headers = {"Content-Type": "application/json", ("X-Admin-Token" if admin else "X-Worker-Token"): (env["RANKFLOW_ADMIN_TOKEN"] if admin else env["RANKFLOW_WORKER_TOKEN"])}
                req = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
                with urlopen(req, timeout=3) as response:
                    return json.load(response)
            try:
                for _ in range(50):
                    try:
                        request("/health")
                        break
                    except URLError:
                        time.sleep(0.1)
                else:
                    self.fail("server did not start")
                with self.assertRaises(HTTPError) as error:
                    urlopen(base + "/api/status", timeout=3)
                self.assertEqual(error.exception.code, 401)
                run = request("/api/runs", "POST", {"source_key": "http-test", "watchlist_id": "team", "pairs": [{"asin": ASIN_A, "keyword": "straw"}], "settings": {"top_n": 50}}, admin=True)
                job = request("/api/jobs/claim")["job"]
                self.assertEqual(job["run_id"], run["run_id"])
                request(f'/api/jobs/{job["job_id"]}/complete', "POST", {"lease_token": job["lease_token"], "rows": [{"asin": ASIN_A, "status": "found", "organic_rank": 7}]})
                status = request("/api/status", admin=True)
                self.assertEqual(status["runs"][0]["status"], "success")
                self.assertEqual(status["outbox"], 3)
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
