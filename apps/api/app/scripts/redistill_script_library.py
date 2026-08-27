from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.db.session import get_connection
from app.services.model_config_service import resolve_runtime_model
from app.services.script_library_service import (
    DEFAULT_SHORT_WRITING_SKILL,
    _bootstrap_source_error,
    _decrypt_source,
    _json,
    _replace_chunks,
    run_script_distillation_job,
)
from app.services.script_distillation_pipeline import PIPELINE_VERSION


BATCH_VERSION = PIPELINE_VERSION
LEGACY_FORMULA_ORIGIN = "luna-v2"
MAX_WORKERS = 3


@dataclass(frozen=True)
class ScriptTarget:
    script_id: int
    title: str
    chars: int


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
    return rows


def _selected_ids(raw: str) -> set[int]:
    result: set[int] = set()
    for token in raw.replace("，", ",").split(","):
        token = token.strip()
        if token:
            result.add(int(token))
    return result


def _source_path(source_hash: str) -> Path:
    directory = settings.data_dir / "script-library" / "sources"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{source_hash}.md"


def refresh_bootstrap_sources(
    *,
    source_root: Path,
    only_ids: set[int],
    reset: bool,
    limit: int,
) -> tuple[list[ScriptTarget], list[ScriptTarget]]:
    manifest = _read_jsonl(source_root / "assets/library/script_manifest.jsonl")
    full_manifest = {
        str(item.get("id")): item
        for item in _read_jsonl(source_root / "assets/full-scripts/manifest.jsonl")
    }
    ready_targets: list[ScriptTarget] = []
    insufficient_targets: list[ScriptTarget] = []
    with get_connection() as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        for item in manifest:
            script_key = str(item.get("id") or "")
            full_item = full_manifest.get(f"fs{script_key.removeprefix('s')}")
            if not full_item:
                continue
            source_hash = str(full_item.get("plaintext_sha256") or "")
            row = conn.execute(
                "SELECT * FROM script_library_scripts WHERE source_sha256 = ?",
                (source_hash,),
            ).fetchone()
            if not row or (only_ids and int(row["id"]) not in only_ids):
                continue
            if limit and len(ready_targets) >= limit:
                break

            encrypted_path = source_root / "assets/full-scripts" / str(full_item["filename"])
            text = _decrypt_source(encrypted_path)
            source_error = _bootstrap_source_error(text)
            can_distill = source_error is None
            path = _source_path(source_hash)
            path.write_text(text.strip() + "\n", encoding="utf-8")
            script_id = int(row["id"])
            already_complete = (
                can_distill
                and not reset
                and str(row["distillation_version"] or "") == BATCH_VERSION
                and str(row["status"]) == "ready"
            )
            _replace_chunks(conn, script_id, text)
            conn.execute(
                """
                UPDATE script_library_scripts
                SET source_file_path = ?, chars = ?, status = ?, error_message = ?,
                    summary = CASE WHEN ? THEN '' ELSE summary END,
                    theme_tags_json = CASE WHEN ? THEN '[]' ELSE theme_tags_json END,
                    setting_tags_json = CASE WHEN ? THEN '[]' ELSE setting_tags_json END,
                    background_tags_json = CASE WHEN ? THEN '[]' ELSE background_tags_json END,
                    audience_tags_json = CASE WHEN ? THEN '[]' ELSE audience_tags_json END,
                    case_card_json = CASE WHEN ? THEN '{}' ELSE case_card_json END,
                    formulas_json = CASE WHEN ? THEN '{}' ELSE formulas_json END,
                    distillation_version = CASE WHEN ? THEN '' ELSE distillation_version END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    str(path), len(text),
                    "ready" if already_complete else "queued" if can_distill else "failed",
                    None if can_distill else source_error,
                    *([1 if reset else 0] * 8), script_id,
                ),
            )
            target = ScriptTarget(script_id=script_id, title=str(row["title"]), chars=len(text))
            if already_complete:
                continue
            if can_distill:
                ready_targets.append(target)
            else:
                insufficient_targets.append(target)

        selected_script_ids = [target.script_id for target in [*ready_targets, *insufficient_targets]]
        if selected_script_ids:
            placeholders = ",".join("?" for _ in selected_script_ids)
            conn.execute(
                f"""
                UPDATE script_distillation_jobs
                SET status = 'canceled', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE script_id IN ({placeholders}) AND status IN ('queued', 'running')
                """,
                selected_script_ids,
            )
        if reset:
            conn.execute(
                "DELETE FROM script_library_formula_cards WHERE origin IN ('short-writing-skill', ?)",
                (LEGACY_FORMULA_ORIGIN,),
            )
        elif selected_script_ids:
            for script_id in selected_script_ids:
                conn.execute(
                    """
                    DELETE FROM script_library_formula_cards
                    WHERE origin = ? AND source_script_ids_json = ?
                    """,
                    (LEGACY_FORMULA_ORIGIN, _json([script_id])),
                )
        conn.commit()
    return ready_targets, insufficient_targets


def _job_snapshot(runtime: dict[str, Any]) -> str:
    return _json({**runtime, "runner": "script-library-staged-pipeline"})


def _start_job(script_id: int, *, requested_by: int | None, runtime: dict[str, Any]) -> int:
    with get_connection() as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute(
            """
            UPDATE script_distillation_jobs
            SET status = 'canceled', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE script_id = ? AND status IN ('queued', 'running')
            """,
            (script_id,),
        )
        cursor = conn.execute(
            """
            INSERT INTO script_distillation_jobs (
                script_id, requested_by, status, model_config_snapshot_json, started_at
            ) VALUES (?, ?, 'running', ?, CURRENT_TIMESTAMP)
            """,
            (script_id, requested_by, _job_snapshot(runtime)),
        )
        conn.execute(
            """
            UPDATE script_library_scripts
            SET status = 'processing', error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (script_id,),
        )
        conn.commit()
        return int(cursor.lastrowid)


def _finish_failure(script_id: int, job_id: int, message: str) -> None:
    rendered = message.strip()[-1500:] or "蒸馏失败"
    with get_connection() as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute(
            """
            UPDATE script_distillation_jobs
            SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE id = ?
            """,
            (rendered, job_id),
        )
        conn.execute(
            """
            UPDATE script_library_scripts
            SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            """,
            (rendered, script_id),
        )
        conn.commit()


def distill_one(
    target: ScriptTarget,
    *,
    requested_by: int | None,
    timeout_seconds: int,
    attempts: int,
    reuse_results: bool,
) -> tuple[bool, str, float]:
    started = time.monotonic()
    # The batch command uses the same persisted job runner as the admin UI.
    # Stage checkpoints, model retries and catalog curation therefore stay
    # identical to normal uploads. Keep the old CLI knobs for compatibility;
    # the shared runner owns their effective values.
    _ = timeout_seconds, attempts, reuse_results
    with get_connection() as conn:
        runtime = resolve_runtime_model(conn, scenario_key="script_library", action_key="distill")
    job_id = _start_job(target.script_id, requested_by=requested_by, runtime=runtime)
    try:
        run_script_distillation_job(job_id, _already_claimed=True)
    except Exception as exc:  # pragma: no cover - defensive guard for pre-run failures
        _finish_failure(target.script_id, job_id, str(exc).strip() or exc.__class__.__name__)

    with get_connection() as conn:
        row = conn.execute(
            "SELECT status, error_message FROM script_distillation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    if row and str(row["status"]) == "succeeded":
        return True, "", time.monotonic() - started
    message = str(row["error_message"] or "蒸馏失败") if row else "蒸馏任务不存在"
    return False, message, time.monotonic() - started


def _admin_id() -> int | None:
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
        return int(row["id"]) if row else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="解码首批剧本并通过独立文本模型完成 V2 深度蒸馏。")
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SHORT_WRITING_SKILL)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--effort", default="max", choices=("low", "medium", "high", "xhigh", "max"))
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--ids", default="", help="只处理逗号分隔的剧本 ID。")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--reset", action="store_true", help="清空首批旧蒸馏结果与旧知识卡。")
    parser.add_argument("--reuse-results", action="store_true", help="优先复用已通过校验的 result.json。")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_root = args.source_root.expanduser().resolve()
    if not (source_root / "assets/full-scripts/manifest.jsonl").is_file():
        raise SystemExit("未找到加密原文库。")
    workers = max(1, min(int(args.workers), MAX_WORKERS))
    attempts = max(1, min(int(args.attempts), 4))
    only_ids = _selected_ids(args.ids)

    work_root = settings.data_dir / "script-library" / "luna-v2"
    work_root.mkdir(parents=True, exist_ok=True)

    targets, insufficient = refresh_bootstrap_sources(
        source_root=source_root,
        only_ids=only_ids,
        reset=bool(args.reset),
        limit=max(0, int(args.limit)),
    )
    print(
        f"已从加密库重新解码 {len(targets) + len(insufficient)} 部；"
        f"待蒸馏 {len(targets)} 部；原文不可用 {len(insufficient)} 部。",
        flush=True,
    )
    if not targets:
        return 0

    requested_by = _admin_id()
    succeeded = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="luna-distill") as executor:
        future_map = {
            executor.submit(
                distill_one,
                target,
                requested_by=requested_by,
                timeout_seconds=max(60, int(args.timeout_seconds)),
                attempts=attempts,
                reuse_results=bool(args.reuse_results),
            ): target
            for target in targets
        }
        total = len(future_map)
        for completed_count, future in enumerate(as_completed(future_map), start=1):
            target = future_map[future]
            try:
                ok, message, elapsed = future.result()
            except Exception as exc:
                ok, message, elapsed = False, str(exc), 0.0
            if ok:
                succeeded += 1
                print(f"[{completed_count}/{total}] 完成 #{target.script_id} {target.title} ({elapsed:.1f}s)", flush=True)
            else:
                failed += 1
                print(f"[{completed_count}/{total}] 失败 #{target.script_id} {target.title}：{message}", flush=True)

    print(f"批处理结束：成功 {succeeded}，失败 {failed}，原文不可用 {len(insufficient)}。", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
