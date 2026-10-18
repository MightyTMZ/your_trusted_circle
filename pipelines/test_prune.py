"""Tests for the pruning pipeline, against small in-memory stand-ins for MongoDB collections."""

import unittest
from datetime import datetime, timedelta, timezone

from pipelines.prune import prune

NOW = datetime(2026, 11, 30, tzinfo=timezone.utc)
CUTOFF = NOW - timedelta(days=30)
OLD = NOW - timedelta(days=40)
RECENT = NOW - timedelta(days=1)


def matches(doc, query):
    for key, cond in query.items():
        if key == "$or":
            if not any(matches(doc, q) for q in cond):
                return False
            continue
        value = doc.get(key)
        if isinstance(cond, dict):
            for op, arg in cond.items():
                if op == "$lt" and not (value is not None and value < arg):
                    return False
                if op == "$in" and value not in arg:
                    return False
                if op == "$type" and not isinstance(value, str):
                    return False
        elif value != cond:
            return False
    return True


class Result:
    def __init__(self, n):
        self.deleted_count = n


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    def find(self, query, projection=None):
        return [d for d in self.docs if matches(d, query)]

    def distinct(self, key, query):
        return sorted({d[key] for d in self.docs if matches(d, query)})

    def count_documents(self, query):
        return len(self.find(query))

    def delete_many(self, query):
        keep = [d for d in self.docs if not matches(d, query)]
        n = len(self.docs) - len(keep)
        self.docs = keep
        return Result(n)


def database():
    return {
        "traces": FakeCollection([{"_id": "t1", "receivedAt": OLD}, {"_id": "t2", "receivedAt": RECENT}]),
        "raw_recordings": FakeCollection([{"_id": "r1", "receivedAt": OLD}]),
        "sessions": FakeCollection(
            [
                {"_id": "ses_old", "status": "ended", "endedAt": OLD},
                {"_id": "ses_expired", "status": "active", "expiresAt": OLD},
                {"_id": "ses_busy", "status": "ended", "endedAt": OLD},
                {"_id": "ses_new", "status": "ended", "endedAt": RECENT},
            ]
        ),
        "incidents": FakeCollection(
            [
                {"_id": "inc_done", "sessionId": "ses_old", "activeKey": None},
                {"_id": "inc_open", "sessionId": "ses_busy", "activeKey": "ses_busy:par_1"},
            ]
        ),
        "checkins": FakeCollection([{"_id": "c1", "sessionId": "ses_old"}, {"_id": "c2", "sessionId": "ses_new"}]),
        "notification_jobs": FakeCollection([{"_id": "n1", "sessionId": "ses_expired"}]),
        "contact_invites": FakeCollection([{"_id": "i1", "sessionId": "ses_old"}]),
        "timeline_events": FakeCollection([{"session_id": "ses_old", "seq": 1}, {"session_id": "ses_busy", "seq": 1}]),
    }


class PruneTest(unittest.TestCase):
    def test_deletes_old_data_and_keeps_active_incidents(self):
        db = database()
        result = prune(db, CUTOFF)
        self.assertEqual(result["deleted"]["traces"], 1)
        self.assertEqual(result["deleted"]["raw_recordings"], 1)
        self.assertEqual(result["deleted"]["sessions"], 2)
        remaining = {s["_id"] for s in db["sessions"].docs}
        self.assertEqual(remaining, {"ses_busy", "ses_new"})
        self.assertEqual([d["_id"] for d in db["incidents"].docs], ["inc_open"])
        self.assertEqual([d["session_id"] for d in db["timeline_events"].docs], ["ses_busy"])
        self.assertEqual([d["_id"] for d in db["checkins"].docs], ["c2"])

    def test_dry_run_counts_without_deleting(self):
        db = database()
        result = prune(db, CUTOFF, dry_run=True)
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["deleted"]["sessions"], 2)
        self.assertEqual(len(db["sessions"].docs), 4)
        self.assertEqual(len(db["traces"].docs), 2)


if __name__ == "__main__":
    unittest.main()
