from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path
from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.config import settings
from app.services.audit_service import record_audit


LANGUAGE_CODE_PATTERN = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def _normalize_text_list(values: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("规则和别名不能包含空白内容")
        cleaned = value.strip()
        if cleaned not in normalized:
            normalized.append(cleaned)
    return normalized


class RegionStageOverride(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rules: list[str] = Field(default_factory=list)

    @field_validator("rules")
    @classmethod
    def normalize_rules(cls, values: list[str]) -> list[str]:
        return _normalize_text_list(values)


class RegionRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    aliases: list[str] = Field(default_factory=list)
    default_market: str
    default_locale: str
    rules: list[str] = Field(default_factory=list)
    stage_overrides: dict[str, RegionStageOverride] = Field(default_factory=dict)
    translation_context: list[str] = Field(default_factory=list)
    requires_translation: bool = True

    @field_validator("aliases", "rules", "translation_context")
    @classmethod
    def normalize_text_list(cls, values: list[str]) -> list[str]:
        return _normalize_text_list(values)

    @field_validator("stage_overrides")
    @classmethod
    def normalize_stage_overrides(
        cls,
        values: dict[str, RegionStageOverride],
    ) -> dict[str, RegionStageOverride]:
        normalized: dict[str, RegionStageOverride] = {}
        for key, value in values.items():
            stage = key.strip()
            if not stage or len(stage) > 80:
                raise ValueError("阶段名称为必填项且不能超过 80 个字符")
            if stage in normalized:
                raise ValueError(f"阶段名称重复：{stage}")
            normalized[stage] = value
        return normalized

    @field_validator("default_locale")
    @classmethod
    def validate_default_locale(cls, value: str) -> str:
        locale = value.strip()
        if not LANGUAGE_CODE_PATTERN.fullmatch(locale):
            raise ValueError("默认语言区域代码无效")
        return locale

    @field_validator("default_market")
    @classmethod
    def validate_default_market(cls, value: str) -> str:
        market = value.strip()
        if not market or len(market) > 80:
            raise ValueError("默认目标市场为必填项且不能超过 80 个字符")
        return market


class RegionRulesConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = "1.2.0"
    regions: dict[str, RegionRule]

    @model_validator(mode="after")
    def validate_rules(self) -> "RegionRulesConfig":
        if not self.regions:
            raise ValueError("至少需要保留一个地区")
        for key, rule in self.regions.items():
            if not key.strip() or len(key.strip()) > 40:
                raise ValueError("地区名称为必填项且不能超过 40 个字符")
            if not rule.default_market or not rule.default_locale:
                raise ValueError(f"地区「{key}」缺少默认目标市场或语言区域代码")
        return self


def region_rules_path() -> Path:
    return settings.agents_dir / ".claude/config/region-rules.json"


def _hash_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def load_region_config() -> tuple[RegionRulesConfig, str]:
    path = region_rules_path()
    try:
        raw = path.read_bytes()
        payload = json.loads(raw)
        config = RegionRulesConfig.model_validate(payload)
    except OSError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="地区规则文件不可读取") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"地区规则文件无效：{exc}") from exc
    return config, _hash_bytes(raw)


def public_region_config(conn: sqlite3.Connection) -> dict:
    config, digest = load_region_config()
    usage_rows = conn.execute(
        """
        SELECT target_region, COUNT(*) AS project_count
        FROM projects
        WHERE target_region IS NOT NULL
        GROUP BY target_region
        """
    ).fetchall()
    usage = {row["target_region"]: row["project_count"] for row in usage_rows}
    return {
        "config": config.model_dump(exclude_none=True),
        "content_hash": digest,
        "usage": usage,
    }


def save_region_config(
    conn: sqlite3.Connection,
    *,
    actor: sqlite3.Row,
    config: RegionRulesConfig,
    expected_hash: str,
) -> dict:
    current, current_hash = load_region_config()
    if expected_hash != current_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="地区规则已被其他操作更新，请刷新后重试")

    current_keys = set(current.regions)
    next_keys = set(config.regions)
    removed = sorted(current_keys - next_keys)
    if removed:
        removed_regions = {key.strip().casefold(): key for key in removed}
        usage_counts: dict[str, int] = {}
        for row in conn.execute("SELECT target_region FROM projects WHERE target_region IS NOT NULL").fetchall():
            removed_key = removed_regions.get(row["target_region"].strip().casefold())
            if removed_key:
                usage_counts[removed_key] = usage_counts.get(removed_key, 0) + 1
        used = sorted(usage_counts.items())
        if used:
            summary = "、".join(f"{key}（{project_count} 个项目）" for key, project_count in used)
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"请先迁移使用中的地区：{summary}")

    payload = config.model_dump(exclude_none=True)
    serialized = f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n".encode("utf-8")
    next_hash = _hash_bytes(serialized)
    if next_hash == current_hash:
        return public_region_config(conn)

    path = region_rules_path()
    temp_path = path.with_name(f".{path.name}.tmp")
    try:
        temp_path.write_bytes(serialized)
        os.replace(temp_path, path)
    except OSError as exc:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="地区规则写入失败") from exc

    updated = sorted(
        key for key in current_keys & next_keys
        if current.regions[key].model_dump(exclude_none=True) != config.regions[key].model_dump(exclude_none=True)
    )
    record_audit(
        conn,
        actor=actor,
        action="region_rules.update",
        target_type="region_rules",
        target_id="main",
        target_label="全站地区规则",
        details={
            "before_hash": current_hash,
            "after_hash": next_hash,
            "added_regions": sorted(next_keys - current_keys),
            "removed_regions": removed,
            "updated_regions": updated,
            "before": current.model_dump(exclude_none=True),
            "after": payload,
        },
    )
    return public_region_config(conn)
