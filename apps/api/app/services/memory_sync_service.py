from __future__ import annotations

import difflib
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, status

from app.core.config import settings


EPISODE_RE = re.compile(r"(?:第\s*(\d+)\s*[集章]|(?:EP(?:ISODE)?)[ ._-]*(\d+))", re.IGNORECASE)
CHARACTER_LABEL_RE = re.compile(r"^\s*([^#|\n：:]{1,32}?)(?:\s*[（(][^）)\n]{0,24}[）)])?\s*[：:]", re.MULTILINE)
STRUCTURAL_LABELS = {
    "场景", "地点", "时间", "人物", "动作", "镜头", "旁白", "画外音", "本集梗概", "本集功能",
    "开场钩子", "主要转折", "结尾钩子", "下一集承接", "原剧对应内容", "备注", "说明",
}

STAGE_ARTIFACTS = {
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

_NAMED_SCRIPT_ARTIFACTS = {
    "outline_rewrite": "故事梗概",
    "full_generate": "剧本全稿",
}

# These user-facing Markdown files have structured or staged source files
# behind them. A manual save is retained as the source of truth and synced
# only when the user continues the workflow.
DOCUMENT_SYNC_STAGES = frozenset({
    "outline_rewrite",
    "character_rewrite",
    "trial_generate",
    "full_generate",
    "dialogue_translate",
})

STAGE_VALIDATORS = {
    "novel_analysis": ".claude/skills/novel_analysis/scripts/check-novel-analysis.mjs",
    "world_view": ".claude/skills/world_view/scripts/check-world-view.mjs",
    "outline_rewrite": ".claude/skills/outline_rewrite/scripts/check-outline.mjs",
    "character_rewrite": ".claude/skills/character_rewrite/scripts/check-character.mjs",
    "trial_generate": ".claude/skills/trial_generate/scripts/check-trial.mjs",
    "full_generate": ".claude/skills/full_generate/scripts/check-full.mjs",
    "dialogue_translate": ".claude/skills/dialogue_translate/scripts/check-dialogue-translate.mjs",
    "foreign_review": ".claude/skills/foreign_review/scripts/check-foreign-review.mjs",
    "humanizer_zh": ".claude/skills/humanizer-zh/scripts/check-humanizer-zh.mjs",
}

APPROVAL_PROTECTED_FILES = (
    "01-user-input.json",
    "01-project-progress.json",
    "2.1-world-view.json",
    "02-故事梗概.md",
    "03-人物小传.md",
    "04-剧本试稿.md",
    "99-剧本稿.md",
    "99-审稿报告.md",
    "memory/review-scorecard.json",
)

QUALITY_CONTRACT_SCHEMA_VERSION = "approval-gates-v6"
QUALITY_CONTRACT_FILES = (
    ".claude/skills/_shared/lib/agent-contracts.mjs",
    ".claude/skills/_shared/lib/agent-utils.mjs",
    ".claude/skills/_shared/lib/stage-runner.mjs",
    ".claude/skills/_shared/lib/script-quality.mjs",
    ".claude/skills/_shared/lib/character-consistency.mjs",
    ".claude/skills/_shared/lib/character-context.mjs",
    ".claude/skills/_shared/lib/character-canon.mjs",
    ".claude/skills/_shared/lib/dialogue-review.mjs",
    ".claude/skills/_shared/lib/delivery-boundary.mjs",
    ".claude/skills/_shared/lib/narrative-context.mjs",
    ".claude/skills/_shared/lib/narrative-review.mjs",
    ".claude/skills/_shared/lib/outline-canon.mjs",
    ".claude/skills/_shared/lib/project-memory.mjs",
    ".claude/skills/_shared/lib/story-index.mjs",
    ".claude/skills/_shared/scripts/memory-tool.mjs",
    ".claude/skills/world_view/SKILL.md",
    ".claude/skills/world_view/scripts/init-world-view.mjs",
    ".claude/skills/world_view/scripts/validate-world-view.mjs",
    ".claude/skills/_shared/scripts/stage-execution-spec.mjs",
    ".claude/skills/outline_rewrite/SKILL.md",
    ".claude/skills/outline_rewrite/scripts/init-outline.mjs",
    ".claude/skills/outline_rewrite/scripts/get-execution-strategy.mjs",
    ".claude/skills/outline_rewrite/scripts/check-outline.mjs",
    ".claude/skills/character_rewrite/SKILL.md",
    ".claude/skills/character_rewrite/scripts/init-character.mjs",
    ".claude/skills/character_rewrite/scripts/get-execution-strategy.mjs",
    ".claude/skills/character_rewrite/scripts/check-character.mjs",
    ".claude/skills/trial_generate/SKILL.md",
    ".claude/skills/trial_generate/scripts/init-trial.mjs",
    ".claude/skills/trial_generate/scripts/get-execution-strategy.mjs",
    ".claude/skills/trial_generate/scripts/check-trial.mjs",
    ".claude/skills/full_generate/SKILL.md",
    ".claude/skills/full_generate/scripts/init-full.mjs",
    ".claude/skills/full_generate/scripts/get-execution-strategy.mjs",
    ".claude/skills/full_generate/scripts/check-full.mjs",
    ".claude/tools/get-strategy-formula.mjs",
    ".claude/skills/dialogue_translate/SKILL.md",
    ".claude/skills/foreign_review/SKILL.md",
    ".claude/skills/foreign_review/references/评分表.json5",
    ".claude/skills/foreign_review/scripts/foreign-review-utils.mjs",
    ".claude/skills/foreign_review/scripts/init-foreign-review.mjs",
    ".claude/skills/foreign_review/scripts/calculate-review-score.mjs",
    ".claude/skills/foreign_review/scripts/check-foreign-review.mjs",
    ".claude/skills/full_generate/scripts/full-draft-tool.mjs",
    ".claude/skills/_shared/schemas/foreign-review-score.schema.json",
    ".claude/skills/_shared/schemas/progress.schema.json",
)
QUALITY_CONTRACT_API_FILES = (
    "apps/api/app/services/agent_runner.py",
    "apps/api/app/services/workspace_service.py",
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stage_artifact_name(workspace: Path, stage: str) -> str | None:
    default_name = STAGE_ARTIFACTS.get(stage)
    suffix = _NAMED_SCRIPT_ARTIFACTS.get(stage)
    if not default_name or not suffix:
        return default_name
    try:
        outline = json.loads((workspace / "3.1-outline.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return default_name
    title = outline.get("剧本名称") if isinstance(outline, dict) else None
    if not isinstance(title, str) or not title.strip():
        return default_name
    file_title = re.sub(r"\s+", "-", title.strip())
    file_title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", file_title)[:80] or "未命名剧本"
    return f"output/{file_title}-{suffix}.md"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(file_path: Path) -> str:
    return hashlib.sha256(file_path.read_bytes()).hexdigest()


def current_quality_contract_version() -> str:
    """Fingerprint every executable validator that can affect an approval decision."""
    if (settings.agents_dir / ".claude/config/region-rules.json").is_file():
        return "agents-new-v1"
    digest = hashlib.sha256()
    digest.update(QUALITY_CONTRACT_SCHEMA_VERSION.encode("utf-8"))
    digest.update(b"\0apps/api/app/services/memory_sync_service.py\0")
    digest.update(Path(__file__).read_bytes())
    for relative_path in QUALITY_CONTRACT_FILES:
        file_path = settings.agents_dir / relative_path
        if not file_path.is_file():
            raise RuntimeError(f"质量契约文件缺失：{relative_path}")
        digest.update(b"\0")
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
    for relative_path in QUALITY_CONTRACT_API_FILES:
        file_path = settings.repo_root / relative_path
        if not file_path.is_file():
            raise RuntimeError(f"质量契约文件缺失：{relative_path}")
        digest.update(b"\0")
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
    return f"{QUALITY_CONTRACT_SCHEMA_VERSION}:{digest.hexdigest()}"


def _semantic_text(value: str) -> str:
    value = re.sub(r"<!--.*?-->", "", value, flags=re.DOTALL)
    value = re.sub(r"^\s*#{1,6}\s*", "", value, flags=re.MULTILINE)
    value = re.sub(r"[*_`>~-]", "", value)
    return re.sub(r"\s+", "", value)


def _changed_lines(before: str, after: str) -> tuple[list[str], list[str]]:
    removed: list[str] = []
    added: list[str] = []
    for line in difflib.ndiff(before.splitlines(), after.splitlines()):
        if line.startswith("- "):
            removed.append(line[2:])
        elif line.startswith("+ "):
            added.append(line[2:])
    return removed, added


def _nearest_episode(lines: list[str], index: int) -> int | None:
    for line in reversed(lines[: min(len(lines), index + 1)]):
        match = EPISODE_RE.search(line)
        if match:
            return int(match.group(1) or match.group(2))
    return None


def _changed_episode_context(before: str, after: str) -> list[int]:
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    result = []
    matcher = difflib.SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    for tag, before_start, _before_end, after_start, _after_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        for episode in (
            _nearest_episode(before_lines, before_start),
            _nearest_episode(after_lines, after_start),
        ):
            if episode is not None:
                result.append(episode)
    return sorted(set(result))


def _episodes(lines: list[str]) -> list[int]:
    result = []
    for line in lines:
        for match in EPISODE_RE.finditer(line):
            result.append(int(match.group(1) or match.group(2)))
    return sorted(set(result))


def _characters(lines: list[str]) -> list[str]:
    result = []
    for match in CHARACTER_LABEL_RE.finditer("\n".join(lines)):
        label = match.group(1).strip(" -*△>")
        if label and label not in STRUCTURAL_LABELS:
            result.append(label)
    return sorted(set(result))


def analyze_markdown_change(before: str, after: str) -> dict:
    removed, added = _changed_lines(before, after)
    # A quality gate binds exact bytes (not a lossy semantic projection).
    # Markdown hard breaks, heading levels and whitespace can change bilingual
    # rendering or parser output, so every actual file change invalidates prior
    # approval and downstream evidence.
    content_changed = before != after
    semantic_content_change = _semantic_text(before) != _semantic_text(after)
    semantic_change = content_changed
    impacted_episodes = sorted(set([*_episodes([*removed, *added]), *_changed_episode_context(before, after)]))
    impacted_characters = _characters([*removed, *added])
    kind = "semantic" if semantic_content_change else "formatting"
    added_samples = [line.strip()[:240] for line in added if line.strip()][:12]
    removed_samples = [line.strip()[:240] for line in removed if line.strip()][:12]
    return {
        "change_kind": kind,
        "semantic_change": semantic_change,
        "content_changed": content_changed,
        "formatting_only": content_changed and not semantic_content_change,
        "added_lines": len(added),
        "removed_lines": len(removed),
        "impacted_episodes": impacted_episodes,
        "impacted_characters": impacted_characters,
        "added_samples": added_samples,
        "removed_samples": removed_samples,
        "summary": (
            f"{kind} 修改：新增 {len(added)} 行，删除 {len(removed)} 行"
            + (f"；涉及集数 {impacted_episodes}" if impacted_episodes else "")
            + (f"；涉及角色 {impacted_characters}" if impacted_characters else "")
        ),
    }


def _parse_cli_json(stdout: str) -> dict:
    start = stdout.rfind("\n{")
    payload = stdout[start + 1 :] if start >= 0 else stdout
    return json.loads(payload)


def run_memory_tool(workspace: Path, command: str, *arguments: str, timeout: int = 120) -> dict:
    entrypoint = settings.agents_dir / ".claude/skills/_shared/scripts/memory-tool.mjs"
    process = subprocess.run(
        ["node", str(entrypoint), command, "--workspace", str(workspace), *arguments],
        cwd=settings.agents_dir,
        check=False,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or f"Memory {command} failed")
    return _parse_cli_json(process.stdout)


def get_memory_status(workspace: Path) -> dict:
    if (workspace / "1.2-project-progress.json").is_file():
        return {
            "initialized": False,
            "fresh": True,
            "stale_files": [],
            "missing_files": [],
            "new_files": [],
        }
    return run_memory_tool(workspace, "status", timeout=60)


def sync_workspace_memory(
    workspace: Path,
    *,
    actor: str,
    reason: str,
    changed_file: str | None = None,
    old_hash: str | None = None,
    impact: dict | None = None,
) -> dict:
    # 当前工作区不再使用旧版 Canon/Memory 同步。Skill 的结构化产物和
    # project-progress 已是唯一事实来源，保留一个稳定的 API 返回值即可。
    if (workspace / "1.2-project-progress.json").is_file():
        return {
            "initialized": False,
            "fresh": True,
            "stale_files": [],
            "missing_files": [],
            "new_files": [],
        }
    arguments = ["--actor", actor, "--reason", reason]
    if changed_file:
        arguments.extend(["--changed-file", changed_file])
    if old_hash:
        arguments.extend(["--old-hash", old_hash])
    if impact:
        arguments.extend(["--impact-json", json.dumps(impact, ensure_ascii=False)])
    return run_memory_tool(workspace, "sync", *arguments)


def document_sync_pending(stage_progress: object) -> bool:
    if not isinstance(stage_progress, dict):
        return False
    state = stage_progress.get("document_sync")
    return isinstance(state, dict) and state.get("status") == "pending"


def pending_document_sync_stages(
    workspace: Path,
    stage_order: list[str],
    through_stage: str | None = None,
) -> list[str]:
    """Return every saved user document that still needs a backend sync."""
    del through_stage
    try:
        progress = json.loads((workspace / "1.2-project-progress.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    stages = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
    return [
        stage
        for stage in stage_order
        if stage in DOCUMENT_SYNC_STAGES and document_sync_pending(stages.get(stage))
    ]


def mark_document_sync_completed(
    workspace: Path,
    stage: str,
    *,
    actor: str,
    job_id: int | str,
    artifact_hash: str,
    status_value: str | None = None,
    next_skill: str | None = None,
    update_workflow: bool = False,
) -> bool:
    """Keep the saved edit audit while clearing the one-shot sync marker."""
    progress_path = workspace / "1.2-project-progress.json"
    input_path = workspace / "1.1-user-input.json"
    try:
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    stages = progress.get("stages") if isinstance(progress.get("stages"), dict) else {}
    stage_progress = stages.get(stage)
    if not document_sync_pending(stage_progress):
        return False

    now = utc_now_iso()
    sync_state = dict(stage_progress["document_sync"])
    sync_state.update({
        "status": "synced",
        "synced_at": now,
        "synced_by": actor,
        "sync_job_id": str(job_id),
        "artifact_hash": artifact_hash,
    })
    stage_progress["document_sync"] = sync_state
    stage_progress.pop("revision_reason", None)
    stage_progress.pop("next_action", None)
    stage_progress.pop("last_error", None)
    if status_value:
        stage_progress["status"] = status_value
        if update_workflow:
            progress["status"] = "ready_for_next_skill" if status_value == "completed" and next_skill else f"{stage}:{status_value}"
            progress["current_skill"] = stage
            progress["next_skill"] = next_skill or ""
    progress["stages"] = stages
    progress["audit"] = {**progress.get("audit", {}), "updated_at": now, "updated_by": actor}
    progress_path.write_text(f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n", encoding="utf-8")

    if input_path.is_file():
        try:
            user_input = json.loads(input_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return True
        if status_value and update_workflow:
            user_input["status"] = f"{stage}:{status_value}"
        user_input["audit"] = {**user_input.get("audit", {}), "updated_at": now, "updated_by": actor}
        input_path.write_text(f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    return True


def mark_semantic_edit_in_progress(
    workspace: Path,
    stage: str,
    stage_order: list[str],
    impact: dict,
    actor: str,
    *,
    previous_hash: str | None = None,
    source_hash: str | None = None,
) -> None:
    # 手工保存的 Markdown 是用户当前事实。它只留下待同步标记，不能让
    # 其他阶段的已有文档或进度失效；显式重新生成时才会读取新的上游资料。
    new_progress_path = workspace / "1.2-project-progress.json"
    if new_progress_path.is_file():
        progress = json.loads(new_progress_path.read_text(encoding="utf-8"))
        input_path = workspace / "1.1-user-input.json"
        user_input = json.loads(input_path.read_text(encoding="utf-8")) if input_path.is_file() else {}
        now = utc_now_iso()
        stages = progress.setdefault("stages", {})
        stage_progress = stages.setdefault(stage, {})
        if stage in DOCUMENT_SYNC_STAGES:
            previous_sync = stage_progress.get("document_sync")
            changes = list(previous_sync.get("changes", [])) if isinstance(previous_sync, dict) else []
            status_before_sync = (
                previous_sync.get("status_before_sync")
                if isinstance(previous_sync, dict) and previous_sync.get("status_before_sync")
                else stage_progress.get("status")
            )
            changes.append({
                "previous_hash": previous_hash or "",
                "source_hash": source_hash or "",
                "saved_at": now,
                "saved_by": actor,
                "summary": impact.get("summary") or "用户修改了当前文档",
                "added_samples": impact.get("added_samples", []),
                "removed_samples": impact.get("removed_samples", []),
                "impacted_episodes": impact.get("impacted_episodes", []),
                "impacted_characters": impact.get("impacted_characters", []),
            })
            stage_progress["document_sync"] = {
                "status": "pending",
                "source_hash": source_hash or "",
                "saved_at": now,
                "saved_by": actor,
                "status_before_sync": status_before_sync or "",
                "changes": changes[-8:],
            }
            stage_progress.pop("quality_check", None)
        stage_progress.update({"updated_at": now, "updated_by": actor})
        if stage in DOCUMENT_SYNC_STAGES:
            stage_progress["next_action"] = "修改已保存，后续处理前会先更新后台资料。"
        progress["audit"] = {**progress.get("audit", {}), "updated_at": now, "updated_by": actor}
        user_input["audit"] = {**user_input.get("audit", {}), "updated_at": now, "updated_by": actor}
        new_progress_path.write_text(f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        if input_path.is_file():
            input_path.write_text(f"{json.dumps(user_input, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        return

    progress_path = workspace / "01-project-progress.json"
    progress = json.loads(progress_path.read_text(encoding="utf-8"))
    now = utc_now_iso()
    start_index = stage_order.index(stage)
    stage_progress = progress.setdefault("stages", {}).setdefault(stage, {})
    if stage != "project_init":
        # Any byte-level change can invalidate rendered bilingual lines, hashes
        # and downstream continuity. Never retain an earlier green gate after a
        # manual save; the current stage must re-enter the same managed check.
        stage_progress["status"] = "needs_revision"
        stage_progress["quality_check"] = {
            "passed": False,
            "checks": [],
            "warnings": ["本文件已修改，尚未重新完成内容检查。"],
        }
        stage_progress["summary"] = {}
        stage_progress["next_action"] = "修改已保存。请重新生成或使用 AI 修复，通过内容检查后再进入下一步。"
    stage_progress["updated_at"] = now
    stage_progress["updated_by"] = actor
    notes = stage_progress.get("notes") if isinstance(stage_progress.get("notes"), list) else []
    stage_progress["notes"] = [impact["summary"], *notes][:8]
    for downstream_stage in stage_order[start_index + 1 :]:
        downstream = progress["stages"].setdefault(downstream_stage, {})
        if downstream.get("status") in {"pending", "queued", "running", "in_progress"}:
            continue
        downstream["status"] = "stale"
        downstream["quality_check"] = {
            "passed": False,
            "checks": [],
            "warnings": ["上游内容已修改，需要重新生成或复核。"],
        }
        downstream["summary"] = {}
        downstream["updated_at"] = now
        downstream["updated_by"] = actor
        downstream["next_action"] = f"上游 {stage} 已发生内容修改，需重新生成或人工复核"
    progress["current_stage"] = stage
    progress["audit"] = {**progress.get("audit", {}), "updated_at": now, "updated_by": actor}
    progress_path.write_text(f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def _approval_conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _read_json_for_approval(file_path: Path, label: str) -> dict:
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _approval_conflict(f"{label}缺失或无法解析：{file_path.name}") from exc
    if not isinstance(payload, dict):
        raise _approval_conflict(f"{label}必须是 JSON 对象：{file_path.name}")
    return payload


def _workspace_file(workspace: Path, value: str, label: str) -> Path:
    if not value:
        raise _approval_conflict(f"{label}未记录文件路径")
    workspace_root = workspace.resolve()
    candidate = Path(value)
    candidate = candidate.resolve() if candidate.is_absolute() else (workspace_root / candidate).resolve()
    if not candidate.is_relative_to(workspace_root):
        raise _approval_conflict(f"{label}路径越界，不能用于审批")
    return candidate


def _safe_runtime_job_id(job_id: int | str | None) -> str | None:
    if job_id is None:
        return None
    value = str(job_id).strip()
    if not value or value in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", value):
        raise _approval_conflict("当前阶段的 job_id 非法，无法安全核验质量产物")
    return value


def _approval_workspace_files(workspace: Path) -> set[str]:
    files = set(APPROVAL_PROTECTED_FILES)
    memory_dir = workspace / "memory"
    if memory_dir.is_dir():
        files.update(str(item.relative_to(workspace)) for item in memory_dir.rglob("*") if item.is_file())
    return files


def _snapshot_approval_workspace(workspace: Path) -> dict[str, bytes | None]:
    return {
        relative_path: (workspace / relative_path).read_bytes()
        if (workspace / relative_path).is_file() else None
        for relative_path in _approval_workspace_files(workspace)
    }


def _restore_approval_workspace(workspace: Path, snapshot: dict[str, bytes | None]) -> None:
    current = _approval_workspace_files(workspace)
    for relative_path in current - set(snapshot):
        (workspace / relative_path).unlink(missing_ok=True)
    for relative_path, content in snapshot.items():
        target = workspace / relative_path
        if content is None:
            target.unlink(missing_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def _assert_canon_projection_current(workspace: Path, stage: str, artifact_path: Path) -> None:
    canon_name = {
        "outline_rewrite": "memory/outline-canon.json",
        "character_rewrite": "memory/character-canon.json",
    }.get(stage)
    if not canon_name:
        return
    canon_path = workspace / canon_name
    canon = _read_json_for_approval(canon_path, "系统 Canon")
    expected_hash = str(canon.get("public_document_hash") or "")
    if not expected_hash:
        raise _approval_conflict("系统 Canon 缺少用户交付哈希，不能用旧系统记录覆盖当前用户文件")
    if sha256_file(artifact_path) != expected_hash:
        raise _approval_conflict("用户文件已与系统 Canon 脱节，请通过对应阶段重新生成，不能在审批时用旧记录覆盖修改")


def _verify_script_quality_report(workspace: Path, stage: str, artifact_path: Path, validation: dict) -> dict:
    report_path = _workspace_file(
        workspace,
        str(validation.get("script_quality_report") or ""),
        "script-quality 报告",
    )
    report = _read_json_for_approval(report_path, "script-quality 报告")
    current_hash = sha256_file(artifact_path)
    if report.get("source_hash") != current_hash:
        raise _approval_conflict("本次 script-quality 报告与当前稿件哈希不一致，不能批准")
    report_status = report.get("status")
    # The stage validator has already decided whether this delivery can proceed.
    # Raw Markdown scan findings, including a scanner-level "failed", are kept
    # as review input and manual adjustment advice rather than reopening the
    # release gate during approval.
    if report_status not in {"passed", "review_required", "failed"}:
        raise _approval_conflict(f"当前稿件的 script-quality 报告状态无效：{report_status or 'unknown'}")
    if validation.get("script_quality_status") != report_status:
        raise _approval_conflict("validate 结果与 script-quality 报告状态不一致，不能批准")
    return report


def _runtime_job_file(workspace: Path, job_id: str, value: str, label: str) -> Path:
    candidate = _workspace_file(workspace, value, label)
    job_root = (workspace / "runtime" / "jobs" / job_id).resolve()
    if not candidate.is_relative_to(job_root):
        raise _approval_conflict(f"{label}必须位于当前生成任务的运行目录")
    return candidate


def _verify_direct_full_draft_record(
    workspace: Path,
    runtime_job_id: str,
    script_report: dict,
    record_path: Path,
) -> dict:
    """Verify the one-pass full-draft record used by current jobs.

    The legacy batch manifest remains verifiable for interrupted historical
    jobs. New jobs deliberately have no batch manifest, so their approval
    proof is the single generation record plus the one scene-review summary.
    """
    record = _read_json_for_approval(record_path, "完整剧本单篇运行记录")
    if record.get("workflow") != "direct_full_generation" or str(record.get("job_id")) != runtime_job_id:
        raise _approval_conflict("完整剧本单篇运行记录不属于当前 Job")

    script_path = workspace / "99-剧本稿.md"
    script_hash = sha256_file(script_path)
    if script_report.get("source_hash") != script_hash:
        raise _approval_conflict("完整剧本质量报告与当前用户文件哈希不一致，不能批准")

    expected_candidate = f"runtime/jobs/{runtime_job_id}/candidate/99-剧本稿.md"
    candidate_path = _runtime_job_file(
        workspace,
        runtime_job_id,
        str(record.get("candidate_output_file") or ""),
        "完整剧本候选正文",
    )
    if (
        str(record.get("candidate_output_file") or "") != expected_candidate
        or not candidate_path.is_file()
        or sha256_file(candidate_path) != script_hash
    ):
        raise _approval_conflict("完整剧本候选正文与当前用户文件不一致，不能批准")
    if (
        record.get("system_status") != "passed"
        or record.get("final_candidate_hash") != script_hash
        or record.get("published_output_file") != "99-剧本稿.md"
        or record.get("published_output_hash") != script_hash
    ):
        raise _approval_conflict("完整剧本单篇运行记录尚未完成当前正文的系统准出")

    source_hashes = record.get("source_hashes") if isinstance(record.get("source_hashes"), dict) else {}
    source_files = (
        ("outline", "memory/outline-canon.json", True),
        ("character", "memory/character-canon.json", True),
        ("character_state", "memory/character-state.jsonl", False),
        ("trial", "04-剧本试稿.md", True),
    )
    for source_name, source_file, required in source_files:
        current_path = workspace / source_file
        if required and not current_path.is_file():
            raise _approval_conflict(f"完整剧本绑定的{source_file}已缺失，必须重新生成完整剧本")
        current_hash = sha256_file(current_path) if current_path.is_file() else hashlib.sha256(b"").hexdigest()
        if source_hashes.get(source_name) != current_hash:
            raise _approval_conflict(f"完整剧本绑定的{source_file}已变更，必须重新生成完整剧本")
    character_quality = record.get("character_canon_quality")
    if not isinstance(character_quality, dict) or character_quality.get("status") != "passed":
        raise _approval_conflict("完整剧本单篇运行记录未通过当前人物 Canon 完整性契约")

    input_contract = record.get("input_contract") if isinstance(record.get("input_contract"), dict) else {}
    target_episode_count = input_contract.get("target_episode_count")
    if not isinstance(target_episode_count, int) or target_episode_count < 1:
        raise _approval_conflict("完整剧本单篇运行记录缺少有效的目标集数")
    script_summary = script_report.get("summary") if isinstance(script_report.get("summary"), dict) else {}
    if script_summary.get("unique_episode_count") != target_episode_count:
        raise _approval_conflict("完整剧本集数与单篇运行记录不一致，不能批准")

    framework = record.get("framework") if isinstance(record.get("framework"), dict) else {}
    framework_path = _runtime_job_file(
        workspace,
        runtime_job_id,
        str(framework.get("report_file") or ""),
        "完整剧本大框架报告",
    )
    framework_report = _read_json_for_approval(framework_path, "完整剧本大框架报告")
    expected_episodes = list(range(1, target_episode_count + 1))
    if (
        framework.get("status") != "passed"
        or framework.get("source_hash") != script_hash
        or framework.get("report_hash") != sha256_file(framework_path)
        or framework.get("hard_issue_count") != 0
        or framework_report.get("status") != "passed"
        or framework_report.get("source_hash") != script_hash
        or framework_report.get("expected_episode_count") != target_episode_count
        or framework_report.get("observed_episodes") != expected_episodes
        or framework_report.get("hard_issues") != []
    ):
        raise _approval_conflict("完整剧本大框架报告未通过或未绑定当前正文")

    review = record.get("review") if isinstance(record.get("review"), dict) else {}
    review_summary_path = _runtime_job_file(
        workspace,
        runtime_job_id,
        str(review.get("review_summary_file") or ""),
        "完整剧本场景审读汇总",
    )
    review_summary = _read_json_for_approval(review_summary_path, "完整剧本场景审读汇总")
    initial_hash = str(review.get("initial_source_hash") or "")
    review_chunks = review_summary.get("review_chunks")
    if (
        review.get("status") != "completed"
        or review.get("review_summary_hash") != sha256_file(review_summary_path)
        or not initial_hash
        or review_summary.get("source_hash") != initial_hash
        or not isinstance(review_chunks, list)
        or not review_chunks
        or not isinstance(review_summary.get("repair_required"), bool)
        or review.get("issue_count") != review_summary.get("issue_count")
    ):
        raise _approval_conflict("完整剧本场景审读汇总不完整或未绑定首次全文版本")
    for chunk in review_chunks:
        if not isinstance(chunk, dict):
            raise _approval_conflict("完整剧本场景审读汇总包含无效记录")
        review_file = _runtime_job_file(
            workspace,
            runtime_job_id,
            str(chunk.get("review_file") or ""),
            "完整剧本场景审读记录",
        )
        review_record = _read_json_for_approval(review_file, "完整剧本场景审读记录")
        if (
            not str(chunk.get("id") or "")
            or chunk.get("source_hash") != initial_hash
            or chunk.get("review_hash") != sha256_file(review_file)
            or review_record.get("review_id") != chunk.get("id")
            or review_record.get("source_hash") != initial_hash
            or review_record.get("range") != chunk.get("range")
            or review_record.get("status") != chunk.get("status")
            or review_record.get("status") not in {"passed", "needs_repair"}
        ):
            raise _approval_conflict("完整剧本场景审读记录与汇总不一致")

    repair = record.get("repair") if isinstance(record.get("repair"), dict) else {}
    repair_required = review_summary["repair_required"]
    attempts = repair.get("attempts")
    if repair.get("max_attempts") != 1 or attempts not in {0, 1}:
        raise _approval_conflict("完整剧本定向修订次数记录无效")
    if repair_required:
        repair_path = _runtime_job_file(
            workspace,
            runtime_job_id,
            str(repair.get("repair_brief_file") or ""),
            "完整剧本定向修订问题单",
        )
        repair_brief = _read_json_for_approval(repair_path, "完整剧本定向修订问题单")
        if (
            attempts != 1
            or repair.get("status") != "completed"
            or script_hash == initial_hash
            or repair_brief.get("source_hash") != initial_hash
            or repair_brief.get("allowed_file") != expected_candidate
        ):
            raise _approval_conflict("完整剧本没有按首次场景审读问题单完成唯一一次定向修订")
    elif attempts != 0 or repair.get("status") != "not_needed" or script_hash != initial_hash:
        raise _approval_conflict("完整剧本审读后正文或定向修订记录不一致")

    provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
    provenance_path = _runtime_job_file(
        workspace,
        runtime_job_id,
        str(provenance.get("report_file") or ""),
        "完整剧本生成来源报告",
    )
    provenance_report = _read_json_for_approval(provenance_path, "完整剧本生成来源报告")
    if (
        provenance.get("status") != "passed"
        or provenance.get("report_hash") != sha256_file(provenance_path)
        or provenance_report.get("status") != "passed"
        or str(provenance_report.get("job_id")) != runtime_job_id
        or provenance_report.get("violations") != []
    ):
        raise _approval_conflict("完整剧本未通过生成来源审计或审计记录不完整")
    return record


def _verify_full_draft_manifest(workspace: Path, job_id: int | str | None, script_report: dict) -> dict:
    runtime_job_id = _safe_runtime_job_id(job_id)
    if not runtime_job_id:
        raise _approval_conflict("完整剧本审批缺少原生成 Job，无法核验运行记录与正文哈希")
    direct_record_path = workspace / "runtime" / "jobs" / runtime_job_id / "full-generation.json"
    if direct_record_path.is_file():
        return _verify_direct_full_draft_record(workspace, runtime_job_id, script_report, direct_record_path)
    manifest_path = workspace / "runtime" / "jobs" / runtime_job_id / "full-batches" / "manifest.json"
    manifest = _read_json_for_approval(manifest_path, "full-draft manifest")
    if str(manifest.get("job_id")) != runtime_job_id:
        raise _approval_conflict("full-draft manifest 不属于当前 Job")
    if (
        manifest.get("output_file") != "99-剧本稿.md"
        or not manifest.get("assembled_at")
        or manifest.get("workflow_status") != "assembled"
    ):
        raise _approval_conflict("当前 Job 尚未通过 full-draft assemble，不能批准完整剧本")
    # New candidate-based runs are promoted by the runner only after the exact
    # assembled candidate has been staged at the public path. Older direct
    # assemblies remain readable, while any recorded promotion must prove that
    # the delivered file is the one the manifest audited.
    published_file = manifest.get("published_output_file")
    published_hash = manifest.get("published_output_hash")
    if published_file is not None or published_hash is not None:
        if published_file != "99-剧本稿.md" or published_hash != sha256_file(workspace / "99-剧本稿.md"):
            raise _approval_conflict("full-draft manifest 的已发布正文哈希与当前完整剧本不一致，不能批准")
        candidate_file = str(manifest.get("candidate_output_file") or "")
        candidate_hash = str(manifest.get("candidate_output_hash") or "")
        candidate_path = _workspace_file(workspace, candidate_file, "full-draft 候选正文")
        if not candidate_path.is_file() or sha256_file(candidate_path) != candidate_hash or candidate_hash != published_hash:
            raise _approval_conflict("full-draft 候选正文与已发布完整剧本不一致，不能批准")

    provenance_path = _workspace_file(
        workspace,
        str(manifest.get("generation_provenance_report") or ""),
        "全稿生成来源报告",
    )
    provenance = _read_json_for_approval(provenance_path, "全稿生成来源报告")
    if (
        manifest.get("generation_provenance_status") != "passed"
        or provenance.get("status") != "passed"
        or str(provenance.get("job_id")) != runtime_job_id
        or provenance.get("violations") != []
        or manifest.get("generation_provenance_report_hash") != sha256_file(provenance_path)
    ):
        raise _approval_conflict("当前完整剧本未通过生成来源审计，检测到脚本化批量写作或审计记录不完整")

    source_hashes = manifest.get("source_hashes") if isinstance(manifest.get("source_hashes"), dict) else {}
    character_canon_quality = (
        manifest.get("character_canon_quality")
        if isinstance(manifest.get("character_canon_quality"), dict)
        else {}
    )
    if character_canon_quality.get("status") != "passed":
        raise _approval_conflict("full-draft manifest 未通过当前人物 Canon 完整性契约")
    source_files = (
        ("outline", "memory/outline-canon.json", True),
        ("character", "memory/character-canon.json", True),
        ("character_state", "memory/character-state.jsonl", False),
        ("trial", "04-剧本试稿.md", True),
    )
    for source_name, source_file, required in source_files:
        current_path = workspace / source_file
        if required and not current_path.is_file():
            raise _approval_conflict(f"full-draft manifest 绑定的{source_file}已缺失，必须用新 Job 重建分批")
        current_hash = sha256_file(current_path) if current_path.is_file() else hashlib.sha256(b"").hexdigest()
        if source_hashes.get(source_name) != current_hash:
            raise _approval_conflict(f"full-draft manifest 绑定的{source_file}已变更，必须用新 Job 重建分批")

    batches = manifest.get("batches")
    if not isinstance(batches, list) or not batches:
        raise _approval_conflict("full-draft manifest 没有可核验的分批记录")
    if any(not isinstance(item, dict) or not isinstance(item.get("start"), int) for item in batches):
        raise _approval_conflict("full-draft manifest 包含非法分批记录")
    ordered_batches = sorted(batches, key=lambda item: item["start"])
    expected_start = 1
    for batch in ordered_batches:
        if not isinstance(batch, dict):
            raise _approval_conflict("full-draft manifest 包含非法分批记录")
        start = batch.get("start")
        end = batch.get("end")
        if not isinstance(start, int) or not isinstance(end, int) or start != expected_start or end < start:
            raise _approval_conflict("full-draft manifest 的分批范围不连续")
        expected_start = end + 1
        if batch.get("status") not in {"passed", "seeded_from_approved_trial"}:
            raise _approval_conflict(f"分批 {start}-{end} 未通过质量校验")
        batch_path = _workspace_file(workspace, str(batch.get("file") or ""), f"分批 {start}-{end}")
        if not batch_path.is_file() or batch.get("source_hash") != sha256_file(batch_path):
            raise _approval_conflict(f"分批 {start}-{end} 在 validate 后发生变更，必须重新校验")
        if batch.get("status") == "passed":
            quality_path = _workspace_file(
                workspace,
                str(batch.get("quality_report") or ""),
                f"分批 {start}-{end} 质量报告",
            )
            quality = _read_json_for_approval(quality_path, f"分批 {start}-{end} 质量报告")
            expected_episodes = list(range(start, end + 1))
            canon_access = batch.get("canon_access") if isinstance(batch.get("canon_access"), dict) else {}
            report_canon_access = quality.get("canon_access") if isinstance(quality.get("canon_access"), dict) else {}
            expected_canon_access = {
                "source_file": "memory/outline-canon.json",
                "source_hash": source_hashes.get("outline"),
                "accessed_episodes": expected_episodes,
            }
            for key, expected_value in expected_canon_access.items():
                if canon_access.get(key) != expected_value or report_canon_access.get(key) != expected_value:
                    raise _approval_conflict(f"分批 {start}-{end} 未绑定当前梗概且完整覆盖同集 Canon 读取")
            canon_log = _workspace_file(
                workspace,
                str(canon_access.get("access_log") or ""),
                f"分批 {start}-{end} Canon 访问日志",
            )
            if not canon_log.is_file() or report_canon_access.get("access_log") != canon_access.get("access_log"):
                raise _approval_conflict(f"分批 {start}-{end} Canon 访问日志缺失或记录不一致")

            character_context = batch.get("character_context") if isinstance(batch.get("character_context"), dict) else {}
            report_character_context = quality.get("character_context") if isinstance(quality.get("character_context"), dict) else {}
            expected_character_hashes = {
                "memory/outline-canon.json": source_hashes.get("outline"),
                "memory/character-canon.json": source_hashes.get("character"),
                "memory/character-state.jsonl": source_hashes.get("character_state"),
            }
            expected_range = {"start": start, "end": end}
            if (
                character_context.get("source_hashes") != expected_character_hashes
                or report_character_context.get("source_hashes") != expected_character_hashes
                or character_context.get("episode_range") != expected_range
                or report_character_context.get("episode_range") != expected_range
                or not isinstance(character_context.get("character_count"), int)
                or character_context.get("character_count", 0) < 1
                or report_character_context.get("character_count") != character_context.get("character_count")
                or not isinstance(character_context.get("canon_quality"), dict)
                or character_context.get("canon_quality", {}).get("status") != "passed"
                or report_character_context.get("canon_quality") != character_context.get("canon_quality")
            ):
                raise _approval_conflict(f"分批 {start}-{end} 未绑定当前人物 Canon 与该集范围")
            character_log = _workspace_file(
                workspace,
                str(character_context.get("access_log") or ""),
                f"分批 {start}-{end} 人物 Canon 访问日志",
            )
            if not character_log.is_file() or report_character_context.get("access_log") != character_context.get("access_log"):
                raise _approval_conflict(f"分批 {start}-{end} 人物 Canon 访问日志缺失或记录不一致")
            batch_quality = quality.get("batch_quality") if isinstance(quality.get("batch_quality"), dict) else {}
            cumulative_quality = quality.get("cumulative_quality") if isinstance(quality.get("cumulative_quality"), dict) else {}
            if (
                quality.get("status") != "passed"
                or quality.get("batch_range") != {"start": start, "end": end}
                or batch_quality.get("source_hash") != batch.get("source_hash")
                or batch_quality.get("status") != "passed"
                or cumulative_quality.get("status") != "passed"
            ):
                raise _approval_conflict(f"分批 {start}-{end} 质量报告缺失、未通过或与正文哈希不一致")

    total_episodes = manifest.get("total_episodes")
    if expected_start - 1 != total_episodes:
        raise _approval_conflict("full-draft manifest 的分批未完整覆盖目标集数")
    scanned_episode_count = script_report.get("summary", {}).get("unique_episode_count")
    if scanned_episode_count != total_episodes:
        raise _approval_conflict("full-draft manifest 集数与当前全稿扫描结果不一致")

    assembled_path = _workspace_file(
        workspace,
        str(manifest.get("assembled_quality_report") or ""),
        "full-draft 汇总质量报告",
    )
    assembled = _read_json_for_approval(assembled_path, "full-draft 汇总质量报告")
    if assembled.get("status") != "passed" or assembled.get("source_hash") != script_report.get("source_hash"):
        raise _approval_conflict("full-draft 汇总质量报告未通过或与当前 99-剧本稿.md 不一致")
    return manifest


def run_stage_validation(
    workspace: Path,
    stage: str,
    actor: str,
    job_id: int | str | None,
    *,
    timeout: int = 300,
) -> dict:
    validator = STAGE_VALIDATORS.get(stage)
    artifact_name = stage_artifact_name(workspace, stage)
    if not validator or not artifact_name:
        raise _approval_conflict(f"阶段 {stage} 没有可执行的审批质量门禁")
    entrypoint = settings.agents_dir / validator
    if not entrypoint.is_file():
        raise RuntimeError(f"阶段校验脚本缺失：{validator}")

    if (workspace / "1.2-project-progress.json").is_file():
        process = subprocess.run(
            ["node", str(entrypoint), "--workspace", str(workspace), "--updated-by", actor],
            cwd=settings.agents_dir,
            check=False,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        if process.returncode != 0:
            detail = (process.stderr.strip() or process.stdout.strip() or f"{stage} check failed")[-2000:]
            raise _approval_conflict(f"阶段检查未通过：{detail}")
        try:
            result = _parse_cli_json(process.stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise RuntimeError(f"无法解析 {stage} check 结果") from exc
        if result.get("ok") is not True:
            raise _approval_conflict(f"阶段 {stage} 检查未通过")
        return result

    command = ["node", str(entrypoint), "--workspace", str(workspace), "--updated-by", actor]
    runtime_job_id = _safe_runtime_job_id(job_id)
    if runtime_job_id:
        command.extend(["--job-id", runtime_job_id])
    try:
        process = subprocess.run(
            command,
            cwd=settings.agents_dir,
            check=False,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise _approval_conflict(f"阶段 {stage} 质量复核超时，未执行批准") from exc
    if process.returncode != 0:
        message = (process.stderr.strip() or process.stdout.strip() or f"{stage} validate failed")[-2000:]
        raise _approval_conflict(f"阶段实时质量复核失败：{message}")
    try:
        result = _parse_cli_json(process.stdout)
    except (json.JSONDecodeError, TypeError) as exc:
        raise RuntimeError(f"无法解析 {stage} validate 结果") from exc
    quality_check = result.get("quality_check") if isinstance(result.get("quality_check"), dict) else {}
    if result.get("status") != "draft_ready" or quality_check.get("passed") is not True:
        warnings = quality_check.get("warnings") if isinstance(quality_check.get("warnings"), list) else []
        detail = "；".join(str(item) for item in warnings[:5]) or result.get("next_action") or "质量门禁未通过"
        raise _approval_conflict(f"阶段 {stage} 实时复核未通过：{detail}")

    if stage in {"trial_generate", "full_generate"}:
        script_report = _verify_script_quality_report(workspace, stage, workspace / artifact_name, result)
        if stage == "full_generate":
            _verify_full_draft_manifest(workspace, runtime_job_id, script_report)
    return result


def approve_stage_memory(
    workspace: Path,
    stage: str,
    actor: str,
    job_id: int | str | None,
    *,
    expected_artifact_hash: str | None = None,
    commit_delta: bool = True,
) -> dict:
    progress_path = workspace / "01-project-progress.json"
    artifact_name = stage_artifact_name(workspace, stage)
    if not artifact_name:
        raise _approval_conflict(f"阶段 {stage} 不支持审批")
    artifact_path = workspace / artifact_name
    if not artifact_path.is_file():
        raise _approval_conflict(f"阶段产物不存在：{artifact_name}")

    progress = _read_json_for_approval(progress_path, "项目进度")
    stage_progress = progress.get("stages", {}).get(stage, {})
    if stage_progress.get("status") not in {"draft_ready", "approved"}:
        raise _approval_conflict(f"当前阶段状态为 {stage_progress.get('status', 'unknown')}，不能批准")
    initial_hash = sha256_file(artifact_path)
    if expected_artifact_hash and expected_artifact_hash != initial_hash:
        raise _approval_conflict("文档内容已变化，请刷新后重新确认")

    initial_summary = stage_progress.get("summary") if isinstance(stage_progress.get("summary"), dict) else {}
    initial_job_id = job_id or initial_summary.get("memory_job_id")
    validation_snapshot = _snapshot_approval_workspace(workspace)
    try:
        _assert_canon_projection_current(workspace, stage, artifact_path)
        validation = run_stage_validation(workspace, stage, actor, initial_job_id)
        validated_hash = sha256_file(artifact_path)
        if validated_hash != initial_hash:
            raise _approval_conflict("质量复核期间阶段产物发生变化，未执行批准")
    except Exception:
        _restore_approval_workspace(workspace, validation_snapshot)
        raise

    # validate 会重写质量状态与本次 Job 摘要；审批必须以这份新状态为准。
    progress_before = progress_path.read_text(encoding="utf-8")
    progress = json.loads(progress_before)
    stage_progress = progress.get("stages", {}).get(stage, {})
    if stage_progress.get("status") != "draft_ready" or stage_progress.get("quality_check", {}).get("passed") is not True:
        raise _approval_conflict(f"阶段 {stage} 未在当前质量契约下进入 draft_ready，不能批准")
    validated_summary = stage_progress.get("summary") if isinstance(stage_progress.get("summary"), dict) else {}
    resolved_job_id = job_id or validated_summary.get("memory_job_id")
    runtime_job_id = _safe_runtime_job_id(resolved_job_id)
    quality_contract_version = current_quality_contract_version()
    delta_result = {"committed": 0, **({"skipped": True} if not commit_delta else {})}
    memory_dir = workspace / "memory"
    rollback_files = [memory_dir / "character-state.jsonl", memory_dir / "decisions.jsonl"]
    snapshots = {file_path: file_path.read_bytes() if file_path.exists() else None for file_path in rollback_files}
    delta_path: Path | None = None
    if runtime_job_id:
        job_dir = workspace / "runtime" / "jobs" / runtime_job_id
        delta_path = job_dir / "memory-delta.json"
        snapshots[delta_path] = delta_path.read_bytes() if delta_path.exists() else None
        report_path = job_dir / "consistency-report.json"
        if stage in {"trial_generate", "full_generate"}:
            if not report_path.is_file():
                raise _approval_conflict("本次校验未产生角色一致性报告，不能批准")
            report = _read_json_for_approval(report_path, "角色一致性报告")
            if report.get("status") == "failed":
                raise _approval_conflict("角色一致性校验未通过，不能批准该阶段")
            script_file = stage_artifact_name(workspace, stage)
            if not script_file:
                raise _approval_conflict(f"阶段 {stage} 缺少剧本产物路径")
            current_hash = sha256_file(workspace / script_file)
            existing_delta = json.loads(delta_path.read_text(encoding="utf-8")) if delta_path.exists() else {}
            if existing_delta.get("source_hashes", {}).get(script_file) != current_hash:
                run_memory_tool(
                    workspace,
                    "propose-delta",
                    "--file",
                    script_file,
                    "--stage",
                    stage,
                    "--job-id",
                    runtime_job_id,
                )
            if not delta_path.is_file():
                raise _approval_conflict("本次校验未生成可复核的 Memory 增量，不能批准")
        if delta_path.exists() and commit_delta:
            delta = _read_json_for_approval(delta_path, "Memory 增量")
            changes = delta.get("character_state_changes")
            safely_empty = isinstance(changes, list) and all(
                isinstance(change, dict)
                and isinstance(change.get("state"), dict)
                and not change["state"]
                for change in changes
            )
            if safely_empty:
                skipped_at = utc_now_iso()
                delta.update({
                    "status": "skipped_no_substantive_changes",
                    "review_note": "没有已复核且可安全写入的角色状态变化，本次不写入角色状态 Memory。",
                    "skipped_at": skipped_at,
                    "skipped_by": actor,
                })
                delta_path.write_text(f"{json.dumps(delta, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
                delta_result = {
                    "committed": 0,
                    "skipped": True,
                    "reason": "no_substantive_changes",
                }
            else:
                try:
                    delta_result = run_memory_tool(
                        workspace,
                        "commit-delta",
                        "--file",
                        str(delta_path),
                        "--approved-by",
                        actor,
                    )
                except Exception as exc:
                    for file_path, content in snapshots.items():
                        if content is None:
                            file_path.unlink(missing_ok=True)
                        else:
                            file_path.write_bytes(content)
                    sync_workspace_memory(workspace, actor="system", reason="stage_approval_rollback")
                    raise _approval_conflict(f"Memory 增量尚未通过人工复核：{exc}") from exc
    try:
        now = utc_now_iso()
        stage_progress["status"] = "approved"
        stage_progress["updated_at"] = now
        stage_progress["updated_by"] = actor
        stage_progress["next_action"] = "阶段产物已批准，可进入下一阶段"
        stage_summary = stage_progress.get("summary") if isinstance(stage_progress.get("summary"), dict) else {}
        stage_progress["summary"] = {
            **stage_summary,
            "approval_artifact_hash": validated_hash,
            "quality_contract_version": quality_contract_version,
            "quality_validated_at": now,
        }
        progress["audit"] = {**progress.get("audit", {}), "updated_at": now, "updated_by": actor}
        progress_path.write_text(f"{json.dumps(progress, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        memory = sync_workspace_memory(workspace, actor=actor, reason="stage_approval", changed_file="01-project-progress.json")
    except Exception:
        progress_path.write_text(progress_before, encoding="utf-8")
        for file_path, content in snapshots.items():
            if content is None:
                file_path.unlink(missing_ok=True)
            else:
                file_path.write_bytes(content)
        sync_workspace_memory(workspace, actor="system", reason="stage_approval_rollback")
        raise
    return {
        "stage": stage,
        "status": "approved",
        "memory": memory,
        "delta": delta_result,
        "job_id": resolved_job_id,
        "artifact_hash": validated_hash,
        "quality_contract_version": quality_contract_version,
        "quality_validation": {
            "status": validation.get("status"),
            "script_quality_status": validation.get("script_quality_status"),
        },
    }
