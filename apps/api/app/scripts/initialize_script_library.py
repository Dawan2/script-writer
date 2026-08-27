from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from app.core.config import settings
from app.db.session import get_connection, init_db
from app.services.script_library_batch_service import (
    case_ready_counts,
    distill_formulas,
    distill_principles,
    finalize_batch_scripts,
    prepare_batch_initialization,
)
from app.services.script_library_service import run_script_distillation_job


def _queued_batch_job_ids(limit: int) -> list[int]:
    with get_connection() as conn:
        running = int(conn.execute("SELECT COUNT(*) FROM script_distillation_jobs WHERE status='running'").fetchone()[0])
        available = max(0, min(max(1, int(limit)), max(0, int(settings.script_distillation_max_parallel) - running)))
        if not available:
            return []
        return [
            int(row["id"])
            for row in conn.execute(
                """
                SELECT job.id FROM script_distillation_jobs AS job
                JOIN script_library_scripts AS script ON script.id = job.script_id
                WHERE job.status='queued' AND script.distillation_mode='batch_case'
                ORDER BY job.id LIMIT ?
                """,
                (available,),
            ).fetchall()
        ]


def _retry_failed_cases() -> int:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT job.id FROM script_distillation_jobs AS job
            JOIN script_library_scripts AS script ON script.id=job.script_id
            WHERE job.status='failed' AND script.distillation_mode='batch_case'
            """
        ).fetchall()
        if not rows:
            return 0
        ids = [int(row["id"]) for row in rows]
        conn.executemany(
            "UPDATE script_distillation_jobs SET status='queued', error_message=NULL, finished_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            [(job_id,) for job_id in ids],
        )
        conn.executemany(
            "UPDATE script_library_scripts SET status='queued', error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT script_id FROM script_distillation_jobs WHERE id=?)",
            [(job_id,) for job_id in ids],
        )
        conn.commit()
        return len(ids)


def run_case_jobs(*, workers: int) -> dict[str, int]:
    workers = max(1, min(int(workers), int(settings.script_distillation_max_parallel)))
    while True:
        job_ids = _queued_batch_job_ids(workers)
        if not job_ids:
            with get_connection() as conn:
                pending = int(conn.execute(
                    """
                    SELECT COUNT(*) FROM script_distillation_jobs AS job
                    JOIN script_library_scripts AS script ON script.id=job.script_id
                    WHERE script.distillation_mode='batch_case' AND job.status IN ('queued','running')
                    """
                ).fetchone()[0])
            if pending:
                time.sleep(5)
                continue
            break
        with ThreadPoolExecutor(max_workers=len(job_ids)) as executor:
            futures = [executor.submit(run_script_distillation_job, job_id) for job_id in job_ids]
            for future in as_completed(futures):
                future.result()
    return case_ready_counts()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="初始化剧本库：案例卡、公共公式和创作原则。");
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--reset-catalog", action="store_true")
    parser.add_argument("--formulas-only", action="store_true")
    parser.add_argument("--principles-only", action="store_true")
    parser.add_argument("--resume", action="store_true", help="不重置数据，继续当前批处理并在案例卡完成后抽象公式和原则")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    init_db()
    if not args.resume and not args.formulas_only and not args.principles_only:
        prepared = prepare_batch_initialization(reset_catalog=args.reset_catalog)
        print({"prepared": prepared}, flush=True)
        if args.prepare_only:
            return 0
        if args.retry_failed:
            print({"retried": _retry_failed_cases()}, flush=True)
        counts = run_case_jobs(workers=args.workers)
        print({"case_cards": counts}, flush=True)
        if counts["failed"]:
            print("仍有案例卡任务失败，暂不进入全库公式阶段。", file=sys.stderr)
            return 2
    if not args.principles_only:
        formulas = distill_formulas(batch_size=args.batch_size)
        print({"formulas": len(formulas)}, flush=True)
    if not args.formulas_only:
        principles = distill_principles(batch_size=max(8, args.batch_size * 2))
        print({"principles": len(principles)}, flush=True)
        print({"finalized_scripts": finalize_batch_scripts()}, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
