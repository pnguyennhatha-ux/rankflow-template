"""Owner (Lark user field on watchlist_item) end to end: Base input -> items -> job -> snapshot/crawl_run outbox -> Lark encode/backfill."""
import json
import logging
import tempfile
import unittest
from pathlib import Path

from backend.rankflow import (OPTIONAL_FIELDS, Lark, Store, backfill_snapshot_owners, expand_entries, owner_from_cell, parse_import)
import backend.rankflow as _rf
_rf.TABLES.update({k: "tblTest" + k for k in _rf.TABLE_NAMES})  # offline: skip by-name table lookup


logging.getLogger("rankflow").setLevel(logging.CRITICAL)
A1, A2 = "B0TEST0004", "B0TEST0008"
OU1, OU2 = "ou_" + "1" * 32, "ou_" + "2" * 32
P1 = [{"id": OU1, "name": "Hằng", "en_name": "Hằng", "email": "hana@example.com"}]
P2 = [{"id": OU2, "name": "Lan"}]


def row(keyword, asin, rank=None):
    return {"keyword": keyword, "asin": asin, "organicRank": rank, "pageNumber": 1 if rank else None, "positionOnPage": rank,
            "status": "ranked" if rank else "not_found_within_190", "snapshotDay": "2026-10-07"}


class OwnerStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "t.sqlite3"))
        self.store.mirror_from_base([("rw", {"watchlist_id": "team", "zip": "10001", "top_n": 190})], [
            ("ri1", {"watchlist_id": "team", "asin": A1, "keyword": "mug", "group": "G", "enabled": True, "owner": P1}),
            ("ri2", {"watchlist_id": "team", "asin": A2, "keyword": "mug", "group": "G", "enabled": True, "owner": P2}),
            ("ri3", {"watchlist_id": "team", "asin": A1, "keyword": "cup", "group": "G", "enabled": True, "owner": None}),
        ])

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def outbox(self, kind):
        return {r["key"]: json.loads(r["payload"]) for r in self.store.db.execute("SELECT key,payload FROM outbox WHERE kind=?", (kind,))}

    def test_owner_from_cell(self):
        self.assertEqual(owner_from_cell(P1), {"id": OU1, "name": "Hằng", "email": None})  # emails are never kept
        self.assertEqual(owner_from_cell({"id": OU2, "en_name": "Lan"})["name"], "Lan")
        self.assertEqual(owner_from_cell(OU1)["id"], OU1)
        for empty in (None, [], "", "Hằng", [{}], [{"name": "x"}]):
            self.assertIsNone(owner_from_cell(empty))

    def test_mirror_stores_owner_and_groups_expose_it(self):
        items = {(r["asin"], r["keyword"]): dict(r) for r in self.store.db.execute("SELECT * FROM items")}
        self.assertEqual((items[(A1, "mug")]["owner_id"], items[(A1, "mug")]["owner_name"], items[(A1, "mug")]["owner_email"]), (OU1, "Hằng", None))
        self.assertIsNone(items[(A1, "cup")]["owner_id"])
        g = self.store.list_groups("team")[0]
        self.assertEqual(sorted(o["name"] for o in g["owners"]), ["Hằng", "Lan"])
        a1 = next(a for a in g["asins"] if a["asin"] == A1)
        self.assertEqual(a1["owners"], {"mug": {"id": OU1, "name": "Hằng"}})
        pairs = self.store.enabled_pairs("team")
        self.assertEqual(next(p for p in pairs if p["asin"] == A1 and p["keyword"] == "mug")["owner_id"], OU1)
        self.assertNotIn("owner_id", next(p for p in pairs if p["keyword"] == "cup"))
        # Base owner change (or removal) wins on the next pull
        self.store.mirror_from_base([("rw", {"watchlist_id": "team", "zip": "10001", "top_n": 190})],
                                    [("ri1", {"watchlist_id": "team", "asin": A1, "keyword": "mug", "group": "G", "enabled": True, "owner": P2})])
        self.assertEqual(self.store.db.execute("SELECT owner_name FROM items WHERE asin=? AND keyword='mug'", (A1,)).fetchone()[0], "Lan")

    def test_owner_flows_job_to_snapshot_and_crawl_run(self):
        run_id = self.store.run_now("team")[0]["run_id"]
        job = self.store.claim_run("w1")
        by_owner = {(g["asins"][0], (g["owner"] or {}).get("id")): g for g in job["groups"]}
        self.assertEqual(set(by_owner), {(A1, OU1), (A2, OU2), (A1, None)})  # same ASIN+group, different owners -> separate groups
        self.assertEqual(by_owner[(A1, OU1)]["owner"], {"id": OU1, "name": "Hằng"})
        self.assertEqual(by_owner[(A1, OU1)]["keywords"], ["mug"])
        self.assertTrue(by_owner[(A1, OU1)]["id"].endswith("@" + OU1))
        self.assertIsNone(by_owner[(A1, None)]["owner"])
        self.store.complete_run(job["lease_token"], {"rows": [row("mug", A1, 5), row("mug", A2), row("cup", A1, 9)], "warnings": []})
        snaps = self.outbox("snapshots")
        self.assertEqual(snaps[f"{run_id}:{A1}:mug"]["owner"], [OU1])
        self.assertEqual(snaps[f"{run_id}:{A2}:mug"]["owner"], [OU2])
        self.assertIsNone(snaps[f"{run_id}:{A1}:cup"]["owner"])
        local = {(r["asin"], r["keyword"]): r["owner_name"] for r in self.store.db.execute("SELECT * FROM snapshots")}
        self.assertEqual(local[(A1, "mug")], "Hằng")
        self.assertEqual(self.outbox("runs")[run_id]["owners"], sorted([OU1, OU2]))

    def test_resolve_owner_and_upsert(self):
        self.assertEqual(self.store.resolve_owner(OU1)["name"], "Hằng")
        self.assertEqual(self.store.resolve_owner("ou_" + "9" * 32), {"id": "ou_" + "9" * 32, "name": None, "email": None})
        self.assertEqual(self.store.resolve_owner("hằng")["id"], OU1)
        self.assertEqual(self.store.resolve_owner("HẰNG")["id"], OU1)
        with self.assertRaises(ValueError):
            self.store.resolve_owner("hana@example.com")  # no email lookup (emails are not stored)
        self.assertIsNone(self.store.resolve_owner("-"))
        with self.assertRaisesRegex(ValueError, "not found"):
            self.store.resolve_owner("Nobody")
        self.store.db.execute("DELETE FROM outbox")
        stats = self.store.upsert_items("team", expand_entries({"asins": [A1], "keywords": "cup;new kw", "group": "G", "owner": "Lan"}), "cli")
        self.assertEqual((stats["added"], stats["reowned"]), (1, 1))
        items = self.outbox("items")
        self.assertEqual(items[f"team|{A1}|cup"]["owner"], [OU2])
        self.assertEqual(items[f"team|{A1}|new kw"]["owner"], [OU2])
        # omitted owner keeps the existing one and does not touch Base owner
        self.store.db.execute("DELETE FROM outbox")
        self.store.upsert_items("team", [{"asin": A1, "keyword": "mug", "group": "G2"}], "cli")
        self.assertNotIn("owner", self.outbox("items")[f"team|{A1}|mug"])
        self.assertEqual(self.store.db.execute("SELECT owner_id FROM items WHERE asin=? AND keyword='mug'", (A1,)).fetchone()[0], OU1)
        # '-' clears (Base cell written as [])
        self.store.upsert_items("team", [{"asin": A1, "keyword": "mug", "owner": "-"}], "cli")
        self.assertEqual(self.outbox("items")[f"team|{A1}|mug"]["owner"], [])
        with self.assertRaises(ValueError):
            self.store.upsert_items("team", [{"asin": A1, "keyword": "mug", "owner": "Nobody"}], "cli")

    def test_import_owner_column(self):
        entries = parse_import("asin,keyword,group,owner\n%s,mug,G,Lan\n%s,cup,G,\n" % (A1, A2))
        self.assertEqual([e["owner"] for e in entries], ["Lan", None])
        js = parse_import(json.dumps({"groups": [{"group": "G", "owner": OU1, "items": [{"asin": A1, "keywords": ["a", "b"]}]}]}))
        self.assertEqual({e["owner"] for e in js}, {OU1})
        stats = self.store.import_entries("team", entries, False, "import")
        self.assertEqual(stats["added"], 1)


class FakeApiLark(Lark):
    """Real Lark encode/logical/batch_update; HTTP replaced by in-memory tables."""
    def __init__(self, fields, records):
        super().__init__("a", "b", "base")
        self.token_until = 1e12
        self.meta, self.records, self.calls = fields, records, []

    def call(self, method, path, body=None):
        kind = next(k for k in ("snapshots", "items", "runs") if path.startswith(self.path(k)))
        if path.endswith("/fields?page_size=500"):
            return {"items": [{"field_id": "fld" + n, "field_name": n, "type": t} for n, t in self.meta[kind].items()]}
        if "/records?" in path:
            return {"items": self.records[kind], "has_more": False}
        self.calls.append((method, path, body))
        return {}


class OwnerLarkTests(unittest.TestCase):
    def test_optional_fields_and_encode(self):
        self.assertEqual(OPTIONAL_FIELDS["snapshots"]["owner"], 11)
        self.assertEqual(OPTIONAL_FIELDS["runs"]["owners"], 11)
        lark = Lark("a", "b", "c")
        lark.types = {"snapshots": {"owner": 11}, "runs": {"owners": 11}}
        self.assertEqual(lark.encode("snapshots", "owner", [OU1]), [{"id": OU1}])
        self.assertEqual(lark.encode("snapshots", "owner", OU1), [{"id": OU1}])
        self.assertEqual(lark.encode("runs", "owners", [OU1, {"id": OU2, "name": "x"}]), [{"id": OU1}, {"id": OU2}])
        self.assertEqual(lark.encode("snapshots", "owner", []), [])

    def test_backfill_only_fills_empty_owner(self):
        from backend.rankflow import FIELDS
        snap_fields = {n: 1 for n in FIELDS["snapshots"]} | {"owner": 11, "group": 1}
        item_fields = {n: 1 for n in FIELDS["items"]} | {"owner": 11}
        records = {
            "items": [{"record_id": "i1", "fields": {"asin": A1, "keyword": "Mug", "enabled": True, "owner": P1}},
                      {"record_id": "i2", "fields": {"asin": A2, "keyword": "cup", "enabled": True}}],
            "snapshots": [{"record_id": "s1", "fields": {"asin": A1, "keyword": "mug"}},                    # filled
                          {"record_id": "s2", "fields": {"asin": A1, "keyword": "mug", "owner": P2}},       # already set: untouched
                          {"record_id": "s3", "fields": {"asin": A2, "keyword": "cup"}},                    # item has no owner
                          {"record_id": "s4", "fields": {"asin": A2, "keyword": "other"}}],
        }
        lark = FakeApiLark({"snapshots": snap_fields, "items": item_fields, "runs": {}}, records)
        dry = backfill_snapshot_owners(lark, write=False)
        self.assertEqual((dry["to_fill"], dry["already_set"], dry["no_owner_for_pair"], dry["written"]), (1, 1, 2, 0))
        self.assertEqual(lark.calls, [])
        done = backfill_snapshot_owners(lark, write=True)
        self.assertEqual(done["written"], 1)
        method, path, body = lark.calls[0]
        self.assertTrue(path.endswith("/records/batch_update"))
        self.assertEqual(body, {"records": [{"record_id": "s1", "fields": {"owner": [{"id": OU1}]}}]})


if __name__ == "__main__":
    unittest.main()
