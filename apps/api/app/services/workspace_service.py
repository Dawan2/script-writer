from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import fcntl

from fastapi import HTTPException, UploadFile, status

from app.core.config import settings
from app.core.errors import APIError, stage_file_missing_error, tool_failure_error, unknown_stage_error
from app.services.audit_service import record_audit
from app.services.memory_sync_service import (
    analyze_markdown_change,
    document_sync_pending,
    mark_semantic_edit_in_progress,
    run_stage_validation,
    sync_workspace_memory,
)
from app.services.role_service import accessible_scenario_keys, require_scenario_permission
from app.services.script_tag_service import (
    AUTO_ADAPT_TAG,
    CREATIVE_TASK_TYPES,
    TAG_FIELDS,
    ScriptTagValidationError,
    normalize_tag_values,
    normalize_script_profile,
)

PROJECT_INPUT_FILE = "1.1-user-input.json"
PROJECT_PROGRESS_FILE = "1.2-project-progress.json"
DIALOGUE_TRANSLATION_MANIFEST_FILE = "runtime/dialogue-translate/manifest.json"

# ``STAGE_FILES`` is the user-facing delivery surface. Structured source files
# stay separate so a technical JSON artifact is never substituted for the
# document a user expects to read or export.
STAGE_FILES = {
    "project_init": "output/原始剧本.md",
    "novel_analysis": "2.1-novel-analysis.json",
    "world_view": "2.1-world-view.json",
    "outline_rewrite": "output/剧本大纲.md",
    "character_rewrite": "output/角色小传.md",
    "trial_generate": "output/剧本试稿.md",
    "full_generate": "output/剧本全稿.md",
    "dialogue_translate": "output/台词译稿.md",
    "foreign_review": "output/审稿报告.md",
    "humanizer_zh": "output/去AI味剧本.md",
}

STAGE_AUTHORING_FILES = {
    "novel_analysis": ("2.1-novel-analysis.json", "runtime/novel-source-index.json"),
    "world_view": ("2.1-world-view.json",),
    "outline_rewrite": ("3.1-outline.json",),
    "character_rewrite": ("4.1-character.json", "output/角色小传.md"),
    "trial_generate": ("output/剧本试稿.md",),
    "full_generate": ("tmp/全稿分阶段",),
    "dialogue_translate": ("7.1-lines-*.json",),
    "foreign_review": ("review-scorecard.json", "output/审稿报告.md"),
}

NAMED_SCRIPT_OUTPUTS = {
    "outline_rewrite": "故事梗概",
    "full_generate": "剧本全稿",
    "dialogue_translate": "台词译稿",
}
EPISODE_TITLED_SCRIPT_STAGES = frozenset({"trial_generate", "full_generate", "dialogue_translate"})
_SCRIPT_EPISODE_HEADING_RE = re.compile(
    r"^##[ \t]*第[ \t]*(?P<episode>\d+)[ \t]*集(?:[ \t]*[：:][ \t]*(?P<title>[^\r\n]*))?[ \t]*\r?$",
    re.MULTILINE,
)
_DELIVERY_EPISODE_HEADING_RE = re.compile(
    r"^#{1,6}[ \t]*(?:第[ \t]*)?\d+[ \t]*(?:集|章)(?=[ \t]*$|[ \t]*[：:])",
    re.MULTILINE,
)

REVIEW_SCORECARD_FILE = "review-scorecard.json"
ACTIVE_DELIVERY_STATUSES = frozenset({"queued", "running", "in_progress"})
APPROVAL_STAGES = frozenset({"trial_generate", "foreign_review"})
PROJECT_PERMISSION_VIEW = "view"
PROJECT_PERMISSION_EDIT = "edit"
PROJECT_PERMISSION_VALUES = frozenset({PROJECT_PERMISSION_VIEW, PROJECT_PERMISSION_EDIT})

# The private scorecard is an Agent contract. Only this display projection is
# allowed across the user-facing API boundary.
REVIEW_SCORECARD_DISPLAY_FIELDS = {
    "basic_info": ("script_name", "target_region", "target_language", "genre_tags"),
    "verdict": (
        "code",
        "label",
        "summary",
        "primary_issue_levels",
        "next_action",
        "human_review_required",
        "legal_review_required",
    ),
    "overall": ("grade",),
    "dimension": ("key", "name", "grade", "one_line_comment"),
    "critical_risk": ("severity", "summary", "action", "requires_human_review"),
}

DISTRIBUTION_BRIEF_FIELDS = (
    "target_countries",
    "target_locale",
    "market_deliverables",
)

MATURITY_TARGET_VALUES = (
    "全年龄段影片，适合所有人",
    "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
    "R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写",
    "NC-17 ，成人级影片，允许露骨性爱、极端血腥",
)
DEFAULT_MATURITY_TARGET = MATURITY_TARGET_VALUES[1]

INFERABLE_DISTRIBUTION_BRIEF_FIELDS = {
    "episode_duration",
    "target_episode_count",
    "maturity_target",
    *TAG_FIELDS,
}

STAGE_NAMES = {
    "project_init": "原始剧本",
    "novel_analysis": "小说解读",
    "world_view": "世界观",
    "outline_rewrite": "故事梗概",
    "character_rewrite": "人物小传",
    "trial_generate": "剧本试稿",
    "full_generate": "完整剧本",
    "dialogue_translate": "台词翻译",
    "foreign_review": "审稿报告",
    "humanizer_zh": "剧本润色",
}

STAGE_ORDER = [
    "project_init",
    "world_view",
    "outline_rewrite",
    "character_rewrite",
    "trial_generate",
    "full_generate",
    "dialogue_translate",
    "foreign_review",
]
NOVEL_STAGE_ORDER = [
    "project_init",
    "novel_analysis",
    "outline_rewrite",
    "character_rewrite",
    "trial_generate",
    "full_generate",
    "dialogue_translate",
    "foreign_review",
]
TASK_TYPE_REWRITE = "rewrite"
TASK_TYPE_NOVEL = "novel"
TASK_TYPE_REPLICATE = "replicate"
TASK_TYPE_REVIEW = "review"
TASK_TYPE_TRANSLATE = "translate"
TASK_TYPE_HUMANIZE = "humanize"
REVIEW_STAGE_ORDER = ["full_generate", "foreign_review"]
REVIEW_STAGE_NAMES = {
    "full_generate": "待审剧本",
    "foreign_review": "审稿报告",
}
# 场景、阶段链路及展示名称集中在此处维护。前端和批量调度均通过
# list_task_scenarios 读取，新增场景后无需再分别修改页面或队列逻辑。
TASK_SCENARIOS = {
    TASK_TYPE_REWRITE: {
        "name": "剧本改写",
        "stage_order": tuple(STAGE_ORDER[1:]),
    },
    TASK_TYPE_NOVEL: {
        "name": "小说改编",
        "stage_order": tuple(NOVEL_STAGE_ORDER[1:]),
    },
    TASK_TYPE_REPLICATE: {
        "name": "爆款复刻",
        "stage_order": tuple(STAGE_ORDER[1:]),
    },
    TASK_TYPE_REVIEW: {
        "name": "剧本审核",
        "stage_order": ("foreign_review",),
    },
    TASK_TYPE_TRANSLATE: {
        "name": "台词翻译",
        "stage_order": ("dialogue_translate",),
    },
    TASK_TYPE_HUMANIZE: {
        "name": "剧本润色",
        "stage_order": ("humanizer_zh",),
    },
}
TASK_TYPES = set(TASK_SCENARIOS)
ALLOWED_UPLOAD_SUFFIXES = {".pdf", ".docx", ".epub", ".txt", ".md", ".markdown"}


def list_target_regions() -> list[dict]:
    rules_path = settings.agents_dir / ".claude/config/region-rules.json"
    payload = json.loads(rules_path.read_text(encoding="utf-8"))
    regions = payload.get("regions", {})
    return [
        {
            "key": key,
            "target_language": rules.get("default_locale", ""),
            "target_market": rules.get("default_market", ""),
            "requires_translation": rules.get("requires_translation", True) is not False,
        }
        for key, rules in regions.items()
    ]


def _relative_workspace_dir(workspace_dir: Path) -> str:
    return str(workspace_dir.resolve().relative_to(settings.agents_dir.resolve()))


def resolve_workspace(workspace_dir: str) -> Path:
    base = settings.agents_dir.resolve()
    target = (base / workspace_dir).resolve()
    if not target.is_relative_to(settings.workspaces_dir.resolve()):
        raise APIError("WORKSPACE_PATH_INVALID")
    return target


def is_new_workspace(workspace: Path) -> bool:
    """The application has one workspace contract: the current Agents contract."""
    del workspace
    return True


def workspace_input_path(workspace: Path) -> Path:
    return workspace / PROJECT_INPUT_FILE


def workspace_progress_path(workspace: Path) -> Path:
    return workspace / PROJECT_PROGRESS_FILE


def _rewritten_script_title(workspace: Path) -> str:
    try:
        outline = json.loads((workspace / "3.1-outline.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return ""
    title = outline.get("剧本名称") if isinstance(outline, dict) else None
    return title.strip() if isinstance(title, str) else ""


def _translation_script_title(workspace: Path) -> str:
    title = _rewritten_script_title(workspace)
    if title:
        return title
    try:
        payload = json.loads(workspace_input_path(workspace).read_text(encoding="utf-8"))
        project = payload.get("project") if isinstance(payload, dict) else {}
        source = project.get("source_script") if isinstance(project, dict) else {}
        for value in (source.get("display_name") if isinstance(source, dict) else None,
                      project.get("project_name") if isinstance(project, dict) else None):
            if isinstance(value, str) and value.strip():
                return value.strip()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        pass
    return ""


def _project_init_file_for_workspace(workspace: Path) -> str:
    """Resolve the visible source material without exposing task internals."""
    try:
        payload = json.loads(workspace_input_path(workspace).read_text(encoding="utf-8"))
        project = payload.get("project") if isinstance(payload, dict) else {}
        if isinstance(project, dict) and project.get("task_type") == TASK_TYPE_REPLICATE:
            return "output/爆款分析报告.md"
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        pass
    return STAGE_FILES["project_init"]


def _safe_script_file_title(title: str) -> str:
    cleaned = re.sub(r"\s+", "-", title.strip())
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", cleaned)
    return cleaned[:80] or "未命名剧本"


def _named_stage_output_files(workspace: Path, stage: str) -> tuple[str, ...]:
    suffix = NAMED_SCRIPT_OUTPUTS.get(stage)
    output_dir = workspace / "output"
    if not suffix or not output_dir.is_dir():
        return ()
    return tuple(
        str(file_path.relative_to(workspace))
        for file_path in sorted(output_dir.glob(f"*-{suffix}.md"))
        if file_path.is_file()
    )


def stage_file_for_workspace(workspace: Path, stage: str) -> str:
    files = STAGE_FILES
    try:
        default_file = files[stage]
    except KeyError as exc:
        raise unknown_stage_error(stage) from exc
    if stage == "project_init":
        return _project_init_file_for_workspace(workspace)
    suffix = NAMED_SCRIPT_OUTPUTS.get(stage)
    title = (_translation_script_title(workspace) if stage == "dialogue_translate" else _rewritten_script_title(workspace)) if suffix else ""
    if title:
        return f"output/{_safe_script_file_title(title)}-{suffix}.md"
    return default_file


def full_script_completed_once(workspace: Path, progress: dict | None = None) -> bool:
    """Whether this project has crossed the point where the full script is the source of truth."""
    progress = progress if isinstance(progress, dict) else {}
    stages = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
    full_progress = stages.get("full_generate") if isinstance(stages.get("full_generate"), dict) else {}
    if full_progress.get("completed_once") is True:
        return True
    if full_progress.get("status") not in {"completed", "approved", "stale"}:
        return False
    full_path = workspace / stage_file_for_workspace(workspace, "full_generate")
    try:
        return full_path.is_file() and bool(full_path.read_text(encoding="utf-8").strip())
    except OSError:
        return False


def full_script_is_source_of_truth(
    project: sqlite3.Row | dict,
    workspace: Path,
    progress: dict | None = None,
) -> bool:
    return (
        row_task_type(project) in {TASK_TYPE_REWRITE, TASK_TYPE_NOVEL, TASK_TYPE_REPLICATE}
        and full_script_completed_once(workspace, progress)
    )


def stage_authoring_files_for_workspace(workspace: Path, stage: str) -> tuple[str, ...]:
    files = STAGE_AUTHORING_FILES
    values = tuple(files.get(stage, ()))
    if stage == "dialogue_translate":
        return tuple(sorted(path.name for path in workspace.glob("7.1-lines-*.json") if path.is_file()))
    return values


def stage_delivery_files_for_workspace(workspace: Path, stage: str) -> tuple[str, ...]:
    delivery = stage_file_for_workspace(workspace, stage)
    return tuple(dict.fromkeys((
        *stage_authoring_files_for_workspace(workspace, stage),
        delivery,
        *_named_stage_output_files(workspace, stage),
    )))


def review_scorecard_file_for_workspace(workspace: Path) -> str:
    del workspace
    return REVIEW_SCORECARD_FILE


def _restored_legacy_review_stage_status(workspace: Path, stage: str) -> str:
    if stage == "trial_generate":
        full_script = workspace / stage_file_for_workspace(workspace, "full_generate")
        if full_script.is_file():
            return "approved"
    return "completed"


def _migrate_legacy_foreign_review_route(workspace: Path, progress: dict) -> bool:
    """Move the former review-result route out of document lifecycle state."""
    stages = progress.get("stages")
    if not isinstance(stages, dict):
        return False
    review = stages.get("foreign_review")
    if not isinstance(review, dict):
        return False
    if review.get("status") in ACTIVE_DELIVERY_STATUSES:
        return False
    route = review.get("revision_route_validation")
    if not isinstance(route, dict) or route.get("outcome") != "revision_routed":
        return False
    revision_stage = route.get("revision_stage")
    if revision_stage not in STAGE_FILES:
        return False
    target = stages.get(revision_stage)
    if not isinstance(target, dict) or target.get("status") != "needs_revision" or target.get("last_error"):
        return False
    reason = target.get("revision_reason")
    if not isinstance(reason, str) or not reason.strip().startswith("海外审稿结论："):
        return False
    quality_check = target.get("quality_check") if isinstance(target.get("quality_check"), dict) else {}
    warnings = quality_check.get("warnings") if isinstance(quality_check.get("warnings"), list) else []
    if any(str(item).strip() for item in warnings):
        return False
    report_path = workspace / stage_file_for_workspace(workspace, "foreign_review")
    if not report_path.is_file():
        return False

    if revision_stage != "foreign_review":
        target["status"] = _restored_legacy_review_stage_status(workspace, revision_stage)
        target.pop("revision_reason", None)
        target.pop("invalidated_by", None)
        migration_order = NOVEL_STAGE_ORDER if revision_stage == "novel_analysis" else STAGE_ORDER
        for downstream_stage in migration_order[migration_order.index(revision_stage) + 1:]:
            if downstream_stage == "foreign_review":
                continue
            downstream = stages.get(downstream_stage)
            delivery_path = workspace / stage_file_for_workspace(workspace, downstream_stage)
            if (
                isinstance(downstream, dict)
                and downstream.get("status") == "pending"
                and downstream.get("invalidated_by") == revision_stage
                and delivery_path.is_file()
            ):
                downstream["status"] = _restored_legacy_review_stage_status(workspace, downstream_stage)
                downstream.pop("invalidated_by", None)

    review["status"] = "completed"
    review["quality_check"] = {
        "passed": True,
        "checks": ["审稿报告已通过格式与内容检查"],
        "warnings": [],
    }
    review["review_decision"] = {
        "outcome": "revision_requested",
        "verdict": route.get("verdict") if isinstance(route.get("verdict"), str) else "返修",
        "revision_stage": revision_stage,
        "reason": reason.strip(),
        "artifact_hashes": route.get("artifact_hashes") if isinstance(route.get("artifact_hashes"), dict) else {},
    }
    review["next_action"] = "海外审稿建议调整相关内容。请查看审稿报告，并在对应文件中手动重新生成；调整完成后重新生成审稿报告。"
    review.pop("revision_route_validation", None)
    review.pop("revision_reason", None)
    review.pop("invalidated_by", None)
    review.pop("last_error", None)
    progress["status"] = "foreign_review:completed"
    progress["current_skill"] = "foreign_review"
    progress["next_skill"] = ""
    return True


def load_progress(workspace_dir: str) -> dict:
    workspace = resolve_workspace(workspace_dir)
    progress_path = workspace_progress_path(workspace)
    if not progress_path.exists():
        raise APIError("PROGRESS_FILE_MISSING")
    progress = json.loads(progress_path.read_text(encoding="utf-8"))
    if _migrate_legacy_foreign_review_route(workspace, progress):
        _atomic_write_text(progress_path, f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n")
        user_input_path = workspace_input_path(workspace)
        try:
            user_input = json.loads(user_input_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            user_input = None
        if isinstance(user_input, dict):
            user_input["status"] = "foreign_review:completed"
            _atomic_write_text(user_input_path, f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n")
    return progress


def load_user_input(workspace_dir: str) -> dict | None:
    user_input_path = workspace_input_path(resolve_workspace(workspace_dir))
    if not user_input_path.exists():
        return None
    return json.loads(user_input_path.read_text(encoding="utf-8"))


def _clean_string_list(value) -> list[str]:
    if isinstance(value, str):
        values = value.replace("，", ",").replace("\n", ",").split(",")
    elif isinstance(value, list):
        values = value
    else:
        values = []
    result: list[str] = []
    for item in values:
        cleaned = str(item).strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def default_distribution_brief(
    target_region: str,
    values: dict | None,
    *,
    task_type: str = TASK_TYPE_REWRITE,
) -> dict:
    """Derive required market settings from the selected region only."""
    source = values if isinstance(values, dict) else {}
    region = next((item for item in list_target_regions() if item["key"] == target_region), None)
    if not region or not region.get("target_market") or not region.get("target_language"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="目标地区缺少默认市场或交付语言配置")

    brief = {
        "target_country": str(region["target_market"]).strip(),
        "target_locale": str(region["target_language"]).strip(),
        "maturity_target": _maturity_target(source.get("maturity_target")),
    }
    for field in (
        "episode_duration",
        "target_episode_count",
    ):
        value = source.get(field)
        if isinstance(value, str):
            value = value.strip()
        if value not in (None, ""):
            brief[field] = value
    user_selected_fields = {
        field
        for field in TAG_FIELDS
        if (selected := normalize_tag_values(source.get(field)))
        and AUTO_ADAPT_TAG not in selected
    }
    try:
        brief.update(normalize_script_profile(
            task_type,
            source,
            default_auto=True,
            user_selected_fields=user_selected_fields,
        ))
    except ScriptTagValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return brief


def _maturity_target(value: object) -> str:
    normalized = str(value or "").strip()
    return normalized if normalized in MATURITY_TARGET_VALUES else DEFAULT_MATURITY_TARGET


def _atomic_write_text(path: Path, content: str) -> None:
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp_path.write_text(content, encoding="utf-8")
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


@contextmanager
def _initialization_lock(workspace: Path):
    lock_path = workspace / ".project-initialization.lock"
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def normalize_distribution_brief(values: dict | None, *, confirmed: bool | None = None) -> dict:
    del confirmed
    source = values if isinstance(values, dict) else {}
    count = source.get("target_episode_count")
    try:
        count = int(count) if count not in (None, "") else None
    except (TypeError, ValueError):
        count = None
    if count is not None and count < 1:
        count = None
    countries = _clean_string_list(source.get("target_countries"))
    target_locale = str(source.get("target_locale") or "").strip()
    market_deliverables = [
        item for item in source.get("market_deliverables", [])
        if isinstance(item, dict)
    ] if isinstance(source.get("market_deliverables"), list) else []
    if not market_deliverables and countries and target_locale:
        market_deliverables = [
            {
                "market": country,
                "locale": target_locale,
                "delivery_mode": "bilingual_script",
                "status": "resolved",
                "locale_source": "region_rules:default_locale",
            }
            for country in countries
        ]
    known_locales = {
        item.get("locale") for item in market_deliverables
        if item.get("status") == "resolved" and isinstance(item.get("locale"), str)
    }
    has_unresolved_locale = any(item.get("status") != "resolved" for item in market_deliverables)
    inferred_contract_status = (
        "locale_required" if has_unresolved_locale
        else "multi_locale" if len(known_locales) > 1
        else "single_locale" if known_locales
        else "region_default"
    )
    contract_status = inferred_contract_status
    inferred_fields = [
        field
        for field in source.get("inferred_fields", [])
        if field in TAG_FIELDS
    ] if isinstance(source.get("inferred_fields"), list) else []
    brief = {
        "status": "provisional",
        "target_countries": countries,
        "target_locale": target_locale,
        "market_deliverables": market_deliverables,
        "locale_contract_status": contract_status,
        "requires_separate_language_versions": False,
        "inferred_fields": inferred_fields,
        "assumption_notes": [],
    }
    optional_strings = {
        "episode_duration": str(source.get("episode_duration") or "").strip(),
        "maturity_target": _maturity_target(source.get("maturity_target")),
    }
    brief.update({field: value for field, value in optional_strings.items() if value})
    if count is not None:
        brief["target_episode_count"] = count
    if any(field in source for field in TAG_FIELDS):
        user_selected_fields = {
            field
            for field in TAG_FIELDS
            if field not in inferred_fields
            and (selected := normalize_tag_values(source.get(field)))
            and AUTO_ADAPT_TAG not in selected
        }
        try:
            brief.update(normalize_script_profile(
                TASK_TYPE_REWRITE,
                source,
                default_auto=False,
                user_selected_fields=user_selected_fields,
            ))
        except ScriptTagValidationError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    missing_fields = [field for field in DISTRIBUTION_BRIEF_FIELDS if not brief.get(field)]
    resolved_markets = (
        len(brief["market_deliverables"]) == len(brief["target_countries"])
        and all(
            item.get("status") == "resolved" and isinstance(item.get("locale"), str) and item["locale"].strip()
            for item in brief["market_deliverables"]
        )
        and brief["locale_contract_status"] in {"single_locale", "multi_locale"}
    )
    if not resolved_markets and "market_deliverables" not in missing_fields:
        missing_fields.append("market_deliverables")
    brief["missing_fields"] = missing_fields
    brief["assumptions_require_approval"] = False
    if not missing_fields:
        brief["status"] = "complete"
    return brief


def distribution_brief_hash(brief: dict) -> str:
    canonical = json.dumps(brief, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_text(canonical)


def _workspace_file(workspace: Path, value: str, label: str) -> Path:
    if not value:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{label}未记录文件路径")
    candidate = Path(value)
    candidate = candidate.resolve() if candidate.is_absolute() else (workspace / candidate).resolve()
    if not candidate.is_relative_to(workspace.resolve()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{label}路径越界")
    if not candidate.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{label}文件缺失")
    return candidate


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _initialization_source(workspace: Path, user_input: dict, project_name: str) -> tuple[dict, Path]:
    source = user_input.get("project", {}).get("source_script")
    if not isinstance(source, dict):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目源文件记录缺失")
    stored_path = _workspace_file(workspace, str(source.get("reference_path") or ""), "归档源文件")
    normalized_path = _workspace_file(workspace, str(source.get("output_path") or ""), "规范化源内容")
    return {
        "display_name": str(source.get("display_name") or project_name or stored_path.name),
        "file_type": str(source.get("file_type") or stored_path.suffix.lstrip(".")).lower(),
        "sha256": _file_sha256(stored_path),
    }, normalized_path


def initialization_config_hash(values: dict) -> str:
    canonical = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_text(canonical)


def _initialization_values(project: sqlite3.Row | dict) -> tuple[dict, dict, Path, Path]:
    project_values = dict(project)
    workspace = resolve_workspace(project_values["workspace_dir"])
    input_path = workspace_input_path(workspace)
    progress_path = workspace_progress_path(workspace)
    if not input_path.is_file() or not progress_path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目初始化或进度文件缺失")
    try:
        user_input = json.loads(input_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目初始化文件无法解析") from exc
    project_input = user_input.get("project") if isinstance(user_input.get("project"), dict) else {}
    project_name = str(project_input.get("project_name") or project_values.get("name") or "").strip()
    source, _normalized_path = _initialization_source(workspace, user_input, project_name)
    brief = normalize_distribution_brief(project_input.get("distribution_brief"))
    countries = brief.get("target_countries") or []
    target_country = str(countries[0]) if countries else ""
    values = {
        "project_name": project_name,
        "task_type": normalize_task_type(project_input.get("task_type") or project_values.get("task_type")),
        "target_region": str(project_input.get("target_region") or project_values.get("target_region") or ""),
        "target_country": target_country,
        "target_locale": str(brief.get("target_locale") or ""),
        "extra_requirements": str(project_input.get("extra_requirements") or ""),
        "source": source,
        "brief": brief,
    }
    return values, user_input, input_path, progress_path


def initialization_for_project(project: sqlite3.Row | dict) -> dict:
    values, _user_input, _input_path, _progress_path = _initialization_values(project)
    return {**values, "config_hash": initialization_config_hash(values)}


def _run_distribution_brief_tool(
    workspace: Path,
    *,
    actor: str,
    values: dict,
    confirmed: bool,
) -> dict:
    command = [
        os.getenv("ORCA_NODE_PATH", "").strip() or "node",
        str(settings.agents_dir / ".claude/skills/project_init/scripts/update-distribution-brief.mjs"),
        "--workspace", _relative_workspace_dir(workspace),
        "--updated-by", actor,
    ]
    command.extend(distribution_brief_command_args({
        "episode_duration": values.get("episode_duration"),
        "target_episode_count": values.get("target_episode_count"),
        "maturity_target": values.get("maturity_target"),
        **{field: values.get(field) for field in TAG_FIELDS},
    }))
    if confirmed:
        command.append("--confirm")
    result = subprocess.run(
        command,
        cwd=settings.agents_dir,
        check=False,
        text=True,
        capture_output=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise tool_failure_error(
            "DISTRIBUTION_BRIEF_UPDATE_FAILED",
            root_cause=result.stderr.strip() or result.stdout.strip(),
        )
    try:
        return parse_agent_json(result.stdout)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="发行任务书工具返回了无效 JSON") from exc


def infer_reinitialized_distribution_brief(
    *,
    workspace: Path,
    normalized_path: Path,
    source_title: str,
    task_type: str,
    target_region: str,
    target_country: str,
    target_locale: str,
    extra_requirements: str,
    advanced_values: dict,
) -> dict:
    entrypoint = settings.agents_dir / ".claude/skills/_shared/scripts/infer-distribution-brief.mjs"
    command = [
        "node",
        str(entrypoint),
        "--source-md",
        str(normalized_path),
        "--source-title",
        source_title,
        "--task-type",
        task_type,
        "--target-region",
        target_region,
        "--target-country",
        target_country,
        "--target-locale",
        target_locale,
        "--extra-requirements",
        extra_requirements,
    ] + distribution_brief_command_args(advanced_values)
    process = subprocess.run(
        command,
        cwd=workspace,
        check=False,
        text=True,
        capture_output=True,
        timeout=60,
    )
    if process.returncode != 0:
        raise tool_failure_error(
            "PROJECT_BRIEF_COMPLETION_FAILED",
            root_cause=process.stderr.strip() or process.stdout.strip(),
        )
    try:
        payload = parse_agent_json(process.stdout)
        brief = payload["brief"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="project_init 任务书补全返回了无效 JSON") from exc
    return normalize_distribution_brief(brief)


def _legacy_reinitialize_project(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    user: sqlite3.Row | dict,
    values: dict,
    *,
    expected_hash: str,
) -> dict:
    project_values = dict(project)
    workspace = resolve_workspace(project_values["workspace_dir"])
    with _initialization_lock(workspace):
        current, user_input, input_path, progress_path = _initialization_values(project)
        current_hash = initialization_config_hash(current)
        if expected_hash != current_hash:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="初始化配置已变更，请刷新后重试")

        project_name = str(values.get("project_name") or current["project_name"]).strip()
        if not project_name:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="项目名称不能为空")
        target_region = str(values.get("target_region") or current["target_region"]).strip()
        target_country = str(values.get("target_country") or current["target_country"]).strip()
        target_locale = str(values.get("target_locale") or current["target_locale"]).strip()
        if not target_region or not target_country or not target_locale:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="重新初始化必须选择具体市场与主交付 Locale")
        if not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", target_locale):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="主交付 Locale 必须是有效的 BCP 47 值")
        extra_requirements = (
            current["extra_requirements"]
            if values.get("extra_requirements") is None
            else str(values.get("extra_requirements") or "")
        )
        project_input = user_input.setdefault("project", {})
        _source, normalized_path = _initialization_source(workspace, user_input, project_name)
        old_brief = current["brief"]
        advanced_values = {
            field: old_brief.get(field) if field not in values else values.get(field)
            for field in INFERABLE_DISTRIBUTION_BRIEF_FIELDS
        }
        next_brief = infer_reinitialized_distribution_brief(
            workspace=workspace,
            normalized_path=normalized_path,
            source_title=current["source"]["display_name"],
            task_type=current["task_type"],
            target_region=target_region,
            target_country=target_country,
            target_locale=target_locale,
            extra_requirements=extra_requirements,
            advanced_values=advanced_values,
        )
        if next_brief.get("target_locale") != target_locale:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="市场与主交付 Locale 契约不一致")

        old_input_text = input_path.read_text(encoding="utf-8")
        old_progress_text = progress_path.read_text(encoding="utf-8")
        try:
            progress = json.loads(old_progress_text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目进度文件无法解析") from exc
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        invalidated_stages: list[str] = []
        stages = progress.setdefault("stages", {})
        for stage in task_stage_order(current["task_type"], target_region):
            stage_progress = stages.setdefault(stage, {})
            stage_progress["status"] = "stale"
            stage_progress["updated_at"] = now
            stage_progress["updated_by"] = user["username"]
            stage_progress["next_action"] = "项目已重新初始化，需按新配置重新生成或复核"
            invalidated_stages.append(stage)
        init_progress = stages.setdefault("project_init", {})
        init_progress["status"] = "completed"
        init_progress["updated_at"] = now
        init_progress["updated_by"] = user["username"]
        init_progress["next_action"] = "可按更新后的初始化配置重新执行下游阶段"
        progress["current_stage"] = "project_init"
        progress["audit"] = {**progress.get("audit", {}), "updated_at": now, "updated_by": user["username"]}

        project_input["project_name"] = project_name
        project_input["target_region"] = target_region
        project_input["target_language"] = target_locale
        project_input["distribution_brief"] = next_brief
        project_input["extra_requirements"] = extra_requirements
        project_input["status"] = "project_init:completed"
        project_input["task_type"] = current["task_type"]
        user_input["runtime"] = {
            **(user_input.get("runtime") if isinstance(user_input.get("runtime"), dict) else {}),
            "current_stage": "project_init",
            "next_recommended_skill": task_stage_order(current["task_type"], target_region)[0],
            "notes": ["项目已基于 workspace 内保留的源文件重新初始化"],
        }
        user_input["audit"] = {
            **(user_input.get("audit") if isinstance(user_input.get("audit"), dict) else {}),
            "updated_at": now,
            "updated_by": user["username"],
        }
        next_input_text = f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n"
        next_progress_text = f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n"
        impact = {
            "semantic_change": True,
            "change_kind": "project_reinitialize",
            "summary": "项目初始化配置已更新，所有下游阶段均需重新生成或复核",
        }
        savepoint = f"project_reinitialize_{project_values['id']}"
        conn.execute(f"SAVEPOINT {savepoint}")
        try:
            _atomic_write_text(input_path, next_input_text)
            _atomic_write_text(progress_path, next_progress_text)
            conn.execute("DELETE FROM stage_approvals WHERE project_id = ?", (project_values["id"],))
            conn.execute("DELETE FROM project_stage_sessions WHERE project_id = ?", (project_values["id"],))
            conn.execute(
                """
                UPDATE projects
                SET name = ?, target_region = ?, current_stage = 'project_init', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (project_name, target_region, project_values["id"]),
            )
            memory = sync_workspace_memory(
                workspace,
                actor=user["username"],
                reason="project_reinitialize",
                changed_file="01-user-input.json",
                old_hash=sha256_text(old_input_text),
                impact=impact,
            )
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        except Exception as exc:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            _atomic_write_text(input_path, old_input_text)
            _atomic_write_text(progress_path, old_progress_text)
            try:
                sync_workspace_memory(
                    workspace,
                    actor="system",
                    reason="project_reinitialize_rollback",
                    changed_file="01-user-input.json",
                )
            except Exception:
                pass
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(status_code=500, detail=f"重新初始化已回滚：Memory 同步失败：{exc}") from exc

        updated_project = {**project_values, "name": project_name, "target_region": target_region}
        initialization = initialization_for_project(updated_project)
        config_changed = initialization["config_hash"] != current_hash
        return {
            "initialization": initialization,
            "changed": config_changed,
            "reinitialized": True,
            "invalidated_stages": invalidated_stages,
            "memory_revision": memory.get("revision"),
        }


def reinitialize_project(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    user: sqlite3.Row | dict,
    values: dict,
    *,
    expected_hash: str,
) -> dict:
    """Reset the new workspace from its retained source and updated brief.

    The current project-init skill owns brief normalization and downstream
    invalidation. The application only updates the editable project fields and
    delegates the contract rewrite to that tool.
    """
    project_values = dict(project)
    workspace = resolve_workspace(project_values["workspace_dir"])
    if not is_new_workspace(workspace):
        return _legacy_reinitialize_project(conn, project, user, values, expected_hash=expected_hash)

    with _initialization_lock(workspace):
        current, user_input, input_path, progress_path = _initialization_values(project)
        current_hash = initialization_config_hash(current)
        if expected_hash != current_hash:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="初始化配置已变更，请刷新后重试")

        project_name = str(values.get("project_name") or current["project_name"]).strip()
        target_region = str(values.get("target_region") or current["target_region"]).strip()
        if not project_name or not target_region:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="重新初始化必须填写项目名称和目标地区")
        default_distribution_brief(target_region, None, task_type=current["task_type"])

        old_input = input_path.read_text(encoding="utf-8")
        old_progress = progress_path.read_text(encoding="utf-8")
        project_input = user_input.setdefault("project", {})
        project_input["project_name"] = project_name
        project_input["target_region"] = target_region
        extra_requirements = str(values.get("extra_requirements") or "").strip()
        if extra_requirements:
            project_input["extra_requirements"] = extra_requirements
        else:
            project_input.pop("extra_requirements", None)
        project_input["task_type"] = current["task_type"]
        # Reinitialization receives the current form snapshot. Empty optional
        # fields intentionally clear any earlier values before the tool rebuilds
        # the region-derived brief.
        project_input.pop("distribution_brief", None)
        _atomic_write_text(input_path, f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n")

        brief_values = {
            field: value
            for field in INFERABLE_DISTRIBUTION_BRIEF_FIELDS
            if (value := values.get(field)) not in (None, "", [])
        }
        try:
            tool_result = _run_distribution_brief_tool(
                workspace,
                actor=str(user["username"]),
                values=brief_values,
                confirmed=True,
            )
            if tool_result.get("distribution_brief_status") != "complete":
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="发行任务书尚未完成")
            conn.execute("DELETE FROM stage_approvals WHERE project_id = ?", (project_values["id"],))
            conn.execute("DELETE FROM project_stage_sessions WHERE project_id = ?", (project_values["id"],))
            conn.execute(
                "UPDATE projects SET name = ?, target_region = ?, current_stage = 'project_init', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (project_name, target_region, project_values["id"]),
            )
        except Exception:
            _atomic_write_text(input_path, old_input)
            _atomic_write_text(progress_path, old_progress)
            raise

        updated_project = {**project_values, "name": project_name, "target_region": target_region}
        initialization = initialization_for_project(updated_project)
        return {
            "initialization": initialization,
            "changed": initialization["config_hash"] != current_hash,
            "reinitialized": True,
            "invalidated_stages": tool_result.get("invalidated_stages", []),
            "memory_revision": None,
        }


def resolve_distribution_locale_contract(
    target_region: str,
    target_countries: list[str],
    target_locale: str = "",
) -> dict:
    entrypoint = settings.agents_dir / ".claude/skills/_shared/scripts/get-region-rules.mjs"
    command = ["node", str(entrypoint), "--target-region", target_region]
    if target_countries:
        command.extend(["--target-country", ",".join(target_countries)])
    if target_locale:
        command.extend(["--target-locale", target_locale])
    process = subprocess.run(
        command,
        cwd=settings.agents_dir,
        check=False,
        text=True,
        capture_output=True,
        timeout=30,
    )
    if process.returncode != 0:
        raise tool_failure_error(
            "LOCALE_CONTRACT_FAILED",
            root_cause=process.stderr.strip() or process.stdout.strip(),
        )
    try:
        payload = parse_agent_json(process.stdout)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="国家-locale 契约返回了无效 JSON") from exc
    if not isinstance(payload.get("market_deliverables"), list) or not isinstance(payload.get("locale_contract"), dict):
        raise HTTPException(status_code=500, detail="国家-locale 契约结构不完整")
    return payload


def distribution_brief_for_project(project: sqlite3.Row | dict) -> dict:
    project_values = dict(project)
    user_input = load_user_input(project["workspace_dir"])
    if user_input is None:
        raise APIError("PROJECT_INPUT_MISSING", root_cause=f"missing={PROJECT_INPUT_FILE}")
    raw_brief = user_input.get("project", {}).get("distribution_brief")
    source_input = user_input.get("project", {}).get("source_script")
    source = {
        "display_name": str(source_input.get("original_name") or source_input.get("display_name") or "源文件")
    } if isinstance(source_input, dict) else None
    workspace = resolve_workspace(project["workspace_dir"])
    if is_new_workspace(workspace):
        brief = normalize_distribution_brief(raw_brief)
        return {
            "brief": brief,
            "content_hash": distribution_brief_hash(brief),
            "target_region": user_input.get("project", {}).get("target_region") or project_values.get("target_region"),
            "extra_requirements": str(user_input.get("project", {}).get("extra_requirements") or ""),
            "source": source,
        }
    countries = _clean_string_list(raw_brief.get("target_countries")) if isinstance(raw_brief, dict) else []
    if countries:
        contract = resolve_distribution_locale_contract(
            user_input.get("project", {}).get("target_region") or project_values.get("target_region") or "",
            countries,
            str(raw_brief.get("target_locale") or ""),
        )
        raw_brief = {
            **raw_brief,
            "target_locale": (
                contract["locale_contract"].get("selected_locale")
                if raw_brief.get("target_locale") else ""
            ),
            "market_deliverables": contract["market_deliverables"],
            "locale_contract_status": contract["locale_contract"]["status"],
            "requires_separate_language_versions": contract["locale_contract"]["requires_separate_versions"],
        }
    brief = normalize_distribution_brief(raw_brief)
    return {
        "brief": brief,
        "content_hash": distribution_brief_hash(brief),
        "target_region": user_input.get("project", {}).get("target_region") or project_values.get("target_region"),
        "extra_requirements": str(user_input.get("project", {}).get("extra_requirements") or ""),
        "source": source,
    }


def source_attachment_for_project(project: sqlite3.Row | dict) -> tuple[Path, str]:
    user_input = load_user_input(project["workspace_dir"])
    source = user_input.get("project", {}).get("source_script") if isinstance(user_input, dict) else None
    if not isinstance(source, dict):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="源文件记录不存在")
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = _workspace_file(workspace, str(source.get("reference_path") or ""), "源文件")
    file_name = str(source.get("original_name") or source.get("display_name") or file_path.name).strip() or file_path.name
    return file_path, Path(file_name).name


def _legacy_update_distribution_brief(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    user: sqlite3.Row | dict,
    values: dict,
    *,
    confirmed: bool,
    expected_hash: str | None = None,
) -> dict:
    project_values = dict(project)
    workspace = resolve_workspace(project["workspace_dir"])
    input_path = workspace / "01-user-input.json"
    progress_path = workspace / "01-project-progress.json"
    if not input_path.is_file() or not progress_path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目任务书或进度文件缺失")

    old_input_text = input_path.read_text(encoding="utf-8")
    old_progress_text = progress_path.read_text(encoding="utf-8")
    user_input = json.loads(old_input_text)
    raw_old_brief = user_input.get("project", {}).get("distribution_brief")
    old_countries = _clean_string_list(raw_old_brief.get("target_countries")) if isinstance(raw_old_brief, dict) else []
    if old_countries:
        old_contract = resolve_distribution_locale_contract(
            user_input.get("project", {}).get("target_region") or project_values.get("target_region") or "",
            old_countries,
            str(raw_old_brief.get("target_locale") or ""),
        )
        raw_old_brief = {
            **raw_old_brief,
            "target_locale": (
                old_contract["locale_contract"].get("selected_locale")
                if raw_old_brief.get("target_locale") else ""
            ),
            "market_deliverables": old_contract["market_deliverables"],
            "locale_contract_status": old_contract["locale_contract"]["status"],
            "requires_separate_language_versions": old_contract["locale_contract"]["requires_separate_versions"],
        }
    old_brief = normalize_distribution_brief(raw_old_brief)
    old_hash = distribution_brief_hash(old_brief)
    if expected_hash and expected_hash != old_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="发行任务书已变更，请刷新后重新提交")

    next_values = dict(values)
    target_countries = _clean_string_list(next_values.get("target_countries"))
    target_locale = str(next_values.get("target_locale") or "").strip()
    locale_contract = resolve_distribution_locale_contract(
        user_input.get("project", {}).get("target_region") or project_values.get("target_region") or "",
        target_countries,
        target_locale,
    )
    contract = locale_contract["locale_contract"]
    if target_locale and not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", target_locale):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="主交付 Locale 必须是有效的 BCP 47 值，例如 en-US、fr-CA、es-AR")
    target_locale = contract.get("selected_locale") if target_locale else ""
    if target_locale and contract.get("locales") and target_locale not in contract["locales"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"主交付 Locale {target_locale} 与目标国家契约不一致；可选：{'、'.join(contract['locales'])}",
        )
    next_values.update({
        "target_countries": target_countries,
        "target_locale": target_locale,
        "market_deliverables": locale_contract["market_deliverables"],
        "locale_contract_status": contract["status"],
        "requires_separate_language_versions": contract["requires_separate_versions"],
    })
    next_brief = normalize_distribution_brief(next_values, confirmed=confirmed)
    if confirmed and next_brief["status"] != "complete":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"发行任务书尚未满足完整契约：{'、'.join(next_brief['missing_fields'])}",
        )
    if next_brief == old_brief:
        return {
            "brief": next_brief,
            "content_hash": old_hash,
            "changed": False,
            "invalidated_stages": [],
            "target_region": user_input.get("project", {}).get("target_region") or project_values.get("target_region"),
        }

    progress = json.loads(old_progress_text)
    workflow_stages = workflow_stage_order(row_task_type(project), row_target_region(project))
    invalidated_stages = [
        stage
        for stage in workflow_stages[1:]
        if progress.get("stages", {}).get(stage, {}).get("status") not in {None, "pending"}
    ]
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    project_input = user_input.setdefault("project", {})
    project_input["distribution_brief"] = next_brief
    project_input["target_language"] = next_brief["target_locale"]
    project_input["status"] = "project_init:completed"
    user_input["runtime"] = {
        **(user_input.get("runtime") if isinstance(user_input.get("runtime"), dict) else {}),
        "current_stage": "project_init",
        "next_recommended_skill": workflow_stages[1] if len(workflow_stages) > 1 else "",
    }
    user_input["audit"] = {
        **(user_input.get("audit") if isinstance(user_input.get("audit"), dict) else {}),
        "updated_at": now,
        "updated_by": user["username"],
    }

    temp_path = input_path.with_name(f".{input_path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    temp_path.replace(input_path)
    impact = {
        "semantic_change": True,
        "change_kind": "distribution_brief_update",
        "summary": "发行任务书已更新，所有已生成的下游阶段需按新任务书重新复核",
    }
    try:
        mark_semantic_edit_in_progress(workspace, "project_init", workflow_stages, impact, user["username"])
        memory = sync_workspace_memory(
            workspace,
            actor=user["username"],
            reason="distribution_brief_update",
            changed_file="01-user-input.json",
            old_hash=sha256_text(old_input_text),
            impact=impact,
        )
    except Exception as exc:
        input_path.write_text(old_input_text, encoding="utf-8")
        progress_path.write_text(old_progress_text, encoding="utf-8")
        raise HTTPException(status_code=500, detail=f"发行任务书更新已回滚：Memory 同步失败：{exc}") from exc

    conn.execute("DELETE FROM stage_approvals WHERE project_id = ? AND stage != 'project_init'", (project["id"],))
    conn.execute(
        "UPDATE projects SET current_stage = 'project_init', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (project["id"],),
    )
    return {
        "brief": next_brief,
        "content_hash": distribution_brief_hash(next_brief),
        "changed": True,
        "invalidated_stages": invalidated_stages,
        "target_region": project_input.get("target_region") or project_values.get("target_region"),
        "memory_revision": memory.get("revision"),
    }


def update_distribution_brief(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    user: sqlite3.Row | dict,
    values: dict,
    *,
    confirmed: bool,
    expected_hash: str | None = None,
) -> dict:
    workspace = resolve_workspace(project["workspace_dir"])
    if not is_new_workspace(workspace):
        return _legacy_update_distribution_brief(
            conn,
            project,
            user,
            values,
            confirmed=confirmed,
            expected_hash=expected_hash,
        )

    current = distribution_brief_for_project(project)
    if expected_hash and expected_hash != current["content_hash"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="发行任务书已变更，请刷新后重新提交")
    result = _run_distribution_brief_tool(
        workspace,
        actor=str(user["username"]),
        values=values,
        confirmed=confirmed,
    )
    if row_task_type(project) == TASK_TYPE_REVIEW and result.get("distribution_brief_status") == "complete":
        prepare_review_workspace(workspace, actor=str(user["username"]))
    refreshed = distribution_brief_for_project(project)
    if confirmed and refreshed["brief"]["status"] != "complete":
        missing = "、".join(refreshed["brief"].get("missing_fields", []))
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"发行任务书尚未满足完整契约：{missing}")
    if result.get("invalidated_stages"):
        conn.execute("DELETE FROM stage_approvals WHERE project_id = ?", (project["id"],))
    conn.execute(
        "UPDATE projects SET current_stage = 'project_init', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (project["id"],),
    )
    return {
        **refreshed,
        "changed": refreshed["content_hash"] != current["content_hash"],
        "invalidated_stages": result.get("invalidated_stages", []),
        "memory_revision": None,
    }


def approve_new_stage(workspace: Path, *, stage: str, actor: str, artifact_hash: str) -> dict:
    if stage not in APPROVAL_STAGES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="当前阶段不需要人工确认")
    command = [
        os.getenv("ORCA_NODE_PATH", "").strip() or "node",
        str(settings.agents_dir / ".claude/tools/approve-stage.mjs"),
        "--workspace", _relative_workspace_dir(workspace),
        "--stage", stage,
        "--approved-by", actor,
    ]
    result = subprocess.run(
        command,
        cwd=settings.agents_dir,
        check=False,
        text=True,
        capture_output=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise tool_failure_error(
            "STAGE_APPROVAL_FAILED",
            root_cause=result.stderr.strip() or result.stdout.strip(),
        )
    try:
        payload = parse_agent_json(result.stdout)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="阶段确认工具返回了无效 JSON") from exc
    if payload.get("ok") is not True:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(payload.get("message") or "阶段确认失败"))
    return {
        "stage": stage,
        "status": "approved",
        "artifact_hash": artifact_hash,
        "quality_contract_version": "agents-new-v1",
        "job_id": None,
        "memory": {"initialized": False, "fresh": True, "stale_files": [], "missing_files": [], "new_files": []},
        "tool": payload,
    }


def stage_label(stage: str) -> str:
    return STAGE_NAMES.get(stage, stage)


def normalize_task_type(task_type: str | None) -> str:
    value = (task_type or TASK_TYPE_REWRITE).strip()
    if value not in TASK_TYPES:
        raise APIError("TASK_TYPE_UNSUPPORTED")
    return value


def requires_dialogue_translation(target_region: str | None) -> bool:
    if not target_region:
        return True
    try:
        rules_path = settings.agents_dir / ".claude/config/region-rules.json"
        regions = json.loads(rules_path.read_text(encoding="utf-8")).get("regions", {})
        definition = regions.get(target_region)
        return not isinstance(definition, dict) or definition.get("requires_translation", True) is not False
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return True


def task_stage_order(task_type: str | None, target_region: str | None = None) -> list[str]:
    normalized = normalize_task_type(task_type)
    stages = list(TASK_SCENARIOS[normalized]["stage_order"])
    if normalized in {TASK_TYPE_REWRITE, TASK_TYPE_NOVEL, TASK_TYPE_REPLICATE} and not requires_dialogue_translation(target_region):
        stages.remove("dialogue_translate")
    return stages


def workflow_stage_order(task_type: str | None, target_region: str | None = None) -> list[str]:
    return ["project_init", *task_stage_order(task_type, target_region)]


def list_task_scenarios() -> list[dict]:
    """Return the platform's current task scenarios for external consumers."""
    return [
        {
            "key": key,
            "name": definition["name"],
            "stages": [
                {
                    "key": stage,
                    "name": REVIEW_STAGE_NAMES.get(stage, stage_label(stage)) if key == TASK_TYPE_REVIEW else stage_label(stage),
                    "file_name": STAGE_FILES[stage],
                }
                for stage in definition["stage_order"]
            ],
        }
        for key, definition in TASK_SCENARIOS.items()
    ]


def row_task_type(row: sqlite3.Row | dict) -> str:
    if "task_type" in row.keys() and row["task_type"]:
        return row["task_type"]
    return TASK_TYPE_REWRITE


def row_target_region(row: sqlite3.Row | dict) -> str | None:
    try:
        value = row["target_region"]
    except (KeyError, IndexError):
        return None
    return value.strip() if isinstance(value, str) and value.strip() else None


def project_stage_label(project: sqlite3.Row, stage: str) -> str:
    if row_task_type(project) == TASK_TYPE_REVIEW:
        return REVIEW_STAGE_NAMES.get(stage, stage_label(stage))
    if stage == "project_init" and row_task_type(project) == TASK_TYPE_REPLICATE:
        return "爆款分析报告"
    return stage_label(stage)


def workspace_name_to_project_name(workspace_name: str) -> str:
    parts = workspace_name.split("_", 2)
    return parts[2] if len(parts) == 3 else workspace_name


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def world_view_payload_from_content(content: str) -> dict:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="世界观内容无法解析，请重新填写。",
        ) from exc
    if not isinstance(value, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="世界观内容必须是一份对象。",
        )

    description = value.get("世界观描述")
    if not isinstance(description, str) or not description.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="请填写世界观描述。",
        )
    mappings = value.get("关键概念映射")
    if not isinstance(mappings, list):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="关键概念映射必须是列表。",
        )

    normalized_mappings: list[dict[str, str]] = []
    known_sources: set[str] = set()
    for index, item in enumerate(mappings, start=1):
        if not isinstance(item, dict):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"第 {index} 条关键概念映射格式不正确。",
            )
        source = item.get("原剧本概念")
        target = item.get("映射后概念")
        source = source.strip() if isinstance(source, str) else ""
        target = target.strip() if isinstance(target, str) else ""
        if not source and not target:
            continue
        if not source or not target:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"请补全第 {index} 条关键概念映射。",
            )
        if source in known_sources:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"原剧本概念“{source}”重复，请合并为一条映射。",
            )
        known_sources.add(source)
        normalized_mappings.append({"原剧本概念": source, "映射后概念": target})

    return {
        "世界观描述": description.strip(),
        "关键概念映射": normalized_mappings,
    }


def serialize_world_view_payload(payload: dict) -> str:
    return f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n"


def novel_analysis_payload_from_content(content: str) -> dict:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="小说解读内容无法解析，请重新填写。",
        ) from exc
    if not isinstance(value, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="小说解读内容必须是一份对象。",
        )
    return value


def serialize_novel_analysis_payload(payload: dict) -> str:
    return f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n"


def stage_delivery_in_progress(project: sqlite3.Row | dict, stage: str) -> bool:
    """Whether a stage currently has a private, unfinalized candidate."""
    progress = load_progress(project["workspace_dir"])
    stages = progress.get("stages")
    stage_progress = stages.get(stage) if isinstance(stages, dict) else None
    status_value = stage_progress.get("status") if isinstance(stage_progress, dict) else None
    return isinstance(status_value, str) and status_value in ACTIVE_DELIVERY_STATUSES


def _scorecard_display_string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _scorecard_display_strings(value: object, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)][:limit]


def _scorecard_display_bool(value: object) -> bool:
    return value if isinstance(value, bool) else False


def _scorecard_display_section(section: str, values: dict[str, object]) -> dict:
    return {field: values[field] for field in REVIEW_SCORECARD_DISPLAY_FIELDS[section]}


def public_review_scorecard(payload: object) -> dict | None:
    """Project a review scorecard to fields intentionally designed for display."""
    if not isinstance(payload, dict):
        return None

    # 完整评分卡留在项目内，界面只接收用于展示的简化字段。
    if isinstance(payload.get("审稿信息"), dict) and isinstance(payload.get("总体结论"), dict):
        info = payload["审稿信息"]
        conclusion = payload["总体结论"]
        verdict_name = _scorecard_display_string(conclusion.get("结论"))
        verdict_code = {
            "通过": "pass",
            "返修": "revise",
            "淘汰/重选": "reject_or_reselect",
            "补材料": "supplement_materials",
        }.get(verdict_name, "revise")
        dimension_keys = [
            "market_fit",
            "story_engine",
            "character_drive",
            "retention_pacing",
            "dialogue_production",
            "overseas_readiness",
        ]
        new_scorecard = isinstance(payload.get("六维分析"), list)
        source_dimensions = payload.get("六维分析") if new_scorecard else payload.get("六维评分")
        dimensions = []
        for index, item in enumerate(source_dimensions if isinstance(source_dimensions, list) else []):
            if not isinstance(item, dict):
                continue
            dimensions.append({
                "key": dimension_keys[index] if index < len(dimension_keys) else f"dimension_{index + 1}",
                "name": _scorecard_display_string(item.get("维度")),
                "grade": _scorecard_display_string(item.get("评级") or item.get("等级")) or None,
                "one_line_comment": _scorecard_display_string(item.get("判断")),
            })
        risks = payload.get("风险与复核") if isinstance(payload.get("风险与复核"), list) else []
        script_info = payload.get("剧本信息") if isinstance(payload.get("剧本信息"), dict) else {}
        script_file = _scorecard_display_string(info.get("剧本文件"))
        script_name = _scorecard_display_string(script_info.get("剧本名称"))
        if not script_name and script_file:
            script_name = Path(script_file).stem.removesuffix("-剧本全稿")
        return {
            "basic_info": {
                "script_name": script_name,
                "target_region": _scorecard_display_string(info.get("目标市场")) or _scorecard_display_string(info.get("目标地区")),
                "target_language": _scorecard_display_string(info.get("目标语")),
                "genre_tags": _scorecard_display_strings(script_info.get("题材"), limit=12),
            },
            "verdict": {
                "code": verdict_code,
                "label": "返修：补材料" if verdict_name == "补材料" else verdict_name,
                "summary": _scorecard_display_string(conclusion.get("一句话判断")),
                "primary_issue_levels": _scorecard_display_strings([conclusion.get("建议修改范围") or conclusion.get("最早返修层级")], limit=1),
                "next_action": _scorecard_display_string(conclusion.get("下一步")),
                "human_review_required": any(isinstance(item, dict) and item.get("需要人工复核") is True for item in risks),
                "legal_review_required": any(
                    isinstance(item, dict) and "法律" in _scorecard_display_string(item.get("类别"))
                    for item in risks
                ),
            },
            "overall": {
                "grade": _scorecard_display_string(conclusion.get("评级") or conclusion.get("等级")) or None,
            },
            "dimensions": dimensions,
            "p0_issue_count": len(payload.get("P0问题")) if isinstance(payload.get("P0问题"), list) else 0,
            "critical_risks": [
                {
                    "severity": "critical" if item.get("严重程度") == "高" else "high",
                    "summary": _scorecard_display_string(item.get("说明")),
                    "action": _scorecard_display_string(item.get("建议")),
                    "requires_human_review": _scorecard_display_bool(item.get("需要人工复核")),
                }
                for item in risks[:8]
                if isinstance(item, dict)
            ],
        }

    basic_info = payload.get("basic_info") if isinstance(payload.get("basic_info"), dict) else {}
    verdict = payload.get("verdict") if isinstance(payload.get("verdict"), dict) else {}
    overall = payload.get("overall") if isinstance(payload.get("overall"), dict) else {}

    dimensions: list[dict] = []
    if isinstance(payload.get("dimensions"), list):
        for item in payload["dimensions"][:6]:
            if not isinstance(item, dict):
                continue
            dimensions.append(
                _scorecard_display_section("dimension", {
                    "key": _scorecard_display_string(item.get("key")),
                    "name": _scorecard_display_string(item.get("name")),
                    "grade": _scorecard_display_string(item.get("grade")) or None,
                    "one_line_comment": _scorecard_display_string(item.get("one_line_comment")),
                })
            )

    critical_risks: list[dict] = []
    if isinstance(payload.get("critical_risks"), list):
        for item in payload["critical_risks"][:8]:
            if not isinstance(item, dict):
                continue
            critical_risks.append(
                _scorecard_display_section("critical_risk", {
                    "severity": _scorecard_display_string(item.get("severity")),
                    "summary": _scorecard_display_string(item.get("summary")),
                    "action": _scorecard_display_string(item.get("action")),
                    "requires_human_review": _scorecard_display_bool(item.get("requires_human_review")),
                })
            )

    return {
        "basic_info": _scorecard_display_section("basic_info", {
            "script_name": _scorecard_display_string(basic_info.get("script_name")),
            "target_region": _scorecard_display_string(basic_info.get("target_region")),
            "target_language": _scorecard_display_string(basic_info.get("target_language")),
            "genre_tags": _scorecard_display_strings(basic_info.get("genre_tags"), limit=12),
        }),
        "verdict": _scorecard_display_section("verdict", {
            "code": _scorecard_display_string(verdict.get("code")),
            "label": _scorecard_display_string(verdict.get("label")),
            "summary": _scorecard_display_string(verdict.get("summary")),
            "primary_issue_levels": _scorecard_display_strings(verdict.get("primary_issue_levels"), limit=8),
            "next_action": _scorecard_display_string(verdict.get("next_action")),
            "human_review_required": _scorecard_display_bool(verdict.get("human_review_required")),
            "legal_review_required": _scorecard_display_bool(verdict.get("legal_review_required")),
        }),
        "overall": _scorecard_display_section("overall", {
            "grade": _scorecard_display_string(overall.get("grade")) or None,
        }),
        "dimensions": dimensions,
        "p0_issue_count": max(0, int(payload.get("p0_issue_count") or 0)) if str(payload.get("p0_issue_count") or "0").isdigit() else 0,
        "critical_risks": critical_risks,
    }


def parse_agent_json(stdout: str) -> dict:
    start = stdout.rfind("\n{")
    json_text = stdout[start + 1:] if start >= 0 else stdout
    return json.loads(json_text)


def project_row_to_public(row: sqlite3.Row) -> dict:
    current_stage = row["current_stage"]
    updated_at = row["updated_at"]
    creator_name = row["creator_name"] if "creator_name" in row.keys() else None
    last_modified_by = row["last_modified_by"] if "last_modified_by" in row.keys() else None
    try:
        progress = load_progress(row["workspace_dir"])
        current_stage = progress.get("current_skill") or progress.get("current_stage") or current_stage
        audit = progress.get("audit", {})
        updated_at = audit.get("updated_at") or updated_at
        creator_name = audit.get("created_by") or creator_name
        last_modified_by = audit.get("updated_by") or last_modified_by
    except Exception:
        pass
    row_keys = set(row.keys())
    project_status = row["status"] if "status" in row_keys and row["status"] else "active"
    return {
        "id": row["id"],
        "name": row["name"],
        "owner_user_id": row["owner_user_id"],
        "access_level": row["access_level"] if "access_level" in row_keys else None,
        "creator_name": creator_name,
        "workspace_dir": row["workspace_dir"],
        "target_region": row["target_region"],
        "requires_translation": requires_dialogue_translation(row_target_region(row)),
        "task_type": row_task_type(row),
        "current_stage": current_stage,
        "current_stage_name": project_stage_label(row, current_stage),
        "status": project_status,
        "completed_at": row["completed_at"] if "completed_at" in row_keys else None,
        "completed_by": row["completed_by"] if "completed_by" in row_keys else None,
        "pinned": bool(row["pinned"]),
        "claude_session_id": row["claude_session_id"],
        "has_running_agent": bool(row["has_running_agent"]) if "has_running_agent" in row_keys else False,
        "is_batch_task": bool(row["is_batch_task"]) if "is_batch_task" in row_keys else False,
        "created_at": row["created_at"],
        "updated_at": updated_at,
        "last_modified_by": last_modified_by,
    }


def project_access_level(conn: sqlite3.Connection, user: sqlite3.Row, project: sqlite3.Row) -> str | None:
    if user["role"] == "admin":
        return PROJECT_PERMISSION_EDIT
    if project["owner_user_id"] == user["id"]:
        return "owner"
    row = conn.execute(
        "SELECT permission FROM project_permissions WHERE project_id = ? AND user_id = ?",
        (project["id"], user["id"]),
    ).fetchone()
    permission = row["permission"] if row else None
    return permission if permission in PROJECT_PERMISSION_VALUES else None


def can_access_project(conn: sqlite3.Connection, user: sqlite3.Row, project: sqlite3.Row) -> bool:
    return project_access_level(conn, user, project) is not None


def can_edit_project(conn: sqlite3.Connection, user: sqlite3.Row, project: sqlite3.Row) -> bool:
    return project_access_level(conn, user, project) in {"owner", PROJECT_PERMISSION_EDIT}


def can_manage_project_permissions(user: sqlite3.Row, project: sqlite3.Row) -> bool:
    return user["role"] == "admin" or project["owner_user_id"] == user["id"]


def _require_project_access(
    conn: sqlite3.Connection,
    user: sqlite3.Row,
    project: sqlite3.Row,
    required_permission: str,
) -> None:
    if required_permission == "manage":
        allowed = can_manage_project_permissions(user, project)
    elif required_permission == PROJECT_PERMISSION_EDIT:
        allowed = can_edit_project(conn, user, project)
    else:
        allowed = can_access_project(conn, user, project)
    if not allowed:
        record_audit(
            conn,
            actor=user,
            action="authorization.denied",
            target_type="project",
            target_id=project["id"],
            target_label=project["name"],
            project_id=int(project["id"]),
            outcome="denied",
            severity="warning",
            details={"required_permission": required_permission},
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="你没有此项目的操作权限")


def get_project_or_404(
    conn: sqlite3.Connection,
    project_id: int,
    user: sqlite3.Row,
    required_permission: str = PROJECT_PERMISSION_VIEW,
) -> sqlite3.Row:
    project = conn.execute(
        "SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL",
        (project_id,),
    ).fetchone()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到项目")
    require_scenario_permission(conn, user, row_task_type(project))
    _require_project_access(conn, user, project, required_permission)
    return project


def list_projects(conn: sqlite3.Connection, user: sqlite3.Row, query: str | None = None) -> list[dict]:
    where = ["projects.deleted_at IS NULL"]
    where_params: list[object] = []
    if user["role"] == "admin":
        access_level_sql = "CASE WHEN projects.owner_user_id = ? THEN 'owner' ELSE 'edit' END"
        access_level_params: list[object] = [user["id"]]
    else:
        access_level_sql = """
            CASE
                WHEN projects.owner_user_id = ? THEN 'owner'
                ELSE COALESCE((
                    SELECT permission
                    FROM project_permissions
                    WHERE project_permissions.project_id = projects.id
                      AND project_permissions.user_id = ?
                ), 'view')
            END
        """
        access_level_params = [user["id"], user["id"]]
        where.append(
            """
            (projects.owner_user_id = ? OR EXISTS (
                SELECT 1
                FROM project_permissions
                WHERE project_permissions.project_id = projects.id
                  AND project_permissions.user_id = ?
            ))
            """
        )
        where_params.extend([user["id"], user["id"]])
    if query:
        where.append("projects.name LIKE ?")
        where_params.append(f"%{query}%")
    rows = conn.execute(
        f"""
        SELECT
            projects.*,
            users.display_name AS creator_name,
            {access_level_sql} AS access_level,
            EXISTS (
                SELECT 1 FROM agent_jobs
                WHERE agent_jobs.project_id = projects.id
                  AND agent_jobs.status IN ('queued', 'running')
            ) AS has_running_agent,
            EXISTS (
                SELECT 1 FROM batch_tasks
                WHERE batch_tasks.project_id = projects.id
            ) AS is_batch_task
        FROM projects
        JOIN users ON users.id = projects.owner_user_id
        WHERE {' AND '.join(where)}
        ORDER BY CASE projects.status WHEN 'active' THEN 0 ELSE 1 END,
                 pinned DESC, updated_at DESC, id DESC
        """,
        [*access_level_params, *where_params],
    ).fetchall()
    allowed_scenarios = accessible_scenario_keys(conn, user)
    projects = [
        project_row_to_public(row)
        for row in rows
        if row_task_type(row) in allowed_scenarios
    ]
    project_usernames = {
        project[field]
        for project in projects
        for field in ("creator_name", "last_modified_by")
        if isinstance(project[field], str) and project[field].strip()
    }
    display_names: dict[str, str] = {}
    if project_usernames:
        placeholders = ", ".join("?" for _ in project_usernames)
        user_rows = conn.execute(
            f"SELECT username, display_name FROM users WHERE username IN ({placeholders})",
            list(project_usernames),
        ).fetchall()
        display_names = {row["username"]: row["display_name"] for row in user_rows}
    for project in projects:
        creator = project["creator_name"]
        modifier = project["last_modified_by"]
        project["creator_name"] = display_names.get(creator, creator)
        project["last_modified_by"] = display_names.get(modifier, modifier) if modifier else project["creator_name"]
    return projects


def _project_member_to_public(row: sqlite3.Row, *, access_level: str, is_owner: bool = False) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "access_level": access_level,
        "is_owner": is_owner,
    }


def list_project_members(conn: sqlite3.Connection, project: sqlite3.Row) -> dict:
    owner = conn.execute(
        "SELECT id, username, display_name FROM users WHERE id = ?",
        (project["owner_user_id"],),
    ).fetchone()
    if not owner:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目所有者不存在，无法管理权限")

    member_rows = conn.execute(
        """
        SELECT users.id, users.username, users.display_name, project_permissions.permission
        FROM project_permissions
        JOIN users ON users.id = project_permissions.user_id
        WHERE project_permissions.project_id = ?
          AND users.id != ?
          AND users.is_active = 1
          AND COALESCE(users.is_system, 0) = 0
          AND users.role = 'user'
        ORDER BY CASE project_permissions.permission WHEN 'edit' THEN 0 ELSE 1 END,
                 users.display_name COLLATE NOCASE,
                 users.id
        """,
        (project["id"], project["owner_user_id"]),
    ).fetchall()
    return {
        "members": [
            _project_member_to_public(owner, access_level="owner", is_owner=True),
            *[
                _project_member_to_public(row, access_level=row["permission"])
                for row in member_rows
                if row["permission"] in PROJECT_PERMISSION_VALUES
            ],
        ],
    }


def set_project_member_permission_by_username(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    username: str,
    permission: str,
    granted_by: sqlite3.Row,
) -> dict:
    normalized_username = username.strip()
    member = conn.execute(
        """
        SELECT id
        FROM users
        WHERE username = ?
          AND is_active = 1
          AND COALESCE(is_system, 0) = 0
          AND role = 'user'
          AND id != ?
        """,
        (normalized_username, project["owner_user_id"]),
    ).fetchone()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到可添加的用户，请确认账号填写正确",
        )
    return set_project_member_permission(conn, project, member["id"], permission, granted_by)


def update_project_member_permission(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user_id: int,
    permission: str,
    granted_by: sqlite3.Row,
) -> dict:
    existing = conn.execute(
        "SELECT 1 FROM project_permissions WHERE project_id = ? AND user_id = ?",
        (project["id"], user_id),
    ).fetchone()
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="该成员已不在项目中，请刷新后重试",
        )
    return set_project_member_permission(conn, project, user_id, permission, granted_by)


def set_project_member_permission(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user_id: int,
    permission: str,
    granted_by: sqlite3.Row,
) -> dict:
    if permission not in PROJECT_PERMISSION_VALUES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="权限仅可设为查看或编辑")
    if user_id == project["owner_user_id"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目所有者始终拥有编辑权限")
    member = conn.execute(
        """
        SELECT id, username, display_name, role
        FROM users
        WHERE id = ? AND is_active = 1 AND COALESCE(is_system, 0) = 0
        """,
        (user_id,),
    ).fetchone()
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到可授权的用户")
    if member["role"] == "admin":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="管理员默认可编辑所有项目，无需单独授权")

    existing = conn.execute(
        "SELECT permission FROM project_permissions WHERE project_id = ? AND user_id = ?",
        (project["id"], user_id),
    ).fetchone()
    previous_permission = existing["permission"] if existing else None
    changed = previous_permission != permission
    if changed:
        conn.execute(
            """
            INSERT INTO project_permissions (project_id, user_id, permission, granted_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, user_id) DO UPDATE SET
                permission = excluded.permission,
                granted_by = excluded.granted_by,
                updated_at = CURRENT_TIMESTAMP
            """,
            (project["id"], user_id, permission, granted_by["id"]),
        )
    return {
        "member": _project_member_to_public(member, access_level=permission),
        "previous_permission": previous_permission,
        "changed": changed,
    }


def remove_project_member_permission(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user_id: int,
) -> dict:
    if user_id == project["owner_user_id"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目所有者不能移除")
    member = conn.execute(
        """
        SELECT users.id, users.username, users.display_name, project_permissions.permission
        FROM project_permissions
        JOIN users ON users.id = project_permissions.user_id
        WHERE project_permissions.project_id = ? AND project_permissions.user_id = ?
        """,
        (project["id"], user_id),
    ).fetchone()
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="该用户尚未拥有项目权限")
    conn.execute(
        "DELETE FROM project_permissions WHERE project_id = ? AND user_id = ?",
        (project["id"], user_id),
    )
    return _project_member_to_public(member, access_level=member["permission"])


def files_for_project(project: sqlite3.Row) -> list[dict]:
    progress = load_progress(project["workspace_dir"])
    workspace = resolve_workspace(project["workspace_dir"])
    files = []
    project_type = row_task_type(project)
    stage_order = (
        REVIEW_STAGE_ORDER if project_type == TASK_TYPE_REVIEW
        else ["project_init", "dialogue_translate"] if project_type == TASK_TYPE_TRANSLATE
        else ["project_init", "humanizer_zh"] if project_type == TASK_TYPE_HUMANIZE
        else task_stage_order(project_type, row_target_region(project)) if project_type == TASK_TYPE_NOVEL
        else workflow_stage_order(project_type, row_target_region(project))
    )
    full_script_is_source = full_script_is_source_of_truth(project, workspace, progress)
    review_progress = progress.get("stages", {}).get("foreign_review", {})
    raw_review_decision = review_progress.get("review_decision") if isinstance(review_progress, dict) else None
    review_decision = None
    if isinstance(raw_review_decision, dict) and raw_review_decision.get("outcome") in {"passed", "revision_requested"}:
        review_decision = {
            "outcome": raw_review_decision["outcome"],
            "verdict": raw_review_decision.get("verdict") if isinstance(raw_review_decision.get("verdict"), str) else None,
            "revision_stage": raw_review_decision.get("revision_stage") if raw_review_decision.get("revision_stage") in STAGE_FILES else None,
            "reason": raw_review_decision.get("reason") if isinstance(raw_review_decision.get("reason"), str) else None,
        }
    for index, stage in enumerate(stage_order, start=1):
        stage_progress = progress["stages"].get(stage, {})
        file_name = stage_file_for_workspace(workspace, stage)
        file_exists = (workspace / file_name).exists()
        status_value = stage_progress.get("status", "pending")
        delivery_in_progress = isinstance(status_value, str) and status_value in ACTIVE_DELIVERY_STATUSES
        # `exists` describes an artifact the user can actually open or export,
        # not a private candidate currently being evaluated by the Agent.
        exists = file_exists and not delivery_in_progress
        quality_check = stage_progress.get("quality_check") if isinstance(stage_progress.get("quality_check"), dict) else {}
        raw_quality_warnings = quality_check.get("warnings") if isinstance(quality_check.get("warnings"), list) else []
        quality_warnings = [str(warning) for warning in raw_quality_warnings if str(warning).strip()]
        quality_passed = quality_check.get("passed") if isinstance(quality_check.get("passed"), bool) else None
        sync_pending = document_sync_pending(stage_progress)
        if quality_passed is None and status_value in {"completed", "awaiting_approval", "approved"}:
            quality_passed = True
        next_action = stage_progress.get("next_action")
        if sync_pending:
            next_action = "修改已保存，继续生成时会先更新相关内容。"
        elif stage == "foreign_review" and review_decision and review_decision["outcome"] == "revision_requested":
            next_action = "海外审稿建议调整相关内容。请查看审稿报告，并在对应文件中手动重新生成；调整完成后重新生成审稿报告。"
        elif status_value == "needs_revision" and quality_warnings and not (
            stage == "full_generate" and isinstance(next_action, str) and next_action.strip()
        ):
            next_action = f"请根据上述问题修改并保存 {file_name}，然后点击“下一步”重新检查"
        elif status_value == "needs_revision" and not quality_warnings and not (
            isinstance(next_action, str) and next_action.strip()
        ):
            next_action = "当前内容尚未重新完成检查，系统未提供具体问题明细。请重新生成当前内容后再继续。"
        # A generated user document remains editable even when an upstream
        # revision has made it pending. Its saved change is synchronized before
        # any later generation, rather than being hidden from the user.
        merged_into_full_script = stage == "trial_generate" and full_script_is_source
        unlocked = exists and not merged_into_full_script
        files.append(
            {
                "index": index,
                "stage": stage,
                "name": project_stage_label(project, stage),
                "file_name": file_name,
                "status": status_value,
                "current": (progress.get("current_skill") or progress.get("current_stage")) == stage,
                "exists": exists,
                "clickable": unlocked,
                "merged_into_full_script": merged_into_full_script,
                "updated_at": stage_progress.get("updated_at"),
                "quality_passed": quality_passed,
                "quality_warnings": quality_warnings,
                "review_decision": review_decision if stage == "foreign_review" else None,
                "next_action": next_action,
                "document_sync_pending": sync_pending,
            }
        )
    return files


def stage_placeholder_content(project: sqlite3.Row, stage: str, status_value: str) -> str:
    stage_name = project_stage_label(project, stage)
    if status_value in ACTIVE_DELIVERY_STATUSES:
        return f"# {stage_name}\n\n正在生成内容。\n\n完成后这里会自动显示。"
    return f"# {stage_name}\n\n内容尚未生成。"


def character_relationship_graph_for_workspace(workspace: Path) -> dict | None:
    """Return the user-facing relation graph without exposing the full character source."""
    source_path = workspace / "4.1-character.json"
    try:
        characters = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(characters, list) or not characters:
        return None

    nodes: list[dict] = []
    names: set[str] = set()
    protagonists: list[str] = []
    for item in characters:
        if not isinstance(item, dict):
            return None
        name = _delivery_text(item.get("人物名称"))
        role_identity = _delivery_text(item.get("身份"))
        faction = _delivery_text(item.get("所属阵营"))
        is_protagonist = item.get("是否主角")
        if not name or not role_identity or not faction or not isinstance(is_protagonist, bool) or name in names:
            return None
        names.add(name)
        if is_protagonist:
            protagonists.append(name)
        nodes.append({
            "name": name,
            "role_identity": role_identity,
            "faction": faction,
            "is_protagonist": is_protagonist,
        })
    if len(protagonists) != 1:
        return None

    relationships: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    for item in characters:
        source = _delivery_text(item.get("人物名称"))
        raw_relations = item.get("人物关系")
        if not isinstance(raw_relations, list):
            return None
        for relation in raw_relations:
            if not isinstance(relation, dict):
                return None
            target = _delivery_text(relation.get("关联人物"))
            label = _delivery_text(relation.get("关系"))
            if not target or not label or target == source or target not in names:
                return None
            pair = tuple(sorted((source, target)))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            relationships.append({"source": source, "target": target, "label": label})

    if len(nodes) > 1 and not relationships:
        return None
    return {
        "protagonist": protagonists[0],
        "characters": nodes,
        "relationships": relationships,
    }


def read_stage_file(project: sqlite3.Row, stage: str) -> dict:
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    workspace = resolve_workspace(project["workspace_dir"])
    file_name = stage_file_for_workspace(workspace, stage)
    progress = load_progress(project["workspace_dir"])
    stages = progress.get("stages")
    stage_progress = stages.get(stage) if isinstance(stages, dict) else None
    status_value = stage_progress.get("status", "pending") if isinstance(stage_progress, dict) else "pending"
    if isinstance(status_value, str) and status_value in ACTIVE_DELIVERY_STATUSES:
        result = {
            "stage": stage,
            "name": project_stage_label(project, stage),
            "file_name": file_name,
            "content": stage_placeholder_content(project, stage, status_value),
        }
        if stage == "world_view":
            result["world_view"] = {"世界观描述": "", "关键概念映射": []}
        if stage == "novel_analysis":
            result["novel_analysis"] = {
                "基础信息": {
                    "小说名称": "",
                    "小说梗概": "",
                    "题材": [],
                    "基调": "",
                },
                "核心卖点": "",
                "故事主线": "",
                "世界观": "",
                "关键人物": [],
                "剧情单元": [],
            }
        return result
    file_path = workspace / file_name
    if not file_path.exists():
        raise stage_file_missing_error(stage)
    content = file_path.read_text(encoding="utf-8")
    display_content = _display_script_episode_titles(workspace, stage, content)
    result = {
        "stage": stage,
        "name": project_stage_label(project, stage),
        "file_name": file_name,
        "content": display_content,
        "content_hash": sha256_text(content),
    }
    if stage == "foreign_review":
        scorecard_path = workspace / review_scorecard_file_for_workspace(workspace)
        if scorecard_path.exists():
            try:
                result["review_scorecard"] = public_review_scorecard(
                    json.loads(scorecard_path.read_text(encoding="utf-8"))
                )
            except json.JSONDecodeError:
                result["review_scorecard"] = None
    if stage == "world_view":
        result["world_view"] = world_view_payload_from_content(content)
    if stage == "outline_rewrite":
        try:
            outline = json.loads((workspace / "3.1-outline.json").read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            outline = {}
        if isinstance(outline, dict):
            title = str(outline.get("剧本名称") or "").strip()
            english_title = str(outline.get("英文剧本名称") or "").strip()
            title_confirmation = stage_progress.get("title_confirmation") if isinstance(stage_progress, dict) else None
            title_confirmed = (
                isinstance(title_confirmation, dict)
                and title_confirmation.get("status") == "confirmed"
                and str(title_confirmation.get("title") or "").strip() == title
                and str(title_confirmation.get("english_title") or "").strip() == english_title
            )
            result["outline_title"] = {
                "title": title,
                "english_title": english_title,
                "confirmed": title_confirmed,
            }
    if stage == "novel_analysis":
        result["novel_analysis"] = novel_analysis_payload_from_content(content)
    if stage == "character_rewrite":
        result["relationship_graph"] = character_relationship_graph_for_workspace(workspace)
    return result


def _stage_documents_for_title_sync(workspace: Path) -> dict[str, tuple[str, str]]:
    """Read visible title-bearing artifacts before a deterministic rename."""
    documents: dict[str, tuple[str, str]] = {}
    for stage in ("outline_rewrite", "full_generate", "dialogue_translate", "foreign_review"):
        relative_path = stage_file_for_workspace(workspace, stage)
        file_path = workspace / relative_path
        if file_path.is_file():
            documents[stage] = (
                str(file_path.relative_to(settings.agents_dir)),
                file_path.read_text(encoding="utf-8"),
            )
    return documents


def _run_script_title_rename(
    workspace: Path,
    *,
    title: str,
    english_title: str,
    updated_by: str,
) -> dict:
    command = [
        os.getenv("ORCA_NODE_PATH", "").strip() or "node",
        str(settings.agents_dir / ".claude/tools/rename-script-title.mjs"),
        "--workspace", _relative_workspace_dir(workspace),
        "--title", title,
        "--updated-by", updated_by,
    ]
    if english_title:
        command.extend(["--english-title", english_title])
    result = subprocess.run(
        command,
        cwd=settings.agents_dir,
        check=False,
        text=True,
        capture_output=True,
        timeout=60,
    )
    try:
        payload = parse_agent_json(result.stdout if result.returncode == 0 else result.stderr)
    except (ValueError, json.JSONDecodeError):
        payload = {}
    if result.returncode != 0 or payload.get("ok") is not True:
        tool_message = payload.get("message") if isinstance(payload.get("message"), str) else ""
        raise APIError(
            "SCRIPT_TITLE_SYNC_FAILED",
            message=tool_message.strip() or None,
            root_cause=result.stderr.strip() or result.stdout.strip(),
        )
    return payload


def rename_project_script_title(
    conn: sqlite3.Connection,
    *,
    project: sqlite3.Row,
    user: sqlite3.Row,
    title: str,
    english_title: str,
    expected_hash: str,
) -> dict:
    """Synchronize a confirmed outline title without creating semantic edits."""
    if row_task_type(project) not in {TASK_TYPE_REWRITE, TASK_TYPE_REPLICATE}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="剧本名称只能在剧本改写或爆款复刻项目的故事梗概中维护")
    if "status" in project.keys() and project["status"] == "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目已归档，请先重新开启")

    workspace = resolve_workspace(project["workspace_dir"])
    before_documents = _stage_documents_for_title_sync(workspace)
    outline_before = before_documents.get("outline_rewrite")
    if not outline_before:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="故事梗概尚未生成，暂时无法维护剧本名称")
    if expected_hash != sha256_text(outline_before[1]):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="故事梗概已被更新，请刷新后再确认剧本名称")

    try:
        outline = json.loads((workspace / "3.1-outline.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="剧本大纲资料无法读取，请重新生成故事梗概") from exc
    old_title = str(outline.get("剧本名称") or "").strip() if isinstance(outline, dict) else ""
    old_english_title = str(outline.get("英文剧本名称") or "").strip() if isinstance(outline, dict) else ""

    payload = _run_script_title_rename(
        workspace,
        title=title.strip(),
        english_title=english_title.strip(),
        updated_by=str(user["username"]),
    )
    after_documents = _stage_documents_for_title_sync(workspace)
    conn.execute("SAVEPOINT rename_project_script_title")
    try:
        conn.execute(
            "UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (title.strip(), project["id"]),
        )
        for stage, (old_path, old_content) in before_documents.items():
            current = after_documents.get(stage)
            if not current:
                continue
            new_path, new_content = current
            if old_path == new_path and old_content == new_content:
                continue
            record_file_version(
                conn,
                project_id=int(project["id"]),
                stage=stage,
                file_path=new_path,
                edited_by=int(user["id"]),
                content=new_content,
                previous_content=old_content,
                change_kind="metadata_sync",
                change_summary=f"同步剧本名称：{old_title} -> {title.strip()}",
                operation="manual_save",
            )
            conn.execute(
                """
                INSERT INTO artifact_changes (
                    project_id, stage, file_path, old_hash, new_hash, change_kind, impact_json, edited_by
                ) VALUES (?, ?, ?, ?, ?, 'metadata_sync', ?, ?)
                """,
                (
                    project["id"],
                    stage,
                    new_path,
                    sha256_text(old_content),
                    sha256_text(new_content),
                    json.dumps({"semantic_change": False, "summary": "同步剧本名称"}, ensure_ascii=False),
                    user["id"],
                ),
            )

        review_after = after_documents.get("foreign_review")
        if review_after:
            conn.execute(
                "UPDATE stage_approvals SET artifact_hash = ? WHERE project_id = ? AND stage = 'foreign_review'",
                (sha256_text(review_after[1]), project["id"]),
            )
        record_audit(
            conn,
            actor=user,
            action="project.script_title.rename",
            target_type="project",
            target_id=project["id"],
            target_label=title.strip(),
            project_id=int(project["id"]),
            details={
                "before": {"title": old_title, "english_title": old_english_title},
                "after": {"title": title.strip(), "english_title": english_title.strip()},
                "updated_files": payload.get("updated_files", []),
            },
        )
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT rename_project_script_title")
        conn.execute("RELEASE SAVEPOINT rename_project_script_title")
        try:
            _run_script_title_rename(
                workspace,
                title=old_title,
                english_title=old_english_title,
                updated_by=str(user["username"]),
            )
        except Exception:
            pass
        raise
    conn.execute("RELEASE SAVEPOINT rename_project_script_title")
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project["id"],)).fetchone()
    return {
        "project": project_row_to_public(row),
        "file": read_stage_file(row, "outline_rewrite"),
        "updated_files": payload.get("updated_files", []),
    }


MAX_FILE_VERSIONS_PER_FILE = 10


def _trim_file_versions(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    stage: str,
) -> None:
    """Keep only the most recent restorable snapshots for a project file."""
    conn.execute(
        """
        DELETE FROM file_versions
        WHERE project_id = ? AND stage = ? AND content_snapshot IS NOT NULL
          AND id NOT IN (
              SELECT id FROM file_versions
              WHERE project_id = ? AND stage = ? AND content_snapshot IS NOT NULL
              ORDER BY id DESC
              LIMIT ?
          )
        """,
        (project_id, stage, project_id, stage, MAX_FILE_VERSIONS_PER_FILE),
    )


def record_file_version(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    stage: str,
    file_path: str,
    edited_by: int,
    content: str,
    previous_content: str | None,
    change_kind: str,
    change_summary: str | None,
    operation: str,
    memory_revision: int | None = None,
    job_id: int | None = None,
    restored_from_version_id: int | None = None,
) -> int:
    """Persist a restorable snapshot for one visible, deterministic file change."""
    content_hash = sha256_text(content)
    previous_hash = sha256_text(previous_content) if previous_content is not None else None
    if previous_content is not None and previous_content != content:
        baseline = conn.execute(
            """
            SELECT id FROM file_versions
            WHERE project_id = ? AND stage = ? AND content_hash = ?
              AND content_snapshot IS NOT NULL
            ORDER BY id DESC LIMIT 1
            """,
            (project_id, stage, previous_hash),
        ).fetchone()
        if not baseline:
            conn.execute(
                """
                INSERT INTO file_versions (
                    project_id, stage, file_path, edited_by, content_hash, content_snapshot,
                    previous_content_hash, change_kind, change_summary, memory_revision, operation
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'baseline', ?, NULL, 'initial')
                """,
                (
                    project_id,
                    stage,
                    file_path,
                    edited_by,
                    previous_hash,
                    previous_content,
                    "版本管理启用时保留的内容",
                ),
            )
    conn.execute(
        """
        INSERT INTO file_versions (
            project_id, stage, file_path, edited_by, content_hash, content_snapshot,
            previous_content_hash, change_kind, change_summary, memory_revision,
            operation, job_id, restored_from_version_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            stage,
            file_path,
            edited_by,
            content_hash,
            content,
            previous_hash,
            change_kind,
            change_summary,
            memory_revision,
            operation,
            job_id,
            restored_from_version_id,
        ),
    )
    version_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    _trim_file_versions(conn, project_id=project_id, stage=stage)
    return version_id


def _ensure_current_file_version(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    stage: str,
) -> tuple[str, int]:
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = workspace / stage_file_for_workspace(workspace, stage)
    if not file_path.is_file():
        raise stage_file_missing_error(stage)
    content = file_path.read_text(encoding="utf-8")
    content_hash = sha256_text(content)
    current = conn.execute(
        """
        SELECT id FROM file_versions
        WHERE project_id = ? AND stage = ? AND content_hash = ?
          AND content_snapshot IS NOT NULL
        ORDER BY id DESC LIMIT 1
        """,
        (project["id"], stage, content_hash),
    ).fetchone()
    if current:
        return content_hash, int(current["id"])
    rel_path = str(file_path.relative_to(settings.agents_dir))
    version_id = record_file_version(
        conn,
        project_id=int(project["id"]),
        stage=stage,
        file_path=rel_path,
        edited_by=int(project["owner_user_id"]),
        content=content,
        previous_content=None,
        change_kind="baseline",
        change_summary="当前文件的初始版本",
        operation="initial",
    )
    return content_hash, version_id


def _public_version_timestamp(value: object) -> str:
    timestamp = str(value or "")
    if not timestamp:
        return timestamp
    if "T" in timestamp or timestamp.endswith("Z"):
        return timestamp
    return f"{timestamp.replace(' ', 'T')}Z"


def list_file_versions(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    stage: str,
) -> dict:
    current_hash, current_version_id = _ensure_current_file_version(conn, project, stage)
    rows = conn.execute(
        """
        SELECT file_versions.*, users.display_name AS editor_name
        FROM file_versions
        JOIN users ON users.id = file_versions.edited_by
        WHERE file_versions.project_id = ? AND file_versions.stage = ?
          AND file_versions.content_snapshot IS NOT NULL
        ORDER BY file_versions.id
        """,
        (project["id"], stage),
    ).fetchall()
    versions = []
    for version_number, row in enumerate(rows, start=1):
        is_current = int(row["id"]) == current_version_id
        versions.append({
            "id": int(row["id"]),
            "version_number": version_number,
            "operation": str(row["operation"] or "unknown"),
            "editor_name": str(row["editor_name"] or ""),
            "created_at": _public_version_timestamp(row["created_at"]),
            "change_summary": str(row["change_summary"] or ""),
            "is_current": is_current,
            "can_restore": row["content_hash"] != current_hash,
        })
    return {
        "stage": stage,
        "name": project_stage_label(project, stage),
        "current_content_hash": current_hash,
        "versions": list(reversed(versions)),
    }


def read_file_version(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    stage: str,
    version_id: int,
) -> dict:
    current_hash, current_version_id = _ensure_current_file_version(conn, project, stage)
    row = conn.execute(
        """
        SELECT file_versions.*, users.display_name AS editor_name
        FROM file_versions
        JOIN users ON users.id = file_versions.edited_by
        WHERE file_versions.id = ? AND file_versions.project_id = ? AND file_versions.stage = ?
          AND file_versions.content_snapshot IS NOT NULL
        """,
        (version_id, project["id"], stage),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该文件版本")
    return {
        "id": int(row["id"]),
        "stage": stage,
        "name": project_stage_label(project, stage),
        "file_name": Path(str(row["file_path"])).name,
        "content": str(row["content_snapshot"]),
        "operation": str(row["operation"] or "unknown"),
        "editor_name": str(row["editor_name"] or ""),
        "created_at": _public_version_timestamp(row["created_at"]),
        "change_summary": str(row["change_summary"] or ""),
        "is_current": int(row["id"]) == current_version_id,
        "can_restore": row["content_hash"] != current_hash,
    }


def restore_file_version(
    conn: sqlite3.Connection,
    project: sqlite3.Row | dict,
    user: sqlite3.Row | dict,
    stage: str,
    version_id: int,
    expected_hash: str,
) -> dict:
    if "status" in project.keys() and project["status"] == "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目已归档，请先重新开启")
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    if stage_delivery_in_progress(project, stage):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该文件正在生成，完成后再恢复版本")
    active_job = conn.execute(
        "SELECT id FROM agent_jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1",
        (project["id"],),
    ).fetchone()
    if active_job:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目正在处理内容，完成后再恢复版本")

    version = conn.execute(
        """
        SELECT * FROM file_versions
        WHERE id = ? AND project_id = ? AND stage = ? AND content_snapshot IS NOT NULL
        """,
        (version_id, project["id"], stage),
    ).fetchone()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到该文件版本")
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = workspace / stage_file_for_workspace(workspace, stage)
    if not file_path.is_file():
        raise stage_file_missing_error(stage)
    old_content = file_path.read_text(encoding="utf-8")
    old_hash = sha256_text(old_content)
    if expected_hash != old_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="文件已被其他操作更新，请刷新版本记录后再恢复",
        )
    restored_content = str(version["content_snapshot"])
    if restored_content == old_content:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="当前已是这个版本")
    if stage == "world_view":
        world_view_payload_from_content(restored_content)
    elif stage == "novel_analysis":
        novel_analysis_payload_from_content(restored_content)

    new_hash = sha256_text(restored_content)
    impact = analyze_markdown_change(old_content, restored_content)
    progress_path = workspace_progress_path(workspace)
    old_progress = progress_path.read_text(encoding="utf-8")
    rel_path = str(file_path.relative_to(settings.agents_dir))
    conn.execute("SAVEPOINT restore_file_version")
    try:
        file_path.write_text(restored_content, encoding="utf-8")
        mark_semantic_edit_in_progress(
            workspace,
            stage,
            workflow_stage_order(row_task_type(project), row_target_region(project)),
            impact,
            user["username"],
            previous_hash=old_hash,
            source_hash=new_hash,
        )
        restored_version_id = record_file_version(
            conn,
            project_id=int(project["id"]),
            stage=stage,
            file_path=rel_path,
            edited_by=int(user["id"]),
            content=restored_content,
            previous_content=old_content,
            change_kind=impact["change_kind"],
            change_summary=f"恢复到版本 V{version_id}",
            operation="restore",
            restored_from_version_id=version_id,
        )
        conn.execute(
            """
            INSERT INTO artifact_changes (
                project_id, stage, file_path, old_hash, new_hash, change_kind, impact_json, edited_by
            ) VALUES (?, ?, ?, ?, ?, 'version_restore', ?, ?)
            """,
            (
                project["id"],
                stage,
                rel_path,
                old_hash,
                new_hash,
                json.dumps({**impact, "restored_from_version_id": version_id}, ensure_ascii=False),
                user["id"],
            ),
        )
        conn.execute("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (project["id"],))
        record_audit(
            conn,
            actor=user,
            action="document.restore",
            target_type="project_document",
            target_id=f"{project['id']}:{stage}",
            target_label=project["name"],
            project_id=int(project["id"]),
            details={
                "stage": stage,
                "file_path": rel_path,
                "restored_from_version_id": version_id,
                "restored_version_id": restored_version_id,
                "before_hash": old_hash,
                "after_hash": new_hash,
                "sync_deferred": True,
            },
        )
    except Exception:
        file_path.write_text(old_content, encoding="utf-8")
        progress_path.write_text(old_progress, encoding="utf-8")
        conn.execute("ROLLBACK TO SAVEPOINT restore_file_version")
        conn.execute("RELEASE SAVEPOINT restore_file_version")
        raise
    conn.execute("RELEASE SAVEPOINT restore_file_version")
    result = read_stage_file(project, stage)
    result["memory"] = {
        "status": "pending_sync",
        "fresh": False,
        "impact": impact,
    }
    return result


def _delivery_text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _read_delivery_json(workspace: Path, file_name: str, label: str, delivery_name: str = "完本下载") -> dict | list:
    path = workspace / file_name
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{delivery_name}缺少{label}，请先完成对应步骤。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{label}无法解析，请重新生成后再下载。") from exc
    return value


def _delivery_character_english_names(outline: object, include_english_names: bool) -> dict[str, str]:
    if not include_english_names or not isinstance(outline, dict):
        return {}
    mappings = outline.get("关键角色名称映射")
    if not isinstance(mappings, list):
        return {}
    return {
        chinese_name: english_name
        for item in mappings
        if isinstance(item, dict)
        and (chinese_name := _delivery_text(item.get("中文名称")))
        and (english_name := _delivery_text(item.get("英文名称")))
    }


def _delivery_episode_titles(outline: object) -> dict[str, str]:
    """Return the user-facing title for each outline episode used by DOCX delivery."""
    if not isinstance(outline, dict):
        return {}

    groups: list[object] = []
    opening = outline.get("开篇")
    if isinstance(opening, dict):
        groups.append(opening.get("剧集"))
    for unit in outline.get("剧情单元", []):
        if isinstance(unit, dict):
            groups.append(unit.get("剧集"))

    titles: dict[str, str] = {}
    for episodes in groups:
        if not isinstance(episodes, list):
            continue
        for episode in episodes:
            if not isinstance(episode, dict):
                continue
            number = episode.get("集数")
            title = _delivery_text(episode.get("剧集名称"))
            if isinstance(number, int) and not isinstance(number, bool) and number > 0 and title:
                titles[str(number)] = title
    return titles


def _display_script_episode_titles(workspace: Path, stage: str, content: str) -> str:
    """Render outline episode names in user-facing script Markdown without mutating its source."""
    if stage not in EPISODE_TITLED_SCRIPT_STAGES:
        return content
    try:
        outline = json.loads((workspace / "3.1-outline.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return content
    titles = _delivery_episode_titles(outline)
    if not titles:
        return content

    def replace_heading(match: re.Match[str]) -> str:
        episode = match.group("episode")
        title = titles.get(episode)
        if _delivery_text(match.group("title")):
            return match.group(0)
        return f"## 第{episode}集：{title}" if title else match.group(0)

    return _SCRIPT_EPISODE_HEADING_RE.sub(replace_heading, content)


def _delivery_characters(value: object, *, english_names: dict[str, str]) -> list[dict]:
    if not isinstance(value, list):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="人物设定格式不正确，请重新生成人物设定后再下载。")

    characters: list[dict] = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"人物设定第 {index} 项格式不正确，请重新生成后再下载。")
        name = _delivery_text(item.get("人物名称"))
        if not name:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"人物设定第 {index} 项缺少人物名称，请补全后再下载。")

        # 旧项目只保存“形象、口吻、人物内核”等字段。它们继续使用原交付版式；
        # 以新画像专属字段区分，兼容曾单独改名“身份”的旧项目。
        current_portrait_keys = ("性别", "国籍", "年龄", "外貌", "穿着", "性格")
        if not any(key in item for key in current_portrait_keys):
            characters.append({
                "name": name,
                "appearance": _delivery_text(item.get("形象")),
                "voice": _delivery_text(item.get("口吻")),
                "core_need": _delivery_text(item.get("核心诉求")),
                "challenge": _delivery_text(item.get("人物难题")),
                "relationship_arc": _delivery_text(item.get("关系与弧光")),
            })
            continue

        profile = {
            "gender": _delivery_text(item.get("性别")),
            "nationality": _delivery_text(item.get("国籍")),
            "age": _delivery_text(item.get("年龄")),
            "identity": _delivery_text(item.get("身份")),
            "appearance": _delivery_text(item.get("外貌")),
            "attire": _delivery_text(item.get("穿着")),
            "personality": _delivery_text(item.get("性格")),
        }
        missing_profile = [key for key, item_value in profile.items() if not item_value]
        if missing_profile:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"人物设定第 {index} 项缺少人物形象信息，请补全后再下载。",
            )

        characters.append({
            "name": name,
            "english_name": english_names.get(name, ""),
            **profile,
        })

    if not characters:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="人物设定为空，请完成角色设定后再下载。")
    return characters


def _delivery_script_content(
    workspace: Path,
    script_stage: str,
    *,
    script_label: str,
) -> tuple[Path, str]:
    script_path = workspace / stage_file_for_workspace(workspace, script_stage)
    if not script_path.is_file():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{script_label}文件不存在，请重新生成后再下载。")
    try:
        script_content = script_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{script_label}无法读取，请重新生成后再下载。") from exc
    if not script_content.strip():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{script_label}为空，请重新生成后再下载。")
    return script_path, script_content


def _first_ten_episode_script_content(script_content: str) -> str:
    """Keep the document header and at most the first ten numbered episode sections."""
    headings = list(_DELIVERY_EPISODE_HEADING_RE.finditer(script_content))
    if len(headings) <= 10:
        return script_content
    return f"{script_content[:headings[10].start()].rstrip()}\n"


def _trial_dialogue_delivery(delivery: dict) -> dict:
    script = delivery.get("script")
    if not isinstance(script, dict):
        return delivery
    script_content = script.get("content")
    if not isinstance(script_content, str):
        return delivery
    trial_content = _first_ten_episode_script_content(script_content)
    return {
        **delivery,
        "script": {
            **script,
            "content": trial_content,
            "content_hash": sha256_text(trial_content),
        },
    }


def _optional_delivery_json(workspace: Path, file_name: str, label: str, delivery_name: str) -> dict | list | None:
    if not (workspace / file_name).is_file():
        return None
    return _read_delivery_json(workspace, file_name, label, delivery_name)


def _translated_synopsis_for_dialogue_delivery(workspace: Path, synopsis: str, delivery_name: str) -> str:
    """Return the verified target-language synopsis saved by dialogue translation."""
    if not synopsis:
        return ""
    manifest = _optional_delivery_json(
        workspace,
        DIALOGUE_TRANSLATION_MANIFEST_FILE,
        "台词翻译清单",
        delivery_name,
    )
    if not isinstance(manifest, dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="台词译稿缺少英文简介，请重新执行台词翻译后再下载。",
        )
    story_synopsis = manifest.get("story_synopsis")
    if not isinstance(story_synopsis, dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="台词译稿缺少英文简介，请重新执行台词翻译后再下载。",
        )
    if _delivery_text(story_synopsis.get("source_file")) != "3.1-outline.json":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="台词译稿的英文简介来源不正确，请重新执行台词翻译后再下载。",
        )
    if _delivery_text(story_synopsis.get("source_hash")) != sha256_text(synopsis):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="故事梗概已更新，英文简介需要重新翻译后再下载。",
        )
    translated_synopsis = _delivery_text(story_synopsis.get("translated_text"))
    if not translated_synopsis:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="台词译稿缺少英文简介，请重新执行台词翻译后再下载。",
        )
    return translated_synopsis


def _script_delivery_for_project(project: sqlite3.Row, script_stage: str) -> dict:
    """Return the verified inputs shared by rewritten-script delivery DOCX exports."""
    delivery_config = {
        "trial_generate": {
            "download_name": "试稿下载",
            "script_label": "剧本试稿",
            "title_fallback": "剧本试稿",
        },
        "full_generate": {
            "download_name": "完本下载",
            "script_label": "完整剧本",
            "title_fallback": "完整剧本",
        },
        "dialogue_translate": {
            "download_name": "台词译稿下载",
            "script_label": "台词译稿",
            "title_fallback": "台词译稿",
        },
    }.get(script_stage)
    if delivery_config is None:
        raise APIError("DELIVERY_STAGE_UNKNOWN")

    download_name = delivery_config["download_name"]
    script_label = delivery_config["script_label"]
    task_type = row_task_type(project)
    if task_type not in {TASK_TYPE_REWRITE, TASK_TYPE_NOVEL, TASK_TYPE_REPLICATE}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{download_name}仅适用于改编项目。")

    workspace = resolve_workspace(project["workspace_dir"])
    progress = load_progress(project["workspace_dir"])
    stages = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
    stage_progress = stages.get(script_stage) if isinstance(stages.get(script_stage), dict) else {}
    stage_status = stage_progress.get("status") if isinstance(stage_progress, dict) else "pending"
    if stage_status in ACTIVE_DELIVERY_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{script_label}正在生成，完成后可以下载{download_name.removesuffix('下载')}。")
    if task_type == TASK_TYPE_NOVEL:
        novel_analysis = _read_delivery_json(workspace, "2.1-novel-analysis.json", "小说解读", download_name)
        world_view = novel_analysis.get("世界观") if isinstance(novel_analysis, dict) else None
        if isinstance(world_view, str):
            world_view = {"世界观描述": world_view, "关键概念映射": []}
    else:
        world_view = _read_delivery_json(workspace, "2.1-world-view.json", "世界观资料", download_name)
    if not isinstance(world_view, dict):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="世界观资料格式不正确，请重新生成后再下载。")
    world_description = _delivery_text(world_view.get("世界观描述"))
    if not world_description:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="世界观资料缺少世界观描述，请补全后再下载。")

    outline = _read_delivery_json(workspace, "3.1-outline.json", "故事梗概", download_name)
    if not isinstance(outline, dict):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="故事梗概格式不正确，请重新生成后再下载。")
    title = _delivery_text(outline.get("剧本名称")) or _delivery_text(project["name"])
    synopsis = _delivery_text(outline.get("故事梗概"))
    if not synopsis:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="故事梗概缺少故事梗概内容，请补全后再下载。")
    translated_synopsis = (
        _translated_synopsis_for_dialogue_delivery(workspace, synopsis, download_name)
        if script_stage == "dialogue_translate"
        else ""
    )

    brief_snapshot = distribution_brief_for_project(project)
    brief = brief_snapshot["brief"]
    target_region = _delivery_text(brief_snapshot.get("target_region")) or _delivery_text(project["target_region"])
    english_names = _delivery_character_english_names(
        outline,
        target_region not in {"国内", "中国大陆", "China", "Mainland China"},
    )
    characters = _delivery_characters(
        _read_delivery_json(workspace, "4.1-character.json", "人物设定", download_name),
        english_names=english_names,
    )
    script_path, script_content = _delivery_script_content(
        workspace,
        script_stage,
        script_label=script_label,
    )

    target_countries = _clean_string_list(brief.get("target_countries"))
    episode_count = brief.get("target_episode_count")
    episode_count = episode_count if isinstance(episode_count, int) and not isinstance(episode_count, bool) else None

    delivery = {
        "title": title or delivery_config["title_fallback"],
        "script_info": {
            "target_region": target_region,
            "target_countries": target_countries,
            "episode_duration": _delivery_text(brief.get("episode_duration")),
            "target_episode_count": episode_count,
            "maturity_target": _delivery_text(brief.get("maturity_target")),
        },
        "world_view": world_description,
        "synopsis": synopsis,
        "characters": characters,
        "script": {
            "file_name": script_path.name,
            "content": script_content,
            "content_hash": sha256_text(script_content),
            "episode_titles": _delivery_episode_titles(outline),
        },
    }
    if script_stage == "dialogue_translate":
        delivery["translated_synopsis"] = translated_synopsis
    return delivery


def full_script_delivery_for_project(project: sqlite3.Row, *, scope: str = "full") -> dict:
    if scope not in {"full", "trial"}:
        raise ValueError(f"Unsupported full-script delivery scope: {scope}")
    delivery = _script_delivery_for_project(project, "full_generate")
    return _trial_dialogue_delivery(delivery) if scope == "trial" else delivery


def trial_script_delivery_for_project(project: sqlite3.Row) -> dict:
    workspace = resolve_workspace(project["workspace_dir"])
    progress = load_progress(project["workspace_dir"])
    if full_script_is_source_of_truth(project, workspace, progress):
        return full_script_delivery_for_project(project, scope="trial")
    return _script_delivery_for_project(project, "trial_generate")


def dialogue_script_delivery_for_project(project: sqlite3.Row, *, scope: str = "full") -> dict:
    """Build a delivery document for translated dialogue without requiring a rewrite workflow."""
    if scope not in {"full", "trial"}:
        raise ValueError(f"Unsupported dialogue delivery scope: {scope}")
    task_type = row_task_type(project)
    if task_type in {TASK_TYPE_REWRITE, TASK_TYPE_NOVEL, TASK_TYPE_REPLICATE}:
        delivery = _script_delivery_for_project(project, "dialogue_translate")
        return _trial_dialogue_delivery(delivery) if scope == "trial" else delivery
    if task_type != TASK_TYPE_TRANSLATE:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="台词译稿下载仅适用于改编或台词翻译项目。")

    download_name = "台词译稿下载"
    script_label = "台词译稿"
    workspace = resolve_workspace(project["workspace_dir"])
    progress = load_progress(project["workspace_dir"])
    stages = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
    stage_progress = stages.get("dialogue_translate") if isinstance(stages.get("dialogue_translate"), dict) else {}
    stage_status = stage_progress.get("status") if isinstance(stage_progress, dict) else "pending"
    if stage_status in ACTIVE_DELIVERY_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="台词译稿正在生成，完成后可以下载译稿。")

    script_path, script_content = _delivery_script_content(
        workspace,
        "dialogue_translate",
        script_label=script_label,
    )
    brief_snapshot = distribution_brief_for_project(project)
    brief = brief_snapshot["brief"]
    target_region = _delivery_text(brief_snapshot.get("target_region")) or _delivery_text(project["target_region"])

    outline = _optional_delivery_json(workspace, "3.1-outline.json", "故事梗概", download_name)
    if outline is not None and not isinstance(outline, dict):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="故事梗概格式不正确，请重新生成后再下载。")
    title = _delivery_text(outline.get("剧本名称")) if isinstance(outline, dict) else ""
    synopsis = _delivery_text(outline.get("故事梗概")) if isinstance(outline, dict) else ""
    translated_synopsis = _translated_synopsis_for_dialogue_delivery(workspace, synopsis, download_name)

    world_view = _optional_delivery_json(workspace, "2.1-world-view.json", "世界观资料", download_name)
    if world_view is not None and not isinstance(world_view, dict):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="世界观资料格式不正确，请重新生成后再下载。")
    world_description = _delivery_text(world_view.get("世界观描述")) if isinstance(world_view, dict) else ""

    raw_characters = _optional_delivery_json(workspace, "4.1-character.json", "人物设定", download_name)
    english_names = _delivery_character_english_names(
        outline,
        target_region not in {"国内", "中国大陆", "China", "Mainland China"},
    )
    characters = _delivery_characters(raw_characters, english_names=english_names) if raw_characters is not None else []

    target_countries = _clean_string_list(brief.get("target_countries"))
    episode_count = brief.get("target_episode_count")
    episode_count = episode_count if isinstance(episode_count, int) and not isinstance(episode_count, bool) else None
    delivery = {
        "title": title or _translation_script_title(workspace) or _delivery_text(project["name"]) or "台词译稿",
        "script_info": {
            "target_region": target_region,
            "target_countries": target_countries,
            "episode_duration": _delivery_text(brief.get("episode_duration")),
            "target_episode_count": episode_count,
            "maturity_target": _delivery_text(brief.get("maturity_target")),
        },
        "world_view": world_description,
        "synopsis": synopsis,
        "translated_synopsis": translated_synopsis,
        "characters": characters,
        "script": {
            "file_name": script_path.name,
            "content": script_content,
            "content_hash": sha256_text(script_content),
            "episode_titles": _delivery_episode_titles(outline),
        },
    }
    return _trial_dialogue_delivery(delivery) if scope == "trial" else delivery


def write_structured_stage_file(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user: sqlite3.Row,
    stage: str,
    content: str,
    *,
    parser,
    serializer,
    display_name: str,
    expected_hash: str | None = None,
) -> dict:
    payload = parser(content)
    normalized_content = serializer(payload)
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = workspace / stage_file_for_workspace(workspace, stage)
    old_content = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
    old_hash = sha256_text(old_content)
    if expected_hash and expected_hash != old_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{display_name}已被其他操作更新，请刷新后再保存，避免覆盖较新的内容。",
        )
    if old_content == normalized_content:
        return read_stage_file(project, stage)

    progress_path = workspace_progress_path(workspace)
    old_progress = progress_path.read_text(encoding="utf-8")
    impact = analyze_markdown_change(old_content, normalized_content)
    file_path.write_text(normalized_content, encoding="utf-8")
    try:
        mark_semantic_edit_in_progress(
            workspace,
            stage,
            workflow_stage_order(row_task_type(project), row_target_region(project)),
            impact,
            user["username"],
        )
        run_stage_validation(workspace, stage, user["username"], None)
        memory = sync_workspace_memory(
            workspace,
            actor=user["username"],
            reason=f"{stage}_manual_save",
            changed_file=stage_file_for_workspace(workspace, stage),
            old_hash=old_hash,
            impact=impact,
        )
    except Exception as exc:
        if old_content:
            file_path.write_text(old_content, encoding="utf-8")
        else:
            file_path.unlink(missing_ok=True)
        progress_path.write_text(old_progress, encoding="utf-8")
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"{display_name}保存已回滚：{exc}") from exc

    new_hash = sha256_text(normalized_content)
    rel_path = str(file_path.relative_to(settings.agents_dir))
    record_file_version(
        conn,
        project_id=int(project["id"]),
        stage=stage,
        file_path=rel_path,
        edited_by=int(user["id"]),
        content=normalized_content,
        previous_content=old_content,
        change_kind=impact["change_kind"],
        change_summary=impact["summary"],
        operation="manual_save",
        memory_revision=memory.get("revision"),
    )
    conn.execute(
        """
        INSERT INTO artifact_changes (
            project_id, stage, file_path, old_hash, new_hash, change_kind, impact_json, edited_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project["id"],
            stage,
            rel_path,
            old_hash,
            new_hash,
            impact["change_kind"],
            json.dumps(impact, ensure_ascii=False),
            user["id"],
        ),
    )
    conn.execute(
        "UPDATE projects SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (stage, project["id"]),
    )
    record_audit(
        conn,
        actor=user,
        action="document.edit",
        target_type="project_document",
        target_id=f"{project['id']}:{stage}",
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "stage": stage,
            "file_path": rel_path,
            "before_hash": old_hash,
            "after_hash": new_hash,
            "change_kind": impact["change_kind"],
            "change_summary": impact["summary"],
            "semantic_change": bool(impact.get("semantic_change")),
            "memory_revision": memory.get("revision"),
        },
    )
    result = read_stage_file(project, stage)
    result["memory"] = {
        "status": "fresh",
        "revision": memory.get("revision"),
        "impact": impact,
    }
    return result


def write_world_view_file(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user: sqlite3.Row,
    content: str,
    expected_hash: str | None = None,
) -> dict:
    return write_structured_stage_file(
        conn,
        project,
        user,
        "world_view",
        content,
        parser=world_view_payload_from_content,
        serializer=serialize_world_view_payload,
        display_name="世界观",
        expected_hash=expected_hash,
    )


def write_novel_analysis_file(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user: sqlite3.Row,
    content: str,
    expected_hash: str | None = None,
) -> dict:
    return write_structured_stage_file(
        conn,
        project,
        user,
        "novel_analysis",
        content,
        parser=novel_analysis_payload_from_content,
        serializer=serialize_novel_analysis_payload,
        display_name="小说解读",
        expected_hash=expected_hash,
    )


def write_stage_file(
    conn: sqlite3.Connection,
    project: sqlite3.Row,
    user: sqlite3.Row,
    stage: str,
    content: str,
    expected_hash: str | None = None,
) -> dict:
    if "status" in project.keys() and project["status"] == "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目已归档，请先重新开启")
    if stage not in STAGE_FILES:
        raise unknown_stage_error(stage)
    if stage_delivery_in_progress(project, stage):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该阶段正在生成，完成后再保存修改")
    if stage == "world_view":
        return write_world_view_file(conn, project, user, content, expected_hash)
    if stage == "novel_analysis":
        return write_novel_analysis_file(conn, project, user, content, expected_hash)
    workspace = resolve_workspace(project["workspace_dir"])
    file_path = workspace / stage_file_for_workspace(workspace, stage)
    if not file_path.exists():
        raise stage_file_missing_error(stage)
    old_content = file_path.read_text(encoding="utf-8")
    old_hash = sha256_text(old_content)
    if expected_hash and expected_hash != old_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="文档已被其他操作更新，请刷新后再保存，避免覆盖较新的内容",
        )
    if old_content == content:
        return read_stage_file(project, stage)
    new_hash = sha256_text(content)
    impact = analyze_markdown_change(old_content, content)
    progress_path = workspace_progress_path(workspace)
    old_progress = progress_path.read_text(encoding="utf-8")
    file_path.write_text(content, encoding="utf-8")
    try:
        if impact["semantic_change"]:
            mark_semantic_edit_in_progress(
                workspace,
                stage,
                workflow_stage_order(row_task_type(project), row_target_region(project)),
                impact,
                user["username"],
                previous_hash=old_hash,
                source_hash=new_hash,
            )
    except Exception as exc:
        file_path.write_text(old_content, encoding="utf-8")
        progress_path.write_text(old_progress, encoding="utf-8")
        raise HTTPException(status_code=500, detail=f"文档保存已回滚：阶段状态更新失败：{exc}") from exc
    rel_path = str(file_path.relative_to(settings.agents_dir))
    record_file_version(
        conn,
        project_id=int(project["id"]),
        stage=stage,
        file_path=rel_path,
        edited_by=int(user["id"]),
        content=content,
        previous_content=old_content,
        change_kind=impact["change_kind"],
        change_summary=impact["summary"],
        operation="manual_save",
    )
    conn.execute(
        """
        INSERT INTO artifact_changes (
            project_id, stage, file_path, old_hash, new_hash, change_kind, impact_json, edited_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project["id"],
            stage,
            rel_path,
            old_hash,
            new_hash,
            impact["change_kind"],
            json.dumps(impact, ensure_ascii=False),
            user["id"],
        ),
    )
    conn.execute("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (project["id"],))
    record_audit(
        conn,
        actor=user,
        action="document.edit",
        target_type="project_document",
        target_id=f"{project['id']}:{stage}",
        target_label=project["name"],
        project_id=int(project["id"]),
        details={
            "stage": stage,
            "file_path": rel_path,
            "before_hash": old_hash,
            "after_hash": new_hash,
            "change_kind": impact["change_kind"],
            "change_summary": impact["summary"],
            "semantic_change": bool(impact.get("semantic_change")),
            "memory_revision": None,
        },
    )
    result = read_stage_file(project, stage)
    result["memory"] = {
        "status": "pending_sync",
        "fresh": False,
        "impact": impact,
    }
    return result


def import_workspace(conn: sqlite3.Connection, workspace_dir: Path, owner_user_id: int) -> dict | None:
    progress_path = workspace_progress_path(workspace_dir)
    if not progress_path.exists():
        return None
    rel_workspace = _relative_workspace_dir(workspace_dir)
    if conn.execute("SELECT id FROM projects WHERE workspace_dir = ?", (rel_workspace,)).fetchone():
        return None
    progress = json.loads(progress_path.read_text(encoding="utf-8"))
    user_input = load_user_input(rel_workspace) or {}
    name = user_input.get("project", {}).get("project_name") or workspace_name_to_project_name(workspace_dir.name)
    target_region = user_input.get("project", {}).get("target_region")
    task_type = normalize_task_type(user_input.get("project", {}).get("task_type"))
    current_stage = progress.get("current_skill") or progress.get("current_stage", "project_init")
    updated_at = progress.get("audit", {}).get("updated_at")
    conn.execute(
        """
        INSERT INTO projects (
            owner_user_id, name, workspace_dir, target_region, task_type, current_stage,
            claude_session_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
        """,
        (
            owner_user_id,
            name,
            rel_workspace,
            target_region,
            task_type,
            current_stage,
            str(uuid.uuid4()),
            progress.get("audit", {}).get("created_at"),
            updated_at,
        ),
    )
    return {"workspace_dir": rel_workspace, "name": name}


def save_upload(upload: UploadFile, user_id: int, *, max_bytes: int | None = None) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in ALLOWED_UPLOAD_SUFFIXES:
        raise APIError("FILE_TYPE_UNSUPPORTED")
    user_upload_dir = settings.upload_dir / str(user_id)
    user_upload_dir.mkdir(parents=True, exist_ok=True)
    file_path = user_upload_dir / f"{uuid.uuid4().hex}{suffix}"
    written = 0
    try:
        with file_path.open("wb") as out:
            while chunk := upload.file.read(1024 * 1024):
                written += len(chunk)
                if max_bytes is not None and written > max_bytes:
                    raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="源文件超过允许大小")
                out.write(chunk)
    except Exception:
        file_path.unlink(missing_ok=True)
        raise
    return file_path


def project_name_for_upload(project_name: str, upload: UploadFile) -> str:
    explicit_name = (project_name or "").strip()
    if explicit_name:
        return explicit_name

    client_filename = (upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    filename_stem = Path(client_filename).stem.strip()
    if filename_stem:
        return filename_stem
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="项目名称不能为空")


def mark_workspace_task_type(workspace_dir: str, task_type: str) -> None:
    user_input_path = workspace_input_path(resolve_workspace(workspace_dir))
    if not user_input_path.exists():
        return
    payload = json.loads(user_input_path.read_text(encoding="utf-8"))
    payload.setdefault("project", {})["task_type"] = task_type
    user_input_path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def distribution_brief_command_args(distribution_brief: dict | None) -> list[str]:
    values = distribution_brief or {}
    flags = {
        "target_country": "--target-country",
        "target_locale": "--target-locale",
        "episode_duration": "--episode-duration",
        "target_episode_count": "--target-episode-count",
        "maturity_target": "--maturity-target",
        "theme": "--theme",
        "setting": "--setting",
        "background": "--background",
        "audience": "--audience",
    }
    result: list[str] = []
    for key, flag in flags.items():
        value = values.get(key)
        if value is None or not str(value).strip():
            continue
        serialized = ",".join(str(item).strip() for item in value if str(item).strip()) if isinstance(value, (list, tuple)) else str(value).strip()
        if serialized:
            result.extend([flag, serialized])
    return result


def project_init_command(
    *,
    project_name: str,
    source_path: Path,
    source_title: str,
    target_region: str,
    extra_requirements: str,
    username: str,
    distribution_brief: dict | None = None,
    task_type: str = TASK_TYPE_REWRITE,
) -> list[str]:
    command = [
        "npm",
        "run",
        "project:init",
        "--",
        "--project-name",
        project_name,
        "--source-file",
        str(source_path),
        "--source-title",
        source_title,
        "--target-region",
        target_region,
        "--created-by",
        username,
        "--task-type",
        task_type,
    ]
    if extra_requirements and extra_requirements.strip():
        command.extend(["--extra-requirements", extra_requirements.strip()])
    brief_values = dict(distribution_brief or {})
    if task_type not in CREATIVE_TASK_TYPES:
        for field in TAG_FIELDS:
            brief_values.pop(field, None)
    return command + distribution_brief_command_args(brief_values)


def review_prepare_command(
    *,
    project_name: str,
    source_path: Path,
    source_title: str,
    target_region: str,
    extra_requirements: str,
    username: str,
    distribution_brief: dict | None = None,
) -> list[str]:
    return project_init_command(
        project_name=project_name,
        source_path=source_path,
        source_title=source_title,
        target_region=target_region,
        extra_requirements=extra_requirements,
        username=username,
        distribution_brief=distribution_brief,
        task_type=TASK_TYPE_REVIEW,
    )


def prepare_review_workspace(workspace: Path, *, actor: str) -> None:
    """Treat the uploaded screenplay as the completed source for review-only jobs."""
    input_path = workspace_input_path(workspace)
    progress_path = workspace_progress_path(workspace)
    user_input = json.loads(input_path.read_text(encoding="utf-8"))
    progress = json.loads(progress_path.read_text(encoding="utf-8"))
    original_path = workspace / stage_file_for_workspace(workspace, "project_init")
    full_path = workspace / stage_file_for_workspace(workspace, "full_generate")
    original = original_path.read_text(encoding="utf-8") if original_path.is_file() else ""
    if not original.strip():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="待审剧本转换文件不存在，无法创建审核项目")
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_text(original, encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    stages = progress.setdefault("stages", {})
    stages["full_generate"] = {
        **(stages.get("full_generate") if isinstance(stages.get("full_generate"), dict) else {}),
        "status": "completed",
        "output_files": [stage_file_for_workspace(workspace, "full_generate")],
        "updated_at": now,
        "updated_by": actor,
    }
    brief_status = user_input.get("project", {}).get("distribution_brief", {}).get("status")
    if brief_status == "complete":
        progress["status"] = "ready_for_next_skill"
        progress["current_skill"] = "full_generate"
        progress["next_skill"] = "foreign_review"
        user_input["status"] = "full_generate:completed"
    progress["audit"] = {**progress.get("audit", {}), "updated_at": now, "updated_by": actor}
    user_input["audit"] = {**user_input.get("audit", {}), "updated_at": now, "updated_by": actor}
    _atomic_write_text(progress_path, f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n")
    _atomic_write_text(input_path, f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n")


def create_project_from_source_path(
    conn: sqlite3.Connection,
    *,
    user: sqlite3.Row,
    project_name: str,
    target_region: str,
    extra_requirements: str,
    task_type: str,
    source_path: Path,
    source_title: str,
    distribution_brief: dict | None = None,
) -> dict:
    extra_requirements = extra_requirements or ""
    task_type = normalize_task_type(task_type)
    if not source_path.is_file():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="源文件不存在")
    project_name = (project_name or "").strip() or Path(source_title).stem.strip()
    if not project_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="项目名称不能为空")
    distribution_brief = default_distribution_brief(target_region, distribution_brief, task_type=task_type)
    command = project_init_command(
        project_name=project_name,
        source_path=source_path,
        source_title=source_title or project_name,
        target_region=target_region,
        extra_requirements=extra_requirements,
        username=user["username"],
        distribution_brief=distribution_brief,
        task_type=task_type,
    )
    result = subprocess.run(
        command,
        cwd=settings.agents_dir,
        check=False,
        text=True,
        capture_output=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise tool_failure_error(
            "PROJECT_INIT_FAILED",
            root_cause=result.stderr.strip() or result.stdout.strip(),
        )
    try:
        payload = parse_agent_json(result.stdout)
        workspace_dir = Path(payload["workspace_dir"])
    except Exception as exc:
        raise APIError("AGENT_OUTPUT_UNREADABLE", root_cause=str(exc)) from exc
    rel_workspace = _relative_workspace_dir(workspace_dir)
    mark_workspace_task_type(rel_workspace, task_type)
    if task_type == TASK_TYPE_REVIEW:
        prepare_review_workspace(workspace_dir, actor=str(user["username"]))
    progress = load_progress(rel_workspace)
    existing = conn.execute("SELECT * FROM projects WHERE workspace_dir = ?", (rel_workspace,)).fetchone()
    if existing:
        if row_task_type(existing) != task_type:
            conn.execute("UPDATE projects SET task_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (task_type, existing["id"]))
            existing = conn.execute("SELECT * FROM projects WHERE id = ?", (existing["id"],)).fetchone()
        return project_row_to_public(existing)
    conn.execute(
        """
        INSERT INTO projects (
            owner_user_id, name, workspace_dir, target_region, task_type, current_stage, claude_session_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user["id"],
            project_name,
            rel_workspace,
            target_region,
            task_type,
            progress.get("current_skill") or progress.get("current_stage", "project_init"),
            str(uuid.uuid4()),
        ),
    )
    row = conn.execute("SELECT * FROM projects WHERE workspace_dir = ?", (rel_workspace,)).fetchone()
    initial_path = workspace_dir / stage_file_for_workspace(workspace_dir, "project_init")
    if initial_path.is_file():
        record_file_version(
            conn,
            project_id=int(row["id"]),
            stage="project_init",
            file_path=str(initial_path.relative_to(settings.agents_dir)),
            edited_by=int(user["id"]),
            content=initial_path.read_text(encoding="utf-8"),
            previous_content=None,
            change_kind="baseline",
            change_summary="创建项目时保留的原始版本",
            operation="initial",
        )
    return project_row_to_public(row)


def create_project_from_upload(
    conn: sqlite3.Connection,
    *,
    user: sqlite3.Row,
    project_name: str,
    target_region: str,
    extra_requirements: str,
    task_type: str,
    upload: UploadFile,
    distribution_brief: dict | None = None,
) -> dict:
    client_filename = (upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    source_title = Path(client_filename).stem.strip()
    project_name = project_name_for_upload(project_name, upload)
    source_path = save_upload(upload, user["id"])
    try:
        return create_project_from_source_path(
            conn,
            user=user,
            project_name=project_name,
            target_region=target_region,
            extra_requirements=extra_requirements,
            task_type=task_type,
            source_path=source_path,
            source_title=source_title or project_name,
            distribution_brief=distribution_brief,
        )
    finally:
        # project_init archives normal uploads under references/. Batch tasks
        # call create_project_from_source_path directly and retain their source
        # for retries, so this cleanup only applies to user-created projects.
        source_path.unlink(missing_ok=True)
        try:
            source_path.parent.rmdir()
        except OSError:
            pass
