from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from starlette.responses import JSONResponse


_DATETIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$"
)
_EXPLICIT_TIME_FIELDS = frozenset({"timestamp", "range_start", "range_end"})


def utc_isoformat(value: object) -> str | None:
    """Return an API timestamp as RFC 3339 UTC; naive values are SQLite UTC."""
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        raw = value.strip()
        if not raw or not _DATETIME_PATTERN.fullmatch(raw):
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.isoformat(timespec="auto").replace("+00:00", "Z")


def _is_time_field(key: object) -> bool:
    if not isinstance(key, str):
        return False
    return (
        key.endswith("_at")
        or key.endswith("_time")
        or key.endswith("At")
        or key in _EXPLICIT_TIME_FIELDS
    )


def normalize_response_timestamps(value: Any, *, field_name: str | None = None) -> Any:
    """Normalize timestamp fields without guessing at timestamps inside user text."""
    if isinstance(value, dict):
        return {
            key: normalize_response_timestamps(item, field_name=key)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [normalize_response_timestamps(item, field_name=field_name) for item in value]
    if field_name and _is_time_field(field_name):
        normalized = utc_isoformat(value)
        if normalized is not None:
            return normalized
    return value


class UtcJSONResponse(JSONResponse):
    """JSON response enforcing the API's UTC timestamp contract."""

    def render(self, content: Any) -> bytes:
        return super().render(normalize_response_timestamps(content))
