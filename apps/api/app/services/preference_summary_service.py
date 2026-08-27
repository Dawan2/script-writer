from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

from app.core.config import settings
from app.db.session import get_connection
from app.services.ai_skill_runner import run_ai_skill
from app.services.audit_service import content_fingerprint, record_system_audit
from app.services.model_config_service import ensure_persisted_model_snapshot, runtime_from_snapshot
from app.services.writer_preference_service import (
    create_writer_preference,
    list_writer_preferences,
)
from app.services.workspace_service import resolve_workspace, workspace_input_path


MAX_SUMMARY_REPAIR_ATTEMPTS = 1


def _metadata(value: str | None) -> dict:
    if not value:
        return {}
    try:
        payload = json.loads(value)
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
        return {}


def _manual_text(content: str, metadata: dict) -> str:
    explicit = str(metadata.get("manual_input") or "").strip()
    if explicit:
        return explicit
    marker = "用户请求："
    if marker not in content:
        return content.strip()
    value = content.split(marker, 1)[1]
    if "\n\n用户附件：" in value:
        value = value.split("\n\n用户附件：", 1)[0]
    value = value.strip()
    return "" if value == "（未输入文字）" else value


def queue_preference_summary(conn: sqlite3.Connection, *, project_id: int, user_id: int) -> sqlite3.Row:
    iteration = int(
        conn.execute(
            "SELECT COALESCE(MAX(archive_iteration), 0) + 1 FROM preference_summary_jobs WHERE project_id = ?",
            (project_id,),
        ).fetchone()[0]
    )
    conn.execute(
        """
        INSERT INTO preference_summary_jobs (project_id, user_id, archive_iteration)
        VALUES (?, ?, ?)
        """,
        (project_id, user_id, iteration),
    )
    return conn.execute(
        "SELECT * FROM preference_summary_jobs WHERE id = last_insert_rowid()"
    ).fetchone()


def cancel_preference_summaries_for_reopened_project(
    conn: sqlite3.Connection,
    *,
    project_id: int,
) -> int:
    """Discard archive-only work as soon as its project becomes active again."""
    result = conn.execute(
        """
        UPDATE preference_summary_jobs
        SET status = 'canceled', finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND status IN ('queued', 'running')
        """,
        (project_id,),
    )
    return result.rowcount


def normal_work_is_active(conn: sqlite3.Connection) -> bool:
    """Keep optional archive learning behind every user-facing writing task."""
    agent_job = conn.execute(
        "SELECT 1 FROM agent_jobs WHERE status IN ('queued', 'running') LIMIT 1"
    ).fetchone()
    if agent_job:
        return True
    batch_task = conn.execute(
        "SELECT 1 FROM batch_tasks WHERE status IN ('queued', 'running') LIMIT 1"
    ).fetchone()
    return batch_task is not None


def claim_preference_summary_job(
    conn: sqlite3.Connection,
    summary_job_id: int,
) -> sqlite3.Row | None:
    """Atomically hand one queued archive summary to one background worker."""
    result = conn.execute(
        """
        UPDATE preference_summary_jobs
        SET status = 'running', started_at = CURRENT_TIMESTAMP,
            error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued'
          AND EXISTS (
              SELECT 1 FROM projects AS project
              WHERE project.id = preference_summary_jobs.project_id
                AND project.status = 'completed'
          )
          AND NOT EXISTS (
              SELECT 1 FROM preference_summary_jobs AS active
              WHERE active.status = 'running'
          )
          AND NOT EXISTS (
              SELECT 1 FROM agent_jobs AS active_agent
              WHERE active_agent.status IN ('queued', 'running')
          )
          AND NOT EXISTS (
              SELECT 1 FROM batch_tasks AS active_batch
              WHERE active_batch.status IN ('queued', 'running')
          )
        """,
        (summary_job_id,),
    )
    conn.commit()
    if result.rowcount != 1:
        return None
    return conn.execute(
        "SELECT * FROM preference_summary_jobs WHERE id = ?", (summary_job_id,)
    ).fetchone()


def queued_preference_summary_job_ids(limit: int = 1) -> list[int]:
    """Return a small batch for the scheduler; workers claim before they run."""
    with get_connection() as conn:
        if normal_work_is_active(conn):
            return []
        rows = conn.execute(
            """
            SELECT id FROM preference_summary_jobs
            WHERE status = 'queued'
            ORDER BY id
            LIMIT ?
            """,
            (max(1, min(int(limit), 1)),),
        ).fetchall()
    return [int(row["id"]) for row in rows]


def preference_summary_can_continue(conn: sqlite3.Connection, summary_job_id: int) -> bool:
    row = conn.execute(
        """
        SELECT summary.status, project.status AS project_status
        FROM preference_summary_jobs AS summary
        JOIN projects AS project ON project.id = summary.project_id
        WHERE summary.id = ?
        """,
        (summary_job_id,),
    ).fetchone()
    return bool(row and row["status"] == "running" and row["project_status"] == "completed")


def build_preference_summary_evidence(conn: sqlite3.Connection, summary_job_id: int) -> dict:
    row = conn.execute(
        """
        SELECT summary.*, project.name AS project_name, project.workspace_dir,
               project.target_region, project.task_type, project.owner_user_id, user.username
        FROM preference_summary_jobs AS summary
        JOIN projects AS project ON project.id = summary.project_id
        JOIN users AS user ON user.id = summary.user_id
        WHERE summary.id = ?
        """,
        (summary_job_id,),
    ).fetchone()
    if not row:
        raise RuntimeError("偏好总结任务不存在")

    workspace = resolve_workspace(row["workspace_dir"])
    initial_requirement = ""
    user_input_path = workspace_input_path(workspace)
    if user_input_path.is_file():
        try:
            user_input = json.loads(user_input_path.read_text(encoding="utf-8"))
            initial_requirement = str(user_input.get("project", {}).get("extra_requirements") or "").strip()
        except (OSError, json.JSONDecodeError):
            initial_requirement = ""

    manual_messages = []
    message_rows = conn.execute(
        """
        SELECT message.*
        FROM agent_messages AS message
        JOIN agent_jobs AS job ON job.id = message.job_id
        WHERE message.project_id = ? AND message.role = 'user' AND job.user_id = ?
        ORDER BY message.id
        """,
        (row["project_id"], row["user_id"]),
    ).fetchall()
    for message in message_rows:
        metadata = _metadata(message["metadata_json"])
        origin = str(metadata.get("input_origin") or "")
        if origin in {"automatic", "retry", "system"}:
            continue
        if origin != "manual" and message["stage"] != "chat_edit":
            continue
        text = _manual_text(message["content"], metadata)
        if text:
            manual_messages.append({
                "ref": f"message:{message['id']}",
                "stage": message["stage"],
                "content": text,
                "created_at": message["created_at"],
            })

    manual_adjustments = []
    change_rows = conn.execute(
        """
        SELECT * FROM artifact_changes
        WHERE project_id = ? AND edited_by = ? AND change_kind IN ('semantic', 'formatting')
        ORDER BY id
        """,
        (row["project_id"], row["user_id"]),
    ).fetchall()
    for change in change_rows:
        impact = _metadata(change["impact_json"])
        manual_adjustments.append({
            "ref": f"artifact_change:{change['id']}",
            "stage": change["stage"],
            "file_path": change["file_path"],
            "change_kind": change["change_kind"],
            "summary": impact.get("summary", ""),
            "added_samples": impact.get("added_samples", []),
            "removed_samples": impact.get("removed_samples", []),
            "created_at": change["created_at"],
        })

    existing = list_writer_preferences(conn, int(row["user_id"]))["preferences"]
    manual_inputs = []
    if initial_requirement and int(row["owner_user_id"]) == int(row["user_id"]):
        manual_inputs.append({
            "ref": "initial_requirement",
            "stage": "global",
            "content": initial_requirement,
        })

    return {
        "schema_version": "1.0.0",
        "summary_job_id": summary_job_id,
        "archive_iteration": row["archive_iteration"],
        "user": {"id": row["user_id"], "username": row["username"]},
        "project": {
            "id": row["project_id"],
            "name": row["project_name"],
            "target_region": row["target_region"],
            "task_type": row["task_type"],
        },
        "manual_inputs": manual_inputs,
        "manual_messages": manual_messages,
        "manual_adjustments": manual_adjustments,
        "existing_preferences": [
            {"id": item["id"], "content": item["content"], "scopes": item["scopes"]}
            for item in existing
        ],
        "policy": {
            "only_manual_user_input": True,
            "automatic_messages_excluded": True,
            "optional_output": True,
            "default_enabled": False,
        },
    }


def _job_dir(summary_job_id: int) -> Path:
    return settings.data_dir / "preference-summaries" / str(summary_job_id)


def _preference_summary_tool_path(action: str) -> Path:
    scripts = {
        "init": "init-preference-summary.mjs",
        "validate": "validate-preference-summary.mjs",
    }
    script = scripts.get(action)
    if not script:
        raise RuntimeError(f"不支持的偏好总结工具动作：{action}")
    path = settings.agents_dir / ".claude" / "skills" / "preference-summary" / "scripts" / script
    if not path.is_file():
        raise RuntimeError(f"偏好总结工具不存在：{path}")
    return path


def run_preference_summary_tool(action: str, *, evidence_path: Path, output_path: Path) -> dict:
    command = [
        os.getenv("ORCA_NODE_PATH", "").strip() or "node",
        str(_preference_summary_tool_path(action)),
        "--evidence", str(evidence_path),
        "--output", str(output_path),
    ]
    result = subprocess.run(
        command,
        cwd=settings.agents_dir,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
        raise RuntimeError(f"偏好总结{action}校验失败：{detail[-2000:]}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("偏好总结工具返回格式无效") from exc
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("偏好总结工具未确认通过")
    return payload


def invoke_preference_summary_skill(
    evidence_path: Path,
    output_path: Path,
    log_path: Path,
    *,
    repair_issues: str | None = None,
    model_runtime: dict | None = None,
) -> None:
    repair_note = (
        f"\n上一次结果未通过校验，必须只修复以下问题后覆盖输出文件：{repair_issues}\n"
        if repair_issues
        else ""
    )
    skill_path = settings.agents_dir / ".claude" / "skills" / "preference-summary" / "SKILL.md"
    if not skill_path.is_file():
        raise RuntimeError("个人创作偏好总结 Skill 不存在")
    prompt = f"""
请严格执行以下个人创作偏好总结 Skill：

<skill_instructions>
{skill_path.read_text(encoding="utf-8")}
</skill_instructions>

证据文件：{evidence_path}
输出文件：{output_path}
初始化工具已经创建输出模板。只能从证据文件中的手动输入和手动调整提炼；没有值得跨项目保留的要求时保留空数组。
必须真实覆盖输出文件，不得修改任何其他文件。{repair_note}
""".strip()
    run_ai_skill(
        prompt,
        log_path=log_path,
        timeout_seconds=15 * 60,
        tools="Read,Edit,Write",
        model_runtime=model_runtime,
    )


def _create_summary_notification(
    conn: sqlite3.Connection,
    *,
    summary_job: sqlite3.Row,
    project_name: str,
    created_count: int,
) -> None:
    if not created_count:
        return
    message = f"已从「{project_name}」提炼 {created_count} 条待确认偏好"
    conn.execute(
        """
        INSERT INTO notifications (
            user_id, project_id, preference_summary_job_id, kind,
            title, message, target_path
        ) VALUES (?, ?, ?, 'preference_summary_completed', ?, ?, ?)
        ON CONFLICT(preference_summary_job_id) DO NOTHING
        """,
        (
            summary_job["user_id"],
            summary_job["project_id"],
            summary_job["id"],
            "创作偏好已整理",
            message,
            f"/preferences?source_job={summary_job['id']}",
        ),
    )


def run_preference_summary_job(summary_job_id: int) -> None:
    with get_connection() as conn:
        job = claim_preference_summary_job(conn, summary_job_id)
        if not job:
            return
        job = ensure_persisted_model_snapshot(
            conn,
            table_name="preference_summary_jobs",
            row=job,
            route_keys=(("writer_preferences", "summary"),),
        )
        model_runtime = runtime_from_snapshot(
            job["model_config_snapshot_json"],
            scenario_key="writer_preferences",
            action_key="summary",
        )
        record_system_audit(
            conn,
            action="writer_preference.summary.started",
            target_type="writer_preference_profile",
            target_id=job["user_id"],
            target_label=f"偏好整理 #{job['id']}",
            project_id=int(job["project_id"]),
            details={
                "summary_job_id": job["id"],
                "archive_iteration": job["archive_iteration"],
                "user_id": job["user_id"],
            },
        )
        conn.commit()
        try:
            evidence = build_preference_summary_evidence(conn, summary_job_id)
            work_dir = _job_dir(summary_job_id)
            work_dir.mkdir(parents=True, exist_ok=True)
            evidence_path = work_dir / "evidence.json"
            output_path = work_dir / "result.json"
            log_path = work_dir / "run.log"
            evidence_path.write_text(
                f"{json.dumps(evidence, ensure_ascii=False, indent=2)}\n", encoding="utf-8"
            )
            run_preference_summary_tool("init", evidence_path=evidence_path, output_path=output_path)
            has_evidence = bool(
                evidence["manual_inputs"] or evidence["manual_messages"] or evidence["manual_adjustments"]
            )
            if has_evidence:
                invoke_preference_summary_skill(evidence_path, output_path, log_path, model_runtime=model_runtime)
            if not preference_summary_can_continue(conn, summary_job_id):
                return
            attempts = 0
            while True:
                try:
                    validated = run_preference_summary_tool(
                        "validate", evidence_path=evidence_path, output_path=output_path
                    )
                    result = validated.get("details", {}).get("result")
                    if not isinstance(result, dict) or not isinstance(result.get("preferences"), list):
                        raise RuntimeError("偏好总结校验结果缺少 preferences")
                    suggestions = result["preferences"]
                    break
                except RuntimeError as exc:
                    if not has_evidence or attempts >= MAX_SUMMARY_REPAIR_ATTEMPTS:
                        raise
                    attempts += 1
                    if not preference_summary_can_continue(conn, summary_job_id):
                        return
                    invoke_preference_summary_skill(
                        evidence_path,
                        output_path,
                        log_path,
                        repair_issues=str(exc),
                        model_runtime=model_runtime,
                    )
            if not preference_summary_can_continue(conn, summary_job_id):
                return
            existing_contents = {
                item["content"].strip().casefold()
                for item in list_writer_preferences(conn, int(job["user_id"]))["preferences"]
            }
            created = []
            conn.execute("SAVEPOINT preference_summary_import")
            try:
                if not preference_summary_can_continue(conn, summary_job_id):
                    conn.execute("ROLLBACK TO SAVEPOINT preference_summary_import")
                    conn.execute("RELEASE SAVEPOINT preference_summary_import")
                    return
                for suggestion in suggestions:
                    if suggestion["content"].casefold() in existing_contents:
                        continue
                    result = create_writer_preference(
                        conn,
                        user_id=int(job["user_id"]),
                        content=suggestion["content"],
                        scopes=suggestion["scopes"],
                        enabled=False,
                        source="ai",
                        evidence={
                            "source_type": "archive_summary",
                            "summary_job_id": summary_job_id,
                            "project_id": job["project_id"],
                            "project_name": evidence["project"]["name"],
                            "archive_iteration": job["archive_iteration"],
                            "evidence_refs": suggestion["evidence_refs"],
                            "rationale": suggestion["rationale"],
                        },
                    )
                    created.append(result["preference"])
                    existing_contents.add(suggestion["content"].casefold())
                conn.execute("RELEASE SAVEPOINT preference_summary_import")
            except Exception:
                conn.execute("ROLLBACK TO SAVEPOINT preference_summary_import")
                conn.execute("RELEASE SAVEPOINT preference_summary_import")
                raise

            result_payload = {
                "schema_version": "1.0.0",
                "created_count": len(created),
                "created_preference_ids": [item["id"] for item in created],
                "suggested_count": len(suggestions),
                "evidence_path": str(evidence_path),
            }
            status_update = conn.execute(
                """
                UPDATE preference_summary_jobs
                SET status = 'succeeded', evidence_json = ?, result_json = ?,
                    finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'running'
                """,
                (
                    json.dumps(evidence, ensure_ascii=False),
                    json.dumps(result_payload, ensure_ascii=False),
                    summary_job_id,
                ),
            )
            if status_update.rowcount != 1:
                return
            _create_summary_notification(
                conn,
                summary_job=job,
                project_name=evidence["project"]["name"],
                created_count=len(created),
            )
            record_system_audit(
                conn,
                action="writer_preference.summary.completed",
                target_type="writer_preference_profile",
                target_id=job["user_id"],
                target_label=evidence["project"]["name"],
                project_id=int(job["project_id"]),
                details={
                    "summary_job_id": job["id"],
                    "archive_iteration": job["archive_iteration"],
                    "suggested_count": len(suggestions),
                    "created_count": len(created),
                    "created_preference_ids": [item["id"] for item in created],
                },
            )
        except Exception as exc:
            conn.execute(
                """
                UPDATE preference_summary_jobs
                SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'running'
                """,
                (str(exc)[:4000], summary_job_id),
            )
            record_system_audit(
                conn,
                action="writer_preference.summary.failed",
                target_type="writer_preference_profile",
                target_id=job["user_id"],
                target_label=f"偏好整理 #{job['id']}",
                project_id=int(job["project_id"]),
                outcome="failure",
                severity="warning",
                details={
                    "summary_job_id": job["id"],
                    "archive_iteration": job["archive_iteration"],
                    "error": content_fingerprint(str(exc)),
                },
            )
