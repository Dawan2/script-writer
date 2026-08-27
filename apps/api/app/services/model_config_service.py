from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.audit_service import record_audit


MODEL_TYPE_CLAUDE_CODE = "claude_code"
MODEL_TYPE_IMAGE = "image"
MODEL_TYPES = frozenset({MODEL_TYPE_CLAUDE_CODE, MODEL_TYPE_IMAGE})
THINKING_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})
API_PROTOCOLS = frozenset({"anthropic", "openai"})
DEFAULT_IMAGE_REQUEST_URL = "https://ark.cn-beijing.volces.com/api/plan/v3"
DEFAULT_IMAGE_MODEL = "doubao-seedream-5.0-lite"
MANAGED_CLAUDE_SETTING_SOURCES = "project,local"
MODEL_TEST_CLAUDE_TIMEOUT_SECONDS = 90
MODEL_TEST_CLAUDE_PROMPT = "Reply only with: OK"
MODEL_TEST_IMAGE_PROMPT = "A single blue circle on a plain white background. No text."


class ModelConfigurationTestError(Exception):
    """A user-facing failure while exercising a saved model configuration."""

# Keep the catalog in one place: it drives the admin list and the runtime
# resolver, so a displayed configuration always has an execution target.
FUNCTION_MODEL_CATALOG: tuple[dict[str, str], ...] = (
    *(
        {
            "scenario_key": "script_rewrite",
            "scenario_label": "剧本改写",
            "action_key": action_key,
            "action_label": action_label,
            "model_type": MODEL_TYPE_CLAUDE_CODE,
        }
        for action_key, action_label in (
            ("world_view", "世界观构建"),
            ("outline_rewrite", "故事梗概生成"),
            ("character_rewrite", "人物小传生成"),
            ("trial_generate", "剧本试稿生成"),
            ("full_generate", "完整剧本生成"),
            ("dialogue_translate", "台词翻译"),
            ("foreign_review", "海外审稿"),
            ("humanizer_zh", "剧本润色"),
            ("chat_edit", "对话调整"),
            ("document_sync", "文档同步"),
        )
    ),
    *(
        {
            "scenario_key": "novel_adaptation",
            "scenario_label": "小说改编",
            "action_key": action_key,
            "action_label": action_label,
            "model_type": MODEL_TYPE_CLAUDE_CODE,
        }
        for action_key, action_label in (
            ("novel_analysis", "小说解读"),
            ("world_view", "世界观构建"),
            ("outline_rewrite", "故事梗概生成"),
            ("character_rewrite", "人物小传生成"),
            ("trial_generate", "剧本试稿生成"),
            ("full_generate", "完整剧本生成"),
            ("dialogue_translate", "台词翻译"),
            ("foreign_review", "海外审稿"),
            ("humanizer_zh", "剧本润色"),
            ("chat_edit", "对话调整"),
            ("document_sync", "文档同步"),
        )
    ),
    *(
        {
            "scenario_key": "viral_replication",
            "scenario_label": "爆款复刻",
            "action_key": action_key,
            "action_label": action_label,
            "model_type": MODEL_TYPE_CLAUDE_CODE,
        }
        for action_key, action_label in (
            ("world_view", "世界观构建"),
            ("outline_rewrite", "故事梗概生成"),
            ("character_rewrite", "人物小传生成"),
            ("trial_generate", "剧本试稿生成"),
            ("full_generate", "完整剧本生成"),
            ("dialogue_translate", "台词翻译"),
            ("foreign_review", "海外审稿"),
            ("chat_edit", "对话调整"),
            ("document_sync", "文档同步"),
        )
    ),
    {
        "scenario_key": "script_review",
        "scenario_label": "剧本审核",
        "action_key": "foreign_review",
        "action_label": "海外审稿",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "dialogue_translation",
        "scenario_label": "台词翻译",
        "action_key": "dialogue_translate",
        "action_label": "台词翻译",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "script_humanization",
        "scenario_label": "剧本润色",
        "action_key": "humanizer_zh",
        "action_label": "剧本润色",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "agent_evolution",
        "scenario_label": "Agent 进化",
        "action_key": "analysis",
        "action_label": "进化分析",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "agent_evolution",
        "scenario_label": "Agent 进化",
        "action_key": "execution",
        "action_label": "优化执行",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "writer_preferences",
        "scenario_label": "创作偏好",
        "action_key": "summary",
        "action_label": "偏好整理",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "script_library",
        "scenario_label": "剧本蒸馏",
        "action_key": "distill",
        "action_label": "剧本蒸馏",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "script_library",
        "scenario_label": "剧本蒸馏",
        "action_key": "formula_curation",
        "action_label": "公式与原则整理",
        "model_type": MODEL_TYPE_CLAUDE_CODE,
    },
    {
        "scenario_key": "script_sync",
        "scenario_label": "剧本同步",
        "action_key": "cover_image",
        "action_label": "封面图生成",
        "model_type": MODEL_TYPE_IMAGE,
    },
)

CATALOG_BY_KEY = {
    (item["scenario_key"], item["action_key"]): item
    for item in FUNCTION_MODEL_CATALOG
}


def _row_value(row: sqlite3.Row | dict[str, Any], key: str, default: Any = None) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key] if key in row.keys() else default
    return row.get(key, default)


def _parse_snapshot(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        payload = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _model_route_key(scenario_key: str, action_key: str) -> str:
    return f"{scenario_key}:{action_key}"


def _model_type_default_values(model_type: str) -> dict[str, Any]:
    if model_type == MODEL_TYPE_IMAGE:
        return {
            "name": "封面生图默认模型",
            "request_url": os.getenv("ORCA_COVER_IMAGE_BASE_URL", "").strip() or DEFAULT_IMAGE_REQUEST_URL,
            "api_key": os.getenv("AGENT_API_KEY", "").strip(),
            "model_name": os.getenv("ORCA_COVER_IMAGE_MODEL", "").strip() or DEFAULT_IMAGE_MODEL,
            "api_protocol": "openai",
            "thinking_level": "medium",
            "image_size": os.getenv("ORCA_COVER_IMAGE_SIZE", "").strip() or "2K",
            "image_output_format": os.getenv("ORCA_COVER_IMAGE_OUTPUT_FORMAT", "").strip() or "png",
            "image_watermark": False,
        }
    return {
        "name": "Claude Code 默认模型",
        "request_url": os.getenv("ANTHROPIC_BASE_URL", "").strip(),
        "api_key": (os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip() or os.getenv("ANTHROPIC_API_KEY", "").strip()),
        "model_name": os.getenv("ANTHROPIC_MODEL", "").strip(),
        "api_protocol": "anthropic",
        "thinking_level": "medium",
        "image_size": "",
        "image_output_format": "png",
        "image_watermark": False,
    }


def ensure_model_configuration_defaults(conn: sqlite3.Connection) -> None:
    """Seed one compatible model per runtime type and route every catalog item."""
    default_ids: dict[str, int] = {}
    for model_type in (MODEL_TYPE_CLAUDE_CODE, MODEL_TYPE_IMAGE):
        row = conn.execute(
            "SELECT id FROM ai_model_configs WHERE model_type = ? ORDER BY id LIMIT 1",
            (model_type,),
        ).fetchone()
        if row:
            default_ids[model_type] = int(row["id"])
            continue
        values = _model_type_default_values(model_type)
        cursor = conn.execute(
            """
            INSERT INTO ai_model_configs (
                name, model_type, request_url, api_key, model_name, api_protocol, thinking_level,
                image_size, image_output_format, image_watermark, is_enabled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                values["name"],
                model_type,
                values["request_url"],
                values["api_key"],
                values["model_name"],
                values["api_protocol"],
                values["thinking_level"],
                values["image_size"],
                values["image_output_format"],
                int(values["image_watermark"]),
            ),
        )
        default_ids[model_type] = int(cursor.lastrowid)

    for item in FUNCTION_MODEL_CATALOG:
        existing = conn.execute(
            """
            SELECT 1 FROM ai_function_model_routes
            WHERE scenario_key = ? AND action_key = ?
            """,
            (item["scenario_key"], item["action_key"]),
        ).fetchone()
        if existing:
            continue
        conn.execute(
            """
            INSERT INTO ai_function_model_routes (
                scenario_key, action_key, model_type, model_config_id
            ) VALUES (?, ?, ?, ?)
            """,
            (
                item["scenario_key"],
                item["action_key"],
                item["model_type"],
                default_ids[item["model_type"]],
            ),
        )

    # `mechanism_curation` was the former name of the shared formula/principle
    # cataloging route. Move its saved model choice once, then remove the
    # hidden legacy route so later edits to `formula_curation` stay authoritative.
    legacy = conn.execute(
        """
        SELECT model_type, model_config_id
        FROM ai_function_model_routes
        WHERE scenario_key='script_library' AND action_key='mechanism_curation'
        """
    ).fetchone()
    if legacy and str(legacy["model_type"]) == MODEL_TYPE_CLAUDE_CODE:
        conn.execute(
            """
            UPDATE ai_function_model_routes
            SET model_config_id=?, updated_by=NULL, updated_at=CURRENT_TIMESTAMP
            WHERE scenario_key='script_library' AND action_key='formula_curation'
            """,
            (int(legacy["model_config_id"]),),
        )
        conn.execute(
            "DELETE FROM ai_function_model_routes WHERE scenario_key='script_library' AND action_key='mechanism_curation'"
        )


def _require_catalog_item(scenario_key: str, action_key: str) -> dict[str, str]:
    item = CATALOG_BY_KEY.get((scenario_key, action_key))
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="功能动作不存在")
    return item


def _public_model_config(row: sqlite3.Row, fallback_names: dict[int, str]) -> dict[str, Any]:
    fallback_id = _row_value(row, "fallback_model_id")
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "model_type": str(row["model_type"]),
        "request_url": str(row["request_url"] or ""),
        "model_name": str(row["model_name"] or ""),
        "api_protocol": str(_row_value(row, "api_protocol", "anthropic") or "anthropic"),
        "thinking_level": str(row["thinking_level"] or "medium"),
        "image_size": str(row["image_size"] or ""),
        "image_output_format": str(row["image_output_format"] or "png"),
        "image_watermark": bool(row["image_watermark"]),
        "fallback_model_id": int(fallback_id) if fallback_id is not None else None,
        "fallback_model_name": fallback_names.get(int(fallback_id)) if fallback_id is not None else None,
        "api_key_configured": bool(str(row["api_key"] or "").strip()),
        "is_enabled": bool(row["is_enabled"]),
        "last_tested_at": _row_value(row, "last_tested_at"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _list_model_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM ai_model_configs ORDER BY model_type, id").fetchall()


def list_model_management(conn: sqlite3.Connection) -> dict[str, Any]:
    ensure_model_configuration_defaults(conn)
    model_rows = _list_model_rows(conn)
    model_names = {int(row["id"]): str(row["name"]) for row in model_rows}
    models = [_public_model_config(row, model_names) for row in model_rows]
    route_rows = conn.execute(
        """
        SELECT route.*, model.name AS model_config_name, model.model_name AS configured_model_name
        FROM ai_function_model_routes AS route
        LEFT JOIN ai_model_configs AS model ON model.id = route.model_config_id
        ORDER BY route.scenario_key, route.action_key
        """
    ).fetchall()
    route_rows_by_key = {
        (str(row["scenario_key"]), str(row["action_key"])): row
        for row in route_rows
    }
    routes = []
    for item in FUNCTION_MODEL_CATALOG:
        row = route_rows_by_key.get((item["scenario_key"], item["action_key"]))
        model_config_id = int(row["model_config_id"]) if row and row["model_config_id"] is not None else None
        routes.append({
            **item,
            "model_config_id": model_config_id,
            "model_config_name": str(row["model_config_name"] or "") if row else "",
            "configured_model_name": str(row["configured_model_name"] or "") if row else "",
            "updated_at": row["updated_at"] if row else None,
        })
    return {"models": models, "routes": routes}


def _normalize_request_url(value: Any) -> str:
    normalized = str(value or "").strip().rstrip("/")
    if not normalized:
        return ""
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请求地址应为有效的 HTTP 或 HTTPS 地址")
    return normalized


def _normalize_model_payload(
    payload: dict[str, Any],
    *,
    existing: sqlite3.Row | None = None,
) -> dict[str, Any]:
    def value(name: str, fallback: Any = "") -> Any:
        if name in payload:
            return payload[name]
        return _row_value(existing, name, fallback) if existing is not None else fallback

    model_type = str(value("model_type") or "").strip()
    if model_type not in MODEL_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="模型类型无效")
    name = str(value("name") or "").strip()
    if not name or len(name) > 80:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="配置名称为必填项，且不能超过 80 个字符")
    model_name = str(value("model_name") or "").strip()
    if len(model_name) > 200:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="模型名称不能超过 200 个字符")
    thinking_level = str(value("thinking_level", "medium") or "medium").strip().lower()
    if thinking_level not in THINKING_LEVELS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="思考强度无效")
    api_protocol = str(value("api_protocol", "anthropic") or "anthropic").strip().lower()
    if api_protocol not in API_PROTOCOLS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="调用协议无效")
    image_size = str(value("image_size") or "").strip()
    image_output_format = str(value("image_output_format", "png") or "png").strip().lower()
    if image_output_format not in {"png", "jpeg", "webp"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="图片格式仅支持 PNG、JPEG 或 WebP")
    if model_type == MODEL_TYPE_IMAGE and (not model_name or not image_size):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="生图模型需要填写模型名称和图片尺寸")
    return {
        "name": name,
        "model_type": model_type,
        "request_url": _normalize_request_url(value("request_url")),
        "model_name": model_name,
        "api_protocol": api_protocol,
        "thinking_level": thinking_level,
        "image_size": image_size,
        "image_output_format": image_output_format,
        "image_watermark": bool(value("image_watermark", False)),
        "fallback_model_id": value("fallback_model_id", None),
        "is_enabled": bool(value("is_enabled", True)),
    }


def _require_model(conn: sqlite3.Connection, model_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM ai_model_configs WHERE id = ?", (model_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="模型配置不存在")
    return row


def _model_reference_counts(conn: sqlite3.Connection, model_id: int) -> tuple[int, int]:
    route_count = int(conn.execute(
        "SELECT COUNT(*) FROM ai_function_model_routes WHERE model_config_id = ?", (model_id,)
    ).fetchone()[0])
    fallback_count = int(conn.execute(
        "SELECT COUNT(*) FROM ai_model_configs WHERE fallback_model_id = ?", (model_id,)
    ).fetchone()[0])
    return route_count, fallback_count


def _validate_fallback_model(
    conn: sqlite3.Connection,
    *,
    model_id: int | None,
    model_type: str,
    fallback_model_id: Any,
) -> int | None:
    if fallback_model_id in {None, ""}:
        return None
    try:
        fallback_id = int(fallback_model_id)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="兜底模型无效") from exc
    if model_id is not None and fallback_id == model_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="兜底模型不能选择自身")
    fallback = _require_model(conn, fallback_id)
    if fallback["model_type"] != model_type:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="兜底模型需与当前模型类型一致")
    if not fallback["is_enabled"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="兜底模型当前不可用")
    return fallback_id


def create_model_config(conn: sqlite3.Connection, *, actor: sqlite3.Row, payload: dict[str, Any]) -> dict[str, Any]:
    ensure_model_configuration_defaults(conn)
    normalized = _normalize_model_payload(payload)
    fallback_id = _validate_fallback_model(
        conn,
        model_id=None,
        model_type=normalized["model_type"],
        fallback_model_id=normalized["fallback_model_id"],
    )
    api_key = str(payload.get("api_key") or "").strip()
    cursor = conn.execute(
        """
        INSERT INTO ai_model_configs (
            name, model_type, request_url, api_key, model_name, api_protocol, thinking_level,
            image_size, image_output_format, image_watermark, fallback_model_id, is_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            normalized["name"], normalized["model_type"], normalized["request_url"], api_key,
            normalized["model_name"], normalized["api_protocol"], normalized["thinking_level"], normalized["image_size"],
            normalized["image_output_format"], int(normalized["image_watermark"]), fallback_id,
            int(normalized["is_enabled"]),
        ),
    )
    model_id = int(cursor.lastrowid)
    record_audit(
        conn,
        actor=actor,
        action="model_config.create",
        target_type="model_config",
        target_id=model_id,
        target_label=normalized["name"],
        details={
            "model_type": normalized["model_type"],
            "model_name": normalized["model_name"],
            "api_key_configured": bool(api_key),
        },
    )
    return _public_model_config(_require_model(conn, model_id), {
        int(row["id"]): str(row["name"]) for row in _list_model_rows(conn)
    })


def update_model_config(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    model_id: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    ensure_model_configuration_defaults(conn)
    existing = _require_model(conn, model_id)
    if "model_type" in payload and str(payload["model_type"]) != str(existing["model_type"]):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="创建后不能变更模型类型")
    normalized = _normalize_model_payload(payload, existing=existing)
    fallback_id = _validate_fallback_model(
        conn,
        model_id=model_id,
        model_type=normalized["model_type"],
        fallback_model_id=normalized["fallback_model_id"],
    )
    if existing["is_enabled"] and not normalized["is_enabled"]:
        route_count, fallback_count = _model_reference_counts(conn, model_id)
        if route_count or fallback_count:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="该模型仍被功能配置或其他模型作为兜底使用，调整关联后再停用",
            )
    api_key = str(existing["api_key"] or "")
    if "api_key" in payload:
        api_key = str(payload["api_key"] or "").strip()
    test_target_changed = any(
        normalized[field] != _row_value(existing, field)
        for field in (
            "request_url",
            "model_name",
            "api_protocol",
            "thinking_level",
            "image_size",
            "image_output_format",
            "image_watermark",
        )
    ) or ("api_key" in payload and api_key != str(existing["api_key"] or ""))
    last_tested_at = None if test_target_changed else _row_value(existing, "last_tested_at")
    conn.execute(
        """
        UPDATE ai_model_configs
        SET name = ?, request_url = ?, api_key = ?, model_name = ?, api_protocol = ?, thinking_level = ?,
            image_size = ?, image_output_format = ?, image_watermark = ?, fallback_model_id = ?,
            is_enabled = ?, last_tested_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            normalized["name"], normalized["request_url"], api_key, normalized["model_name"],
            normalized["api_protocol"], normalized["thinking_level"], normalized["image_size"], normalized["image_output_format"],
            int(normalized["image_watermark"]), fallback_id, int(normalized["is_enabled"]), last_tested_at, model_id,
        ),
    )
    record_audit(
        conn,
        actor=actor,
        action="model_config.update",
        target_type="model_config",
        target_id=model_id,
        target_label=normalized["name"],
        details={
            "model_type": normalized["model_type"],
            "model_name": normalized["model_name"],
            "api_key_updated": "api_key" in payload,
            "api_key_configured": bool(api_key),
            "fallback_model_id": fallback_id,
        },
    )
    return _public_model_config(_require_model(conn, model_id), {
        int(row["id"]): str(row["name"]) for row in _list_model_rows(conn)
    })


def delete_model_config(conn: sqlite3.Connection, *, actor: sqlite3.Row, model_id: int) -> None:
    ensure_model_configuration_defaults(conn)
    model = _require_model(conn, model_id)
    route_count, fallback_count = _model_reference_counts(conn, model_id)
    if route_count or fallback_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该模型仍被功能配置或其他模型作为兜底使用，调整关联后再删除",
        )
    conn.execute("DELETE FROM ai_model_configs WHERE id = ?", (model_id,))
    record_audit(
        conn,
        actor=actor,
        action="model_config.delete",
        target_type="model_config",
        target_id=model_id,
        target_label=model["name"],
        severity="warning",
        details={"model_type": model["model_type"], "model_name": model["model_name"]},
    )


def update_function_model_route(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    scenario_key: str,
    action_key: str,
    model_config_id: int,
) -> dict[str, Any]:
    ensure_model_configuration_defaults(conn)
    catalog_item = _require_catalog_item(scenario_key, action_key)
    model = _require_model(conn, model_config_id)
    if model["model_type"] != catalog_item["model_type"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="所选模型与该动作类型不匹配")
    if not model["is_enabled"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请先启用所选模型")
    previous = conn.execute(
        """
        SELECT model_config_id FROM ai_function_model_routes
        WHERE scenario_key = ? AND action_key = ?
        """,
        (scenario_key, action_key),
    ).fetchone()
    conn.execute(
        """
        INSERT INTO ai_function_model_routes (
            scenario_key, action_key, model_type, model_config_id, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(scenario_key, action_key) DO UPDATE SET
            model_type = excluded.model_type,
            model_config_id = excluded.model_config_id,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        """,
        (scenario_key, action_key, catalog_item["model_type"], model_config_id, actor["id"]),
    )
    record_audit(
        conn,
        actor=actor,
        action="model_route.update",
        target_type="function_model_route",
        target_id=_model_route_key(scenario_key, action_key),
        target_label=f"{catalog_item['scenario_label']} / {catalog_item['action_label']}",
        details={
            "previous_model_config_id": int(previous["model_config_id"]) if previous else None,
            "model_config_id": model_config_id,
            "model_config_name": model["name"],
        },
    )
    return {
        **catalog_item,
        "model_config_id": model_config_id,
        "model_config_name": str(model["name"]),
        "configured_model_name": str(model["model_name"] or ""),
        "updated_at": conn.execute(
            "SELECT updated_at FROM ai_function_model_routes WHERE scenario_key = ? AND action_key = ?",
            (scenario_key, action_key),
        ).fetchone()["updated_at"],
    }


def update_function_model_routes(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    route_keys: list[dict[str, Any]],
    model_config_id: int,
) -> dict[str, Any]:
    """Apply one compatible model to multiple function routes atomically."""
    ensure_model_configuration_defaults(conn)
    if not route_keys:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请至少选择一个功能动作")
    model = _require_model(conn, model_config_id)
    if not model["is_enabled"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="请先启用所选模型")

    catalog_items: list[dict[str, str]] = []
    seen_keys: set[tuple[str, str]] = set()
    for route_key in route_keys:
        scenario_key = str(route_key.get("scenario_key") or "")
        action_key = str(route_key.get("action_key") or "")
        key = (scenario_key, action_key)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        catalog_item = _require_catalog_item(scenario_key, action_key)
        if model["model_type"] != catalog_item["model_type"]:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="所选模型与部分动作类型不匹配")
        catalog_items.append(catalog_item)

    previous_by_key = {
        (str(row["scenario_key"]), str(row["action_key"])): int(row["model_config_id"])
        for row in conn.execute(
            "SELECT scenario_key, action_key, model_config_id FROM ai_function_model_routes"
        ).fetchall()
    }
    changed_items = [
        item
        for item in catalog_items
        if previous_by_key.get((item["scenario_key"], item["action_key"])) != model_config_id
    ]
    if changed_items:
        conn.executemany(
            """
            INSERT INTO ai_function_model_routes (
                scenario_key, action_key, model_type, model_config_id, updated_by, updated_at
            ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(scenario_key, action_key) DO UPDATE SET
                model_type = excluded.model_type,
                model_config_id = excluded.model_config_id,
                updated_by = excluded.updated_by,
                updated_at = CURRENT_TIMESTAMP
            """,
            [
                (
                    item["scenario_key"], item["action_key"], item["model_type"], model_config_id, actor["id"],
                )
                for item in changed_items
            ],
        )
        record_audit(
            conn,
            actor=actor,
            action="model_route.bulk_update",
            target_type="function_model_routes",
            target_id=str(model_config_id),
            target_label=f"{len(changed_items)} 个功能动作",
            details={
                "model_config_id": model_config_id,
                "model_config_name": model["name"],
                "route_keys": [
                    _model_route_key(item["scenario_key"], item["action_key"])
                    for item in changed_items
                ],
                "previous_model_config_ids": [
                    previous_by_key.get((item["scenario_key"], item["action_key"]))
                    for item in changed_items
                ],
            },
        )

    persisted_rows = {
        (str(row["scenario_key"]), str(row["action_key"])): row
        for row in conn.execute(
            "SELECT scenario_key, action_key, updated_at FROM ai_function_model_routes"
        ).fetchall()
    }
    return {
        "updated_count": len(changed_items),
        "routes": [
            {
                **item,
                "model_config_id": model_config_id,
                "model_config_name": str(model["name"]),
                "configured_model_name": str(model["model_name"] or ""),
                "updated_at": persisted_rows[(item["scenario_key"], item["action_key"])]["updated_at"],
            }
            for item in catalog_items
        ],
    }


def _runtime_model(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    *,
    include_fallback: bool = True,
    seen: set[int] | None = None,
) -> dict[str, Any]:
    seen = set(seen or ())
    model_id = int(row["id"])
    if model_id in seen:
        return {}
    seen.add(model_id)
    runtime = {
        "id": model_id,
        "name": str(row["name"]),
        "model_type": str(row["model_type"]),
        "request_url": str(row["request_url"] or ""),
        "api_key": str(row["api_key"] or ""),
        "model_name": str(row["model_name"] or ""),
        "api_protocol": str(_row_value(row, "api_protocol", "anthropic") or "anthropic"),
        "thinking_level": str(row["thinking_level"] or "medium"),
        "image_size": str(row["image_size"] or ""),
        "image_output_format": str(row["image_output_format"] or "png"),
        "image_watermark": bool(row["image_watermark"]),
    }
    if include_fallback and row["fallback_model_id"] is not None:
        runtime["fallback_model_id"] = int(row["fallback_model_id"])
        fallback = conn.execute(
            """
            SELECT * FROM ai_model_configs
            WHERE id = ? AND model_type = ? AND is_enabled = 1
            """,
            (int(row["fallback_model_id"]), runtime["model_type"]),
        ).fetchone()
        if fallback:
            runtime["fallback"] = _runtime_model(
                conn,
                fallback,
                include_fallback=True,
                seen=seen,
            )
    return runtime


def resolve_runtime_model(
    conn: sqlite3.Connection,
    *,
    scenario_key: str,
    action_key: str,
    model_type: str | None = None,
) -> dict[str, Any]:
    ensure_model_configuration_defaults(conn)
    catalog_item = _require_catalog_item(scenario_key, action_key)
    if model_type and catalog_item["model_type"] != model_type:
        raise RuntimeError("模型类型与功能路由不一致")
    route = conn.execute(
        """
        SELECT model.*
        FROM ai_function_model_routes AS route
        JOIN ai_model_configs AS model ON model.id = route.model_config_id
        WHERE route.scenario_key = ? AND route.action_key = ?
        """,
        (scenario_key, action_key),
    ).fetchone()
    if not route or not route["is_enabled"]:
        raise RuntimeError("当前功能尚未配置可用模型")
    runtime = _runtime_model(conn, route)
    return runtime


def _capture_routes(conn: sqlite3.Connection, items: Iterable[dict[str, str]]) -> dict[str, Any]:
    routes: dict[str, Any] = {}
    for item in items:
        routes[_model_route_key(item["scenario_key"], item["action_key"])] = resolve_runtime_model(
            conn,
            scenario_key=item["scenario_key"],
            action_key=item["action_key"],
            model_type=item["model_type"],
        )
    return {"schema_version": 1, "routes": routes}


def _agent_scenario(project: sqlite3.Row) -> str:
    return {
        "novel": "novel_adaptation",
        "replicate": "viral_replication",
        "review": "script_review",
        "translate": "dialogue_translation",
        "humanize": "script_humanization",
    }.get(str(project["task_type"] or ""), "script_rewrite")


def ensure_agent_model_snapshot(
    conn: sqlite3.Connection,
    *,
    job: sqlite3.Row,
    project: sqlite3.Row,
) -> sqlite3.Row:
    if "model_config_snapshot_json" not in job.keys() or str(job["model_config_snapshot_json"] or "").strip():
        return job
    scenario_key = _agent_scenario(project)
    snapshot = _capture_routes(
        conn,
        (item for item in FUNCTION_MODEL_CATALOG if item["scenario_key"] == scenario_key),
    )
    snapshot["scenario_key"] = scenario_key
    conn.execute(
        """
        UPDATE agent_jobs
        SET model_config_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (model_config_snapshot_json IS NULL OR TRIM(model_config_snapshot_json) = '')
        """,
        (json.dumps(snapshot, ensure_ascii=False), job["id"]),
    )
    return conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job["id"],)).fetchone()


def capture_model_snapshot(
    conn: sqlite3.Connection,
    *,
    route_keys: Iterable[tuple[str, str]],
) -> dict[str, Any]:
    items = [_require_catalog_item(scenario_key, action_key) for scenario_key, action_key in route_keys]
    return _capture_routes(conn, items)


def ensure_persisted_model_snapshot(
    conn: sqlite3.Connection,
    *,
    table_name: str,
    row: sqlite3.Row,
    route_keys: Iterable[tuple[str, str]],
) -> sqlite3.Row:
    """Freeze a background task's route selections exactly once when it starts."""
    if table_name not in {
        "preference_summary_jobs",
        "system_agent_evolution_runs",
        "script_sync_jobs",
        "script_distillation_jobs",
    }:
        raise ValueError("unsupported model snapshot table")
    if "model_config_snapshot_json" not in row.keys() or str(row["model_config_snapshot_json"] or "").strip():
        return row
    snapshot = capture_model_snapshot(conn, route_keys=route_keys)
    conn.execute(
        f"""
        UPDATE {table_name}
        SET model_config_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (model_config_snapshot_json IS NULL OR TRIM(model_config_snapshot_json) = '')
        """,
        (json.dumps(snapshot, ensure_ascii=False), row["id"]),
    )
    return conn.execute(f"SELECT * FROM {table_name} WHERE id = ?", (row["id"],)).fetchone()


def runtime_from_snapshot(
    snapshot: dict[str, Any] | str | None,
    *,
    scenario_key: str,
    action_key: str,
) -> dict[str, Any] | None:
    parsed = _parse_snapshot(snapshot) if isinstance(snapshot, str) or snapshot is None else snapshot
    routes = parsed.get("routes") if isinstance(parsed, dict) else None
    runtime = routes.get(_model_route_key(scenario_key, action_key)) if isinstance(routes, dict) else None
    return runtime if isinstance(runtime, dict) else None


def agent_runtime_model(job: sqlite3.Row | dict[str, Any], action_key: str) -> dict[str, Any] | None:
    aliases = {"localization": "dialogue_translate", "quality_repair": str(_row_value(job, "target_stage") or _row_value(job, "stage") or "")}
    action = aliases.get(action_key, action_key)
    snapshot = _row_value(job, "model_config_snapshot_json")
    parsed = _parse_snapshot(snapshot)
    scenario_key = str(parsed.get("scenario_key") or "")
    if not scenario_key:
        return None
    return runtime_from_snapshot(parsed, scenario_key=scenario_key, action_key=action)


def fallback_runtime(runtime: dict[str, Any] | None) -> dict[str, Any] | None:
    fallback = runtime.get("fallback") if isinstance(runtime, dict) else None
    return fallback if isinstance(fallback, dict) else None


def _uses_managed_claude_provider(runtime: dict[str, Any] | None) -> bool:
    if not isinstance(runtime, dict) or runtime.get("model_type") != MODEL_TYPE_CLAUDE_CODE:
        return False
    return bool(str(runtime.get("request_url") or "").strip() or str(runtime.get("api_key") or "").strip())


def claude_command_options(runtime: dict[str, Any] | None) -> list[str]:
    if not runtime or runtime.get("model_type") != MODEL_TYPE_CLAUDE_CODE:
        return []
    options: list[str] = []
    if _uses_managed_claude_provider(runtime):
        # cc switch writes provider variables into the user-level settings file.
        # A backend-managed endpoint or key must take precedence while retaining
        # this project's own settings and skills.
        options.extend(["--setting-sources", MANAGED_CLAUDE_SETTING_SOURCES])
    model_name = str(runtime.get("model_name") or "").strip()
    if model_name:
        options.extend(["--model", model_name])
    thinking_level = str(runtime.get("thinking_level") or "").strip().lower()
    if thinking_level in THINKING_LEVELS:
        options.extend(["--effort", thinking_level])
    return options


def claude_environment(runtime: dict[str, Any] | None) -> dict[str, str]:
    if not runtime or runtime.get("model_type") != MODEL_TYPE_CLAUDE_CODE:
        return {}
    environment: dict[str, str] = {}
    request_url = str(runtime.get("request_url") or "").strip()
    api_key = str(runtime.get("api_key") or "").strip()
    if request_url:
        environment["ANTHROPIC_BASE_URL"] = request_url
    if api_key:
        # Different Claude Code providers read one of these names. Supplying
        # both keeps a configured proxy and Anthropic's native key path aligned.
        environment["ANTHROPIC_AUTH_TOKEN"] = api_key
        environment["ANTHROPIC_API_KEY"] = api_key
    return environment


def claude_process_environment(runtime: dict[str, Any] | None) -> dict[str, str]:
    """Build an authoritative environment for a backend-managed Claude provider."""
    environment = dict(os.environ)
    if _uses_managed_claude_provider(runtime):
        for key in tuple(environment):
            if key.startswith("ANTHROPIC_") or key in {
                "CLAUDE_CODE_EFFORT_LEVEL",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            }:
                environment.pop(key, None)
    environment.update(claude_environment(runtime))
    return environment


def _claude_test_executable() -> str:
    configured = os.getenv("ORCA_CLAUDE_PATH", "").strip()
    if configured:
        return configured
    bundled = settings.repo_root / "node_modules" / ".bin" / "claude"
    return str(bundled) if bundled.is_file() else ""


def _claude_test_terminal_result(stdout: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict) and (payload.get("type") == "result" or "result" in payload):
        return payload

    for line in reversed(stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("type") == "result":
            return candidate
    return None


def _test_claude_model(runtime: dict[str, Any]) -> dict[str, Any]:
    executable = _claude_test_executable()
    if not executable:
        raise ModelConfigurationTestError("未找到 Claude Code 客户端，暂时无法发起测试。")

    command = [
        executable,
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--tools", "",
        "--strict-mcp-config",
        "--permission-mode", "dontAsk",
        *claude_command_options(runtime),
        MODEL_TEST_CLAUDE_PROMPT,
    ]
    try:
        result = subprocess.run(
            command,
            cwd=settings.agents_dir,
            env=claude_process_environment(runtime),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=MODEL_TEST_CLAUDE_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ModelConfigurationTestError("Claude Code 测试超时，请检查模型服务状态后重试。") from exc
    except OSError as exc:
        raise ModelConfigurationTestError("Claude Code 未能启动，请检查服务部署和模型配置。") from exc

    if result.returncode != 0:
        raise ModelConfigurationTestError("Claude Code 测试失败，请检查请求地址、API Key、模型名称和服务状态。")
    payload = _claude_test_terminal_result(str(result.stdout or ""))
    if payload is not None and payload.get("is_error"):
        raise ModelConfigurationTestError("Claude Code 测试失败，请检查请求地址、API Key、模型名称和服务状态。")
    return {
        "message": "Claude Code 已完成测试请求。",
        "image_url": None,
    }


def _test_image_model(runtime: dict[str, Any]) -> dict[str, Any]:
    # Import lazily: script synchronization already imports this module for
    # its runtime resolver, while this admin-only path reuses its real request.
    from app.services.script_sync_service import request_image_generation

    try:
        image_url = request_image_generation(
            MODEL_TEST_IMAGE_PROMPT,
            runtime,
            allow_fallback=False,
        )
    except Exception as exc:
        raise ModelConfigurationTestError("生图测试失败，请检查请求地址、API Key、模型名称和服务状态。") from exc
    parsed = urlparse(image_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ModelConfigurationTestError("生图服务未返回有效图片，请检查模型配置后重试。")
    return {
        "message": "已生成一张测试图片。",
        "image_url": image_url,
    }


def test_model_config(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    model_id: int,
) -> dict[str, Any]:
    """Exercise one saved model without creating a task or using its fallback."""
    ensure_model_configuration_defaults(conn)
    model = _require_model(conn, model_id)
    runtime = _runtime_model(conn, model, include_fallback=False)
    test_kind = "claude_code_prompt" if runtime["model_type"] == MODEL_TYPE_CLAUDE_CODE else "image_generation"
    try:
        result = _test_claude_model(runtime) if runtime["model_type"] == MODEL_TYPE_CLAUDE_CODE else _test_image_model(runtime)
    except ModelConfigurationTestError as exc:
        record_audit(
            conn,
            actor=actor,
            action="model_config.test",
            target_type="model_config",
            target_id=model_id,
            target_label=str(model["name"]),
            outcome="failure",
            severity="warning",
            details={"model_type": runtime["model_type"], "test_kind": test_kind},
        )
        # The dependency commits only successful requests; preserve the failed
        # test audit before returning an HTTP error to the administrator.
        conn.commit()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    conn.execute(
        "UPDATE ai_model_configs SET last_tested_at = CURRENT_TIMESTAMP WHERE id = ?",
        (model_id,),
    )
    tested_at = _require_model(conn, model_id)["last_tested_at"]
    record_audit(
        conn,
        actor=actor,
        action="model_config.test",
        target_type="model_config",
        target_id=model_id,
        target_label=str(model["name"]),
        details={"model_type": runtime["model_type"], "test_kind": test_kind},
    )
    return {
        "model_id": model_id,
        "model_type": runtime["model_type"],
        "last_tested_at": tested_at,
        **result,
    }
