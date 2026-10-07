"""v2.2: group names end to end, long-poll /job, groups version, result meta/warnings, optional Base fields."""
import json
import logging
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from backend.rankflow import OPTIONAL_FIELDS, Engine, Lark, Store, make_handler
import backend.rankflow as _rf
_rf.TABLES.update({k: "tblTest" + k for k in _rf.TABLE_NAMES})  # offline: skip by-name table lookup


logging.getLogger("rankflow").setLevel(logging.CRITICAL)
A1, A2 = "B0TEST0004", "B0TEST0008"


def row(keyword, asin, rank=None, page=None, pos=None, group="?"):
    status = "ranked" if rank else "not_found_within_100"
    return {"keyword": keyword, "asin": asin, "organicRank": rank, "pageNumber": page, "positionOnPage": pos, "status": status, "groupName": group, "snapshotDay": "2026-10-06"}


class GroupFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "t.sqlite3"))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def outbox(self, kind):
        return {r["key"]: json.loads(r["payload"]) for r in self.store.db.execute("SELECT key,payload FROM outbox WHERE kind=?", (kind,))}

    def test_concurrency_is_capped_at_two(self):
        import os
        self.store.mirror_from_base([("rw", {"watchlist_id": "team", "zip": "10001", "top_n": 100})],
                                    [("ri1", {"watchlist_id": "team", "asin": A1, "keyword": "mug", "group": "G", "enabled": True})])
        old = os.environ.get("RANKFLOW_2J_CONCURRENCY")
        try:
            for value, expected in (("4", 2), ("1", 1), ("0", 1)):
                os.environ["RANKFLOW_2J_CONCURRENCY"] = value
                self.store.run_now("team")
                job = self.store.claim_run("w-" + value)
                self.assertEqual(job["concurrency"], expected)
                self.store.complete_run(job["lease_token"], {"rows": [row("mug", A1)], "warnings": []})
        finally:
            if old is None: os.environ.pop("RANKFLOW_2J_CONCURRENCY", None)
            else: os.environ["RANKFLOW_2J_CONCURRENCY"] = old

    def test_group_flows_from_item_to_job_snapshot_and_crawl_run(self):
        # Base watchlist_item.group (block UI input) -> local items via mirror
        self.store.mirror_from_base([("rw", {"watchlist_id": "team", "zip": "10001", "top_n": 100})],
                                    [("ri1", {"watchlist_id": "team", "asin": A1, "keyword": "father of the bride gift", "group": "GRPA", "enabled": True}),
                                     ("ri2", {"watchlist_id": "team", "asin": A2, "keyword": "halloween mug", "group": "Mugs", "enabled": True})])
        runs = self.store.run_now("team")
        job = self.store.claim_run("w1")
        names = sorted(g["name"] for g in job["groups"])
        self.assertEqual(names, ["GRPA", "Mugs"])
        self.assertEqual(job["concurrency"], 2)  # fixed 2 slots by default
        self.assertEqual(job["scope"], "*")
        out = self.store.complete_run(job["lease_token"], {"rows": [row("father of the bride gift", A1, 16, 1, 16), row("halloween mug", A2)],
                                                            "warnings": ["Amazon CAPTCHA: 1 lần"], "meta": {"timing": {"totalMs": 1234}}})
        self.assertEqual(out["run_status"], "success")
        snaps = {r["asin"]: dict(r) for r in self.store.db.execute("SELECT * FROM snapshots")}
        self.assertEqual((snaps[A1]["grp"], snaps[A2]["grp"]), ("GRPA", "Mugs"))
        payloads = self.outbox("snapshots")
        self.assertEqual(payloads[f'{runs[0]["run_id"]}:{A1}:father of the bride gift']["group"], "GRPA")
        self.assertEqual(payloads[f'{runs[0]["run_id"]}:{A1}:father of the bride gift']["position_on_page"], "#16 P1")
        self.assertEqual(self.outbox("runs")[runs[0]["run_id"]]["groups"], "GRPA, Mugs")
        detail = self.store.run_detail(runs[0]["run_id"])
        self.assertEqual(detail["leases"][0]["warnings"], ["Amazon CAPTCHA: 1 lần"])
        self.assertEqual(detail["leases"][0]["meta"]["timing"]["totalMs"], 1234)
        ev = self.store.db.execute("SELECT level,message FROM events WHERE kind='result'").fetchone()
        self.assertEqual(ev["level"], "warning")
        self.assertIn("Amazon CAPTCHA", ev["message"])

    def test_group_scope_run_note_and_no_warning_noise(self):
        self.store.upsert_items("team", [{"asin": A1, "keyword": "k1", "group": "G1"}, {"asin": A2, "keyword": "k2", "group": "G2"}])
        run_id = self.store.run_now("team", "G1")[0]["run_id"]
        job = self.store.claim_run("w")
        self.assertEqual(job["scope"], "group:G1")
        self.assertEqual([g["name"] for g in job["groups"]], ["G1"])
        self.store.complete_run(job["lease_token"], {"rows": [row("k1", A1, 3, 1, 3)], "warnings": []})
        run = self.outbox("runs")[run_id]
        self.assertIn("group:G1", run["note"])
        self.assertEqual(run["groups"], "G1")
        ev = self.store.db.execute("SELECT level,message FROM events WHERE kind='result'").fetchone()
        self.assertEqual(ev["level"], "info")
        self.assertNotIn("warnings", ev["message"])

    def test_default_depth_is_190_and_survives_base_pull(self):
        from backend.rankflow import DEFAULT_TOP_N
        self.assertEqual(DEFAULT_TOP_N, 190)
        # new watchlist (no Base value yet) -> 190 everywhere
        self.store.upsert_items("fresh", [{"asin": A1, "keyword": "mug", "group": "G"}], "test")
        self.assertEqual(self.store.get_watchlist("fresh")["top_n"], 190)
        self.assertEqual(self.store.get_watchlist("missing")["top_n"], 190)
        run_id = self.store.enqueue("manual:nodepth", "fresh", [{"asin": A1, "keyword": "mug"}], {})
        self.assertEqual(json.loads(self.store.db.execute("SELECT settings FROM runs WHERE id=?", (run_id,)).fetchone()[0])["top_n"], 190)
        self.store.cancel_run(run_id)
        # Base watchlist top_n=190 is mirrored (pull keeps it), job asks the worker for 190 organic
        self.store.mirror_from_base([("rw", {"watchlist_id": "team", "zip": "10001", "top_n": 190})],
                                    [("ri1", {"watchlist_id": "team", "asin": A1, "keyword": "deep kw", "group": "G", "enabled": True}),
                                     ("ri2", {"watchlist_id": "team", "asin": A2, "keyword": "deep kw", "group": "G", "enabled": True})])
        self.assertEqual(self.store.get_watchlist("team")["top_n"], 190)
        run_id = self.store.run_now("team")[0]["run_id"]
        job = self.store.claim_run("w-depth")
        self.assertEqual(job["maxOrganic"], 190)
        self.store.complete_run(job["lease_token"], {"rows": [row("deep kw", A1, 187, 5, 11, "G"), row("deep kw", A2, 195, 5, 19, "G")], "warnings": []})
        snaps = {r["asin"]: (r["status"], r["organic_rank"]) for r in self.store.db.execute("SELECT asin,status,organic_rank FROM snapshots WHERE run_id=?", (run_id,))}
        self.assertEqual(snaps[A1], ("found", 187))      # rank 101..190 now counts as found
        self.assertEqual(snaps[A2], ("not_found", None))  # beyond the requested depth is never reported as a rank

    def _mixed_items(self):
        self.store.mirror_from_base([("rw", {"watchlist_id": "team", "zip": "10001", "top_n": 100})], [
            ("r1", {"watchlist_id": "team", "asin": A1, "keyword": "grpa gift", "group": "NA", "enabled": True}),
            ("r2", {"watchlist_id": "team", "asin": A1, "keyword": "grpa mug", "group": "NA  1", "enabled": True}),
            ("r3", {"watchlist_id": "team", "asin": A2, "keyword": "halloween mug", "group": None, "enabled": True}),
            ("r4", {"watchlist_id": "team", "asin": A2, "keyword": "ghost mug", "group": "", "enabled": True}),
            ("r5", {"watchlist_id": "team", "asin": A2, "keyword": "pumpkin mug", "group": None, "enabled": False}),
        ])

    def _run_pairs(self, run_id):
        jobs = self.store.db.execute("SELECT keyword,targets FROM jobs WHERE run_id=?", (run_id,)).fetchall()
        return sorted((t["asin"], j["keyword"], t["group"]) for j in jobs for t in json.loads(j["targets"]))

    def test_run_now_no_group_sentinel_selects_only_ungrouped_pairs(self):
        from backend.rankflow import NO_GROUP
        self._mixed_items()
        out = self.store.run_now("team", NO_GROUP)
        self.assertEqual(out[0]["group"], NO_GROUP)
        self.assertEqual(out[0]["pairs"], 2)
        run_id = out[0]["run_id"]
        self.assertEqual(self._run_pairs(run_id), [(A2, "ghost mug", ""), (A2, "halloween mug", "")])  # disabled 'pumpkin mug' excluded
        scope = self.store.db.execute("SELECT scope FROM runs WHERE id=?", (run_id,)).fetchone()[0]
        self.assertEqual(scope, f"group:{NO_GROUP}")
        job = self.store.claim_run("w1")
        self.assertEqual(sorted(k for g in job["groups"] for k in g["keywords"]), ["ghost mug", "halloween mug"])
        self.store.complete_run(job["lease_token"], {"rows": [row("halloween mug", A2, 3, 1, 3, ""), row("ghost mug", A2)], "warnings": []})
        self.assertIn("group:(no group)", self.outbox("runs")[run_id]["note"])
        # explicit '' means the same thing (API clients); worker endpoint path goes through the same run_now
        self.assertEqual(self.store.run_now("team", "")[0]["pairs"], 2)

    def test_run_now_without_group_still_runs_all_groups(self):
        self._mixed_items()
        out = self.store.run_now("team")
        self.assertIsNone(out[0]["group"])
        self.assertEqual(out[0]["pairs"], 4)
        self.assertEqual(sorted(p[2] for p in self._run_pairs(out[0]["run_id"])), ["", "", "NA", "NA  1"])
        self.assertEqual(self.store.db.execute("SELECT scope FROM runs WHERE id=?", (out[0]["run_id"],)).fetchone()[0], "*")

    def test_named_group_run_and_sentinel_never_stored_as_group(self):
        from backend.rankflow import NO_GROUP
        self._mixed_items()
        self.assertEqual([p[1] for p in self._run_pairs(self.store.run_now("team", "NA  1")[0]["run_id"])], ["grpa mug"])
        self.store.upsert_items("team", [{"asin": A1, "keyword": "new kw", "group": NO_GROUP}], "test")
        self.assertEqual(self.store.db.execute("SELECT grp FROM items WHERE keyword='new kw'").fetchone()[0], "")
        self.assertNotIn(NO_GROUP, {g["group"] for g in self.store.list_groups("team")})

    def test_worker_run_now_http_ungrouped_vs_all(self):
        from backend.rankflow import NO_GROUP
        self._mixed_items()
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Engine(self.store, None), "w" * 30, "a" * 30))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def post(body):
                req = Request(f"http://127.0.0.1:{server.server_address[1]}/worker/run-now", data=json.dumps(body).encode(), method="POST",
                              headers={"Content-Type": "application/json", "X-Worker-Token": "w" * 30})
                with urlopen(req, timeout=5) as r:
                    return json.load(r)["runs"]
            ungrouped = post({"group": NO_GROUP, "watchlist_id": "team"})
            self.assertEqual((ungrouped[0]["group"], ungrouped[0]["pairs"]), (NO_GROUP, 2))
            everything = post({"watchlist_id": "team"})
            self.assertEqual((everything[0]["group"], everything[0]["pairs"]), (None, 4))
        finally:
            server.shutdown()
            server.server_close()

    def test_groups_version_changes_only_on_real_changes(self):
        v0 = self.store.groups_version()
        self.store.upsert_items("team", [{"asin": A1, "keyword": "k1", "group": "G1"}])
        v1 = self.store.groups_version()
        self.assertNotEqual(v0, v1)
        base_items = [("ri1", {"watchlist_id": "team", "asin": A1, "keyword": "k1", "group": "G1", "enabled": True})]
        self.store.mirror_from_base([], base_items)
        v2 = self.store.groups_version()
        time.sleep(1.1)
        self.store.mirror_from_base([], base_items)  # identical pull -> no churn
        self.assertEqual(self.store.groups_version(), v2)


class LongPollTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "t.sqlite3"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Engine(self.store, None), "w" * 30, "a" * 30))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.store.db.close()
        self.tmp.cleanup()

    def get_job(self, wait):
        req = Request(self.base + f"/job?wait={wait}", headers={"X-Worker-Id": "2j-test"})
        with urlopen(req, timeout=40) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body else None), resp.headers.get("X-Groups-Version")

    def test_long_poll_returns_204_after_wait_and_wakes_on_enqueue(self):
        t0 = time.monotonic()
        status, _, version = self.get_job(1)
        self.assertEqual(status, 204)
        self.assertGreaterEqual(time.monotonic() - t0, 0.9)
        self.assertTrue(version)
        self.store.upsert_items("team", [{"asin": A1, "keyword": "k1", "group": "G1"}])
        threading.Timer(0.5, lambda: self.store.run_now("team")).start()
        t0 = time.monotonic()
        status, job, version2 = self.get_job(10)
        elapsed = time.monotonic() - t0
        self.assertEqual(status, 200)
        self.assertLess(elapsed, 3.0)  # woke on enqueue, not after the full wait
        self.assertEqual(job["groups"][0]["name"], "G1")
        self.assertNotEqual(version, version2)
        self.assertIn("2j-test", self.store.worker_status()["workers_seen"])

    def test_wait_is_capped(self):
        status, _, _ = self.get_job("abc")  # invalid -> no wait
        self.assertEqual(status, 204)


class OptionalFieldTests(unittest.TestCase):
    def test_optional_fields_resolved_by_name_and_skipped_when_missing(self):
        lark = Lark("id", "secret", "base")
        from backend.rankflow import FIELDS
        snap_items = [{"field_id": fid, "field_name": name} for name, fid in FIELDS["snapshots"].items()]
        calls = []

        def fake_call(method, path, body=None):
            calls.append((method, path, body))
            if path.endswith("/fields?page_size=500"):
                return {"items": snap_items}
            return {"record": {"record_id": "rec1"}}
        lark.call = fake_call
        lark.write("snapshots", {"asin": A1, "keyword": "k", "group": "G1"})
        self.assertNotIn("group", calls[-1][2]["fields"])  # column missing -> skipped, no error
        self.assertNotIn("group", lark.fields("snapshots"))
        lark.names.clear()
        snap_items.append({"field_id": "fldNEW", "field_name": "group"})
        lark.write("snapshots", {"asin": A1, "keyword": "k", "group": "G1"})
        self.assertEqual(calls[-1][2]["fields"]["group"], "G1")
        self.assertIn("runs", OPTIONAL_FIELDS)


if __name__ == "__main__":
    unittest.main()
