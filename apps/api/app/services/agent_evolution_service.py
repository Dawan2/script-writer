from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


READ_PATH_RE = re.compile(r'(?:file_path|path)["\\\s:=]+([^"\\\n]+)')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _metadata(value: str | None) -> dict:
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}


def _scan_raw_logs(jobs: list[sqlite3.Row]) -> dict:
    compactions = 0
    read_paths: Counter[str] = Counter()
    scanned_bytes = 0
    for job in jobs:
        raw_path = job["raw_log_path"] if "raw_log_path" in job.keys() else None
        if not raw_path:
            continue
        path = Path(raw_path)
        if not path.exists():
            continue
        scanned_bytes += path.stat().st_size
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                lowered = line.lower()
                if "compact" in lowered and ("context" in lowered or "boundary" in lowered):
                    compactions += 1
                if "read" not in lowered:
                    continue
                match = READ_PATH_RE.search(line)
                if match:
                    candidate = match.group(1).strip()
                    if candidate.startswith("/"):
                        read_paths[candidate] += 1
    repeated_reads = []
    for read_path, count in read_paths.items():
        if count <= 1:
            continue
        candidate_path = Path(read_path)
        size = candidate_path.stat().st_size if candidate_path.is_file() else 0
        repeated_reads.append({
            "path": read_path,
            "count": count,
            "bytes": size,
            "estimated_repeated_bytes": size * (count - 1),
        })
    repeated_reads.sort(key=lambda item: (item["estimated_repeated_bytes"], item["count"]), reverse=True)
    return {
        "scanned_bytes": scanned_bytes,
        "context_compaction_mentions": compactions,
        "repeated_reads": repeated_reads[:20],
    }


def _runtime_quality_evidence(workspace: Path) -> dict:
    issue_codes: Counter[str] = Counter()
    reports = 0
    pending_deltas = 0
    episode_accesses: Counter[str] = Counter()
    jobs_dir = workspace / "runtime" / "jobs"
    if not jobs_dir.exists():
        return {"consistency_reports": 0, "issue_codes": {}, "pending_memory_deltas": 0}
    for job_dir in jobs_dir.iterdir():
        if not job_dir.is_dir():
            continue
        report_path = job_dir / "consistency-report.json"
        if report_path.exists():
            reports += 1
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
                issue_codes.update(item.get("code", "UNKNOWN") for item in report.get("issues", []))
            except (OSError, json.JSONDecodeError):
                issue_codes["INVALID_REPORT"] += 1
        delta_path = job_dir / "memory-delta.json"
        if delta_path.exists():
            try:
                delta = json.loads(delta_path.read_text(encoding="utf-8"))
                if delta.get("status") == "pending_approval":
                    pending_deltas += 1
            except (OSError, json.JSONDecodeError):
                pending_deltas += 1
        access_path = job_dir / "episode-access.jsonl"
        if access_path.exists():
            for line in access_path.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    access = json.loads(line)
                    key = f"{access.get('requested_source')}:{access.get('range')}"
                    episode_accesses[key] += 1
                except json.JSONDecodeError:
                    continue
    return {
        "consistency_reports": reports,
        "issue_codes": dict(issue_codes),
        "pending_memory_deltas": pending_deltas,
        "repeated_episode_retrievals": {
            key: count for key, count in episode_accesses.items() if count > 1
        },
    }


def _recommendations(evidence: dict) -> list[dict]:
    recommendations = []
    runtime = evidence["runtime"]
    quality = evidence["quality"]
    changes = evidence["manual_changes"]
    if runtime["context_compaction_mentions"]:
        recommendations.append({
            "priority": "high",
            "area": "context_policy",
            "reason": f"检测到 {runtime['context_compaction_mentions']} 次上下文压缩相关记录",
            "proposal": "检查阶段 Context Pack 是否仍包含无关来源；保持阶段 session 隔离，并为超长阶段进一步按集数分批。",
            "acceptance": "同类项目单阶段不发生自动压缩，且一致性报告不退化。",
        })
    if runtime["repeated_reads"]:
        top = runtime["repeated_reads"][0]
        recommendations.append({
            "priority": "high" if top["count"] >= 5 else "medium",
            "area": "retrieval",
            "reason": f"重复读取浪费最高的文件为 {top['path']}，共 {top['count']} 次，估算重复读取 {top['estimated_repeated_bytes']} 字节",
            "proposal": "补强该文件的确定性分段规则或在 job working state 中缓存已检索段落。",
            "acceptance": "同一 job 对同一大文件完整读取不超过 1 次，后续只做定向集数检索。",
        })
    if quality["issue_codes"]:
        recommendations.append({
            "priority": "high",
            "area": "quality_gate",
            "reason": f"一致性问题分布：{quality['issue_codes']}",
            "proposal": "针对高频 issue code 增加 Skill 约束与固定回归样例，不降低现有质检阈值。",
            "acceptance": "改动后的回归样例通过，且历史通过样例保持通过。",
        })
    if changes["semantic_count"]:
        recommendations.append({
            "priority": "medium",
            "area": "skill_prompt",
            "reason": f"用户进行了 {changes['semantic_count']} 次语义修改，集中阶段：{changes['by_stage']}",
            "proposal": "抽样人工 diff，区分偏好修正与事实纠错；只有跨项目重复出现的问题才晋升为全局 Skill 规则。",
            "acceptance": "至少两个项目出现同类修正，并由人工批准 Skill 版本后再发布。",
        })
    if not recommendations:
        recommendations.append({
            "priority": "low",
            "area": "baseline",
            "reason": "未检测到明显运行或质量异常",
            "proposal": "保留本次证据作为基线，不修改 Skill。",
            "acceptance": "下一项目继续采集相同指标。",
        })
    return recommendations


def create_evolution_review(conn: sqlite3.Connection, project: sqlite3.Row, workspace: Path) -> dict:
    jobs = conn.execute(
        "SELECT * FROM agent_jobs WHERE project_id = ? ORDER BY id",
        (project["id"],),
    ).fetchall()
    result_messages = conn.execute(
        "SELECT metadata_json FROM agent_messages WHERE project_id = ? AND role = 'assistant'",
        (project["id"],),
    ).fetchall()
    changes = conn.execute(
        """
        SELECT stage, change_kind FROM artifact_changes
        WHERE project_id = ? AND change_kind IN ('semantic', 'formatting')
        ORDER BY id
        """,
        (project["id"],),
    ).fetchall()
    metadata = [_metadata(row["metadata_json"]) for row in result_messages]
    stage_changes = Counter(row["stage"] for row in changes if row["change_kind"] == "semantic")
    evidence = {
        "schema_version": "1.0.0",
        "created_at": _now(),
        "project": {
            "id": project["id"],
            "name": project["name"],
            "workspace_dir": project["workspace_dir"],
            "target_region": project["target_region"],
        },
        "execution": {
            "job_count": len(jobs),
            "failed_jobs": sum(1 for job in jobs if job["status"] == "failed"),
            "stage_sessions": len({job["claude_session_id"] for job in jobs}),
            "total_turns": sum(int(item.get("num_turns") or 0) for item in metadata),
            "total_cost_usd": round(sum(float(item.get("total_cost_usd") or 0) for item in metadata), 6),
            "raw_log_bytes": sum(
                int(job["raw_log_bytes"] or 0)
                or (Path(job["raw_log_path"]).stat().st_size if job["raw_log_path"] and Path(job["raw_log_path"]).exists() else 0)
                for job in jobs
            ),
        },
        "runtime": _scan_raw_logs(jobs),
        "quality": _runtime_quality_evidence(workspace),
        "manual_changes": {
            "total": len(changes),
            "semantic_count": sum(1 for row in changes if row["change_kind"] == "semantic"),
            "formatting_count": sum(1 for row in changes if row["change_kind"] == "formatting"),
            "by_stage": dict(stage_changes),
        },
    }
    proposal = {
        "schema_version": "1.0.0",
        "status": "pending_human_review",
        "principle": "质量指标不可退化；单项目证据不得直接修改全局 Skill。",
        "recommendations": _recommendations(evidence),
    }
    evolution_dir = workspace / "memory" / "evolution"
    evolution_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    evidence_path = evolution_dir / f"review-{stamp}.json"
    evidence_path.write_text(
        f"{json.dumps({'evidence': evidence, 'proposal': proposal}, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )
    conn.execute(
        """
        INSERT INTO agent_evolution_reviews (project_id, status, evidence_json, proposal_json)
        VALUES (?, 'pending', ?, ?)
        """,
        (project["id"], json.dumps(evidence, ensure_ascii=False), json.dumps(proposal, ensure_ascii=False)),
    )
    conn.commit()
    return {"evidence_path": str(evidence_path), "evidence": evidence, "proposal": proposal}


def list_evolution_reviews(conn: sqlite3.Connection, project_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM agent_evolution_reviews WHERE project_id = ? ORDER BY id DESC",
        (project_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "status": row["status"],
            "evidence": _metadata(row["evidence_json"]),
            "proposal": _metadata(row["proposal_json"]),
            "applied_version": row["applied_version"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def backfill_evolution_reviews(conn: sqlite3.Connection, agents_dir: Path) -> list[dict]:
    projects = conn.execute(
        """
        SELECT project.* FROM projects AS project
        WHERE project.deleted_at IS NULL
          AND EXISTS (
              SELECT 1 FROM agent_jobs
              WHERE agent_jobs.project_id = project.id
                AND COALESCE(agent_jobs.target_stage, agent_jobs.stage) = 'foreign_review'
                AND agent_jobs.status = 'succeeded'
          )
          AND NOT EXISTS (
              SELECT 1 FROM agent_evolution_reviews
              WHERE agent_evolution_reviews.project_id = project.id
          )
        ORDER BY project.id
        """
    ).fetchall()
    results = []
    for project in projects:
        workspace = (agents_dir / project["workspace_dir"]).resolve()
        if not workspace.exists():
            continue
        try:
            review = create_evolution_review(conn, project, workspace)
            results.append({"project_id": project["id"], "evidence_path": review["evidence_path"]})
        except Exception as exc:
            results.append({"project_id": project["id"], "error": str(exc)})
    return results
