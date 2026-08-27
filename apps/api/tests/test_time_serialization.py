from __future__ import annotations

import json
import sqlite3
import unittest

from app.core.time_utils import UtcJSONResponse, normalize_response_timestamps, utc_isoformat
from app.services.agent_runner import public_event


class TimeSerializationTest(unittest.TestCase):
    def test_sqlite_utc_timestamp_becomes_unambiguous_rfc3339(self) -> None:
        self.assertEqual(utc_isoformat("2026-08-27 01:56:07"), "2026-08-27T01:56:07Z")
        self.assertEqual(utc_isoformat("2026-08-27T09:56:07+08:00"), "2026-08-27T01:56:07Z")

    def test_response_normalization_only_changes_timestamp_fields(self) -> None:
        payload = {
            "created_at": "2026-08-27 01:56:07",
            "range_start": "2026-08-27 01:00:00",
            "sync_time": "2026-08-27 02:05:00",
            "details": {
                "last_tested_at": "2026-08-27T09:56:07+08:00",
                "message": "2026-08-27 01:56:07",
            },
            "business_date": "2026-08-27",
        }

        normalized = normalize_response_timestamps(payload)

        self.assertEqual(normalized["created_at"], "2026-08-27T01:56:07Z")
        self.assertEqual(normalized["range_start"], "2026-08-27T01:00:00Z")
        self.assertEqual(normalized["sync_time"], "2026-08-27T02:05:00Z")
        self.assertEqual(normalized["details"]["last_tested_at"], "2026-08-27T01:56:07Z")
        self.assertEqual(normalized["details"]["message"], "2026-08-27 01:56:07")
        self.assertEqual(normalized["business_date"], "2026-08-27")

    def test_default_json_response_applies_contract_to_nested_lists(self) -> None:
        response = UtcJSONResponse({"items": [{"updated_at": "2026-08-27 02:05:00"}]})

        self.assertEqual(
            json.loads(response.body),
            {"items": [{"updated_at": "2026-08-27T02:05:00Z"}]},
        )

    def test_streamed_agent_event_uses_the_same_contract(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT 1 AS id, 8 AS job_id, 1 AS seq, 'info' AS event_type,
                   '正在处理' AS message, NULL AS raw_json,
                   '2026-08-27 01:56:07' AS created_at
            """
        ).fetchone()

        event = public_event(row)

        self.assertEqual(event["created_at"], "2026-08-27T01:56:07Z")
        conn.close()


if __name__ == "__main__":
    unittest.main()
