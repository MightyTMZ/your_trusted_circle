"""Scheduled pruning of old YTC data (box 5 of docs/YTC Grand Architecture.png).

Applies the same retention rules as the API (src/server/store/*.ts, pruneBefore):

- traces and raw_recordings received before the cutoff are deleted;
- sessions that ended before the cutoff, or are still marked active but
  expired before it, are deleted with their checkins, incidents,
  notification_jobs, contact_invites and timeline_events;
- a session with an active incident (activeKey set) is never pruned.

Account deletion is handled by the API itself (DELETE /api/me), at once.
Once this job runs on a schedule, set RETENTION_IN_API=false for the API.

Usage:
    MONGODB_URI=... MONGODB_DB=ytc RETENTION_DAYS=30 python -m pipelines.prune [--dry-run]

Prints one JSON line with what was (or would be) deleted, for monitoring.
Never prints document contents.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol


class Collection(Protocol):
    def find(self, filter: dict[str, Any], projection: dict[str, Any] | None = None) -> Any: ...
    def distinct(self, key: str, filter: dict[str, Any]) -> list[Any]: ...
    def delete_many(self, filter: dict[str, Any]) -> Any: ...
    def count_documents(self, filter: dict[str, Any]) -> int: ...


SESSION_CHILDREN = {
    "checkins": "sessionId",
    "incidents": "sessionId",
    "notification_jobs": "sessionId",
    "contact_invites": "sessionId",
    "timeline_events": "session_id",
}


def expired_session_ids(db: Any, cutoff: datetime) -> list[str]:
    """Sessions finished before the cutoff, minus any with an active incident."""
    busy = set(db["incidents"].distinct("sessionId", {"activeKey": {"$type": "string"}}))
    finished = db["sessions"].find(
        {
            "$or": [
                {"status": "ended", "endedAt": {"$lt": cutoff}},
                {"status": "active", "expiresAt": {"$lt": cutoff}},
            ]
        },
        {"_id": 1},
    )
    return [s["_id"] for s in finished if s["_id"] not in busy]


def prune(db: Any, cutoff: datetime, dry_run: bool = False) -> dict[str, Any]:
    """Deletes (or, with dry_run, counts) everything older than the cutoff. Returns counts."""
    counts: dict[str, int] = {}
    old = {"receivedAt": {"$lt": cutoff}}
    for name in ("traces", "raw_recordings"):
        counts[name] = db[name].count_documents(old) if dry_run else db[name].delete_many(old).deleted_count

    session_ids = expired_session_ids(db, cutoff)
    # Children first, sessions last: a failure part-way leaves nothing orphaned that a rerun can't finish.
    for name, key in SESSION_CHILDREN.items():
        query = {key: {"$in": session_ids}}
        counts[name] = db[name].count_documents(query) if dry_run else db[name].delete_many(query).deleted_count
    query = {"_id": {"$in": session_ids}}
    counts["sessions"] = db["sessions"].count_documents(query) if dry_run else db["sessions"].delete_many(query).deleted_count

    return {"job": "ytc-prune", "dry_run": dry_run, "cutoff": cutoff.isoformat(), "deleted": counts}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Delete YTC data older than RETENTION_DAYS.")
    parser.add_argument("--dry-run", action="store_true", help="count what would be deleted, delete nothing")
    args = parser.parse_args(argv)

    uri = os.environ.get("MONGODB_URI", "").strip()
    if not uri:
        print(json.dumps({"job": "ytc-prune", "ok": False, "error": "MONGODB_URI is not set"}))
        return 2
    days = int(os.environ.get("RETENTION_DAYS", "30") or 30)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    from pymongo import MongoClient  # imported here so tests don't need pymongo

    client = MongoClient(uri, tz_aware=True)
    try:
        result = prune(client[os.environ.get("MONGODB_DB", "ytc")], cutoff, dry_run=args.dry_run)
        print(json.dumps({**result, "ok": True}))
        return 0
    except Exception as err:  # report the failure type only; messages can contain data
        print(json.dumps({"job": "ytc-prune", "ok": False, "error": type(err).__name__}))
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
