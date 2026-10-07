"""Org member sync (Lark contact -> local cache + Base table `member`) and owner resolution by member name."""
import logging
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from backend.rankflow import (Engine, Lark, Store, UserSourceError, fetch_members, fetch_members_as_user, merge_member_sources,
                              sync_members_to_base)
import backend.rankflow as _rf
_rf.TABLES.update({k: "tblTest" + k for k in _rf.TABLE_NAMES})  # offline: skip by-name table lookup

logging.getLogger("rankflow").setLevel(logging.CRITICAL)
OU = ["ou_" + str(i) * 32 for i in range(1, 6)]


def user(oid, name, dept, email=None, resigned=False):
    return {"open_id": oid, "name": name, "email": email, "department_ids": [dept], "avatar": {"avatar_240": f"https://img/{oid}.png"},
            "status": {"is_resigned": resigned}}


class FakeContactLark(Lark):
    def __init__(self, scope_depts, scope_users, children, by_dept, singles):
        super().__init__("a", "b", "BASE")
        self.token_until = 1e12
        self.scope_depts, self.scope_users, self.children, self.by_dept, self.singles = scope_depts, scope_users, children, by_dept, singles
        self.tables, self.records, self.writes = {}, {}, []

    def call(self, method, path, body=None):
        u = urlparse(path)
        q = {k: v for k, v in parse_qs(u.query).items()}
        p = u.path
        if p == "/contact/v3/scopes":
            return {"department_ids": self.scope_depts, "user_ids": self.scope_users, "has_more": False}
        if p == "/tenant/v2/tenant/query":
            return {"tenant": {"name": "ACME ORG"}}
        if p.startswith("/contact/v3/departments/") and p.endswith("/children"):
            return {"items": self.children.get(p.split("/")[4], []), "has_more": False}
        if p.startswith("/contact/v3/departments/"):
            return {"department": {"name": "Dept " + p.split("/")[4]}}
        if p == "/contact/v3/users/find_by_department":
            d = q["department_id"][0]
            items = self.by_dept.get(d, [])
            if "page_token" not in q and len(items) > 1:  # exercise pagination
                return {"items": items[:1], "has_more": True, "page_token": "t2"}
            return {"items": items[1:] if "page_token" in q else items, "has_more": False}
        if p == "/contact/v3/users/batch":
            return {"items": [self.singles[x] for x in q["user_ids"]]}
        base = "/bitable/v1/apps/BASE/tables"
        if p == base and method == "GET":
            return {"items": [{"table_id": tid, "name": t["name"]} for tid, t in self.tables.items()], "has_more": False}
        if p == base and method == "POST":
            tid = "tblMember000001"
            self.tables[tid] = {"name": body["table"]["name"], "fields": [f["field_name"] for f in body["table"]["fields"]], "props": {f["field_name"]: f.get("property") for f in body["table"]["fields"]}}
            self.records[tid] = {}
            self.writes.append(("create_table", body))
            return {"table_id": tid}
        if p.endswith("/fields"):
            return {"items": [{"field_name": n} for n in self.tables[p.split("/")[6]]["fields"]]}
        tid = p.split("/")[6]
        if p.endswith("/records") and method == "GET":
            return {"items": [{"record_id": rid, "fields": f} for rid, f in self.records[tid].items()], "has_more": False}
        if p.endswith("/batch_create"):
            for r in body["records"]:
                self.records[tid][f"rec{len(self.records[tid]) + 1}"] = dict(r["fields"])
            self.writes.append(("create", len(body["records"])))
            return {}
        if p.endswith("/batch_update"):
            for r in body["records"]:
                self.records[tid][r["record_id"]].update(r["fields"])
            self.writes.append(("update", len(body["records"])))
            return {}
        raise AssertionError(f"unexpected {method} {path}")


def org(**kw):
    by_dept = {"0": [user(OU[0], "Hana", "0"), user(OU[1], "Lan", "0", "lan@x.com")], "od-a": [user(OU[2], "Minh", "od-a"), user(OU[3], "Old", "od-a", resigned=True)]}
    return FakeContactLark(kw.get("depts", ["0"]), kw.get("users", [OU[4]]), {"0": [{"open_department_id": "od-a", "name": "Sales"}]}, by_dept, {OU[4]: user(OU[4], "Guest", "od-z")})


class MemberSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "t.sqlite3"))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_fetch_walks_departments_recursively_and_scope_users(self):
        members, stats = fetch_members(org())
        self.assertEqual([m["name"] for m in members], ["Guest", "Hana", "Lan", "Minh", "Old"])
        self.assertEqual((stats["members"], stats["active"], stats["departments_walked"], stats["tenant"]), (5, 4, 2, "ACME ORG"))
        minh = next(m for m in members if m["name"] == "Minh")
        self.assertEqual((minh["departments"], minh["avatar_url"]), (["Sales"], f"https://img/{OU[2]}.png"))
        self.assertEqual(next(m for m in members if m["name"] == "Hana")["departments"], ["ACME ORG"])
        self.assertFalse(next(m for m in members if m["name"] == "Old")["active"])

    def test_base_table_created_once_and_sync_is_idempotent(self):
        lark = org()
        members, _ = fetch_members(lark)
        first = sync_members_to_base(lark, members)
        self.assertEqual((first["created"], first["updated"]), (5, 0))
        self.assertIn("person", first["created_columns"])
        table = lark.tables["tblMember000001"]
        self.assertEqual(table["props"]["person"], {"multiple": False})
        row = next(f for f in lark.records["tblMember000001"].values() if f["open_id"] == OU[1])
        self.assertEqual((row["person"], row["active"]), ([{"id": OU[1]}], True))
        self.assertNotIn("email", row)
        self.assertNotIn("email", lark.tables["tblMember000001"]["fields"])  # name/avatar only, never email
        self.assertEqual(row["avatar_url"], {"text": f"https://img/{OU[1]}.png", "link": f"https://img/{OU[1]}.png"})
        # Base returns URL cells as {link, text}; a second run with the same org writes nothing
        lark.writes.clear()
        second = sync_members_to_base(lark, members)
        self.assertEqual((second["created"], second["updated"], second["unchanged"], second["created_columns"]), (0, 0, 5, []))
        self.assertEqual(lark.writes, [])
        # someone leaves the contact range -> active=false (never deleted); empty fetch never deactivates
        third = sync_members_to_base(lark, [m for m in members if m["open_id"] != OU[2]])
        self.assertEqual(third["deactivated"], 1)
        self.assertFalse(next(f for f in lark.records["tblMember000001"].values() if f["open_id"] == OU[2])["active"])
        self.assertEqual(sync_members_to_base(lark, [])["deactivated"], 0)

    def test_engine_sync_feeds_owner_resolution(self):
        stats = Engine(self.store, org()).sync_members(source="app")
        self.assertEqual((stats["members"], stats["local"]["members"], stats["base"]["created"]), (5, 5, 5))
        self.assertEqual(len(self.store.list_members()), 4)  # resigned one is inactive
        self.assertTrue(all(m["email"] is None for m in self.store.list_members(True)))  # email never stored
        self.assertEqual(self.store.resolve_owner("Lan")["id"], OU[1])
        self.assertEqual(self.store.resolve_owner("Minh")["id"], OU[2])
        with self.assertRaisesRegex(ValueError, "not found"):
            self.store.resolve_owner("Old")  # inactive members are not offered
        stats = self.store.upsert_items("team", [{"asin": "B0AAAAAAAA", "keyword": "mug", "owner": "Minh"}], "cli")
        self.assertEqual(stats["added"], 1)
        self.assertEqual(self.store.db.execute("SELECT owner_name FROM items").fetchone()[0], "Minh")


def user_get_factory(org_users, children=(), fail=False):
    """Fake lark-cli user identity: GET path/params -> data (paginates find_by_department by 1)."""
    calls = []

    def get(path, params):
        calls.append((path, dict(params)))
        if fail:
            raise UserSourceError("lark-cli authorization/token_expired 99991677: token expired")
        if path.endswith("/children"):
            return {"items": list(children), "has_more": False}
        users = [u for u in org_users if u["dept"] == params["department_id"]]
        start = int(params.get("page_token") or 0)
        page = users[start:start + 1]
        more = start + 1 < len(users)
        return {"items": [{"open_id": u["open_id"], "name": u["name"], "en_name": u.get("en_name", ""), "avatar": {"avatar_240": f"https://img/{u['open_id']}"}} for u in page],
                "has_more": more, **({"page_token": str(start + 1)} if more else {})}
    get.calls = calls
    return get


ORG20 = [{"open_id": OU[0], "name": "Hana", "dept": "0"}, {"open_id": OU[1], "name": "Lan", "dept": "0"}, {"open_id": OU[2], "name": "Minh", "dept": "od-a"},
         {"open_id": "ou_" + "a" * 32, "name": "Bích Ngọc", "dept": "0", "en_name": "Bich"}]


class UserSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "t.sqlite3"))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_user_listing_walks_children_and_pages(self):
        get = user_get_factory(ORG20, [{"open_department_id": "od-a", "name": "Sales"}])
        members, stats = fetch_members_as_user(get, "ACME ORG")
        self.assertEqual([m["name"] for m in members], ["Bích Ngọc", "Hana", "Lan", "Minh"])
        self.assertEqual(stats["departments_walked"], 2)
        self.assertEqual(next(m for m in members if m["name"] == "Minh")["departments"], ["Sales"])
        self.assertTrue(any("page_token" in p for _, p in get.calls))  # paginated
        self.assertTrue(all(p["user_id_type"] == "open_id" for _, p in get.calls if "find_by_department" in _))

    def test_merge_by_open_id_keeps_app_status(self):
        app, _ = fetch_members(org())  # OU0..OU4 via app token (OU3 resigned)
        user, _ = fetch_members_as_user(user_get_factory(ORG20), "ACME ORG")
        merged, stats = merge_member_sources(app, user)
        self.assertEqual(stats["in_both"], 2)  # Hana, Lan listed at root by both
        self.assertTrue(stats["open_id_matched"])
        self.assertEqual(len(merged), 6)
        self.assertFalse(next(m for m in merged if m["open_id"] == OU[3])["active"])

    def test_engine_auto_merges_and_failure_keeps_rows(self):
        stats = Engine(self.store, org()).sync_members(user_get=user_get_factory(ORG20))
        self.assertTrue(stats["complete"])
        self.assertEqual(stats["members"], 6)
        lark = org()
        Engine(self.store, lark).sync_members(user_get=user_get_factory(ORG20))
        self.assertEqual(len(lark.records["tblMember000001"]), 6)
        # expired user token: only the app's 5 come back, but nobody is deactivated (local or Base)
        failed = Engine(self.store, lark).sync_members(user_get=user_get_factory(ORG20, fail=True))
        self.assertFalse(failed["complete"])
        self.assertIn("token expired", failed["user_source"]["error"])
        self.assertEqual(failed["base"]["deactivated"], 0)
        self.assertTrue(next(f for f in lark.records["tblMember000001"].values() if f["name"] == "Bích Ngọc")["active"])
        self.assertIn("Bích Ngọc", [m["name"] for m in self.store.list_members()])

    def test_legacy_email_column_is_deleted(self):
        lark = org()
        lark.tables["tblOld"] = {"name": "member", "fields": ["name", "open_id", "email"], "props": {}}
        lark.records["tblOld"] = {}
        deleted = []
        orig = lark.call

        def call(method, path, body=None):
            if path.endswith("/fields?page_size=500"):
                return {"items": [{"field_name": n, "field_id": "fld" + n} for n in lark.tables["tblOld"]["fields"]]}
            if method == "DELETE":
                deleted.append(path.rsplit("/", 1)[1])
                return {}
            if method == "POST" and path.endswith("/fields"):
                lark.tables["tblOld"]["fields"].append(body["field_name"])
                return {}
            return orig(method, path, body)
        lark.call = call
        out = sync_members_to_base(lark, [{"open_id": OU[0], "name": "Hana", "active": True}])
        self.assertEqual(deleted, ["fldemail"])
        self.assertIn("-email", out["created_columns"])


if __name__ == "__main__":
    unittest.main()
