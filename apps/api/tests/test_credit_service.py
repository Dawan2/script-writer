from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.db import session
from app.services import agent_runner, credit_service


class CreditServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.settings = SimpleNamespace(
            data_dir=root / "data",
            database_path=root / "data" / "app.db",
        )
        self.original_settings = session.settings
        session.settings = self.settings
        session.init_db()
        self.conn = session.get_connection()
        self.conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'writer', '编剧', 'hash')"
        )
        self.conn.execute(
            "INSERT INTO projects (id, owner_user_id, name, workspace_dir, claude_session_id) VALUES (1, 1, '测试项目', 'workspaces/test', 'session')"
        )
        self.conn.execute(
            "INSERT INTO agent_jobs (id, project_id, user_id, stage, target_stage, status, claude_session_id) VALUES (1, 1, 1, 'chat_edit', 'full_generate', 'succeeded', 'session')"
        )
        self.conn.execute("INSERT INTO credit_accounts (user_id, balance) VALUES (1, 20)")
        self.job = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 1").fetchone()

    def add_project(self, project_id: int) -> sqlite3.Row:
        self.conn.execute(
            """
            INSERT INTO projects (id, owner_user_id, name, workspace_dir, claude_session_id)
            VALUES (?, 1, ?, ?, 'session')
            """,
            (project_id, f"测试项目{project_id}", f"workspaces/test-{project_id}"),
        )
        return self.conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()

    def add_job(self, job_id: int, project_id: int, *, job_status: str = "queued") -> sqlite3.Row:
        self.conn.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, user_id, stage, target_stage, status, claude_session_id
            ) VALUES (?, ?, 1, 'chat_edit', 'full_generate', ?, 'session')
            """,
            (job_id, project_id, job_status),
        )
        return self.conn.execute("SELECT * FROM agent_jobs WHERE id = ?", (job_id,)).fetchone()

    def tearDown(self) -> None:
        self.conn.close()
        session.settings = self.original_settings
        self.temp_dir.cleanup()

    def test_stage_prices_match_the_product_credit_scale(self) -> None:
        prices = {item["stage"]: item["credits"] for item in credit_service.public_prices(self.conn)}

        self.assertEqual(prices, {
            "novel_analysis": 5,
            "world_view": 1,
            "character_rewrite": 2,
            "outline_rewrite": 3,
            "trial_generate": 5,
            "full_generate": 10,
            "dialogue_translate": 4,
            "foreign_review": 15,
            "humanizer_zh": 5,
        })

    def test_legacy_humanize_price_is_migrated_without_overwriting_a_custom_price(self) -> None:
        self.conn.execute("UPDATE credit_stage_prices SET credits = 3 WHERE stage = 'humanizer_zh'")
        self.conn.commit()
        session.init_db()
        migrated = self.conn.execute(
            "SELECT credits FROM credit_stage_prices WHERE stage = 'humanizer_zh'"
        ).fetchone()
        self.assertEqual(migrated["credits"], 5)

        self.conn.execute("UPDATE credit_stage_prices SET credits = 6 WHERE stage = 'humanizer_zh'")
        self.conn.commit()
        session.init_db()
        preserved = self.conn.execute(
            "SELECT credits FROM credit_stage_prices WHERE stage = 'humanizer_zh'"
        ).fetchone()
        self.assertEqual(preserved["credits"], 6)

    def test_paid_plan_issues_today_then_daily_for_thirty_days_and_expires(self) -> None:
        started_at = datetime(2020, 7, 1, 4, tzinfo=timezone.utc)
        assigned = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="basic",
            granted_by=1,
            now=started_at,
        )

        self.assertEqual(assigned["plan"]["label"], "初级套餐")
        self.assertEqual(assigned["plan"]["allowance"], 60)
        self.assertTrue(assigned["initial_granted"])
        self.assertEqual(assigned["balance"], 80)
        self.assertEqual(assigned["plan_grant"]["grant_key"], "daily:1:2020-07-01")
        self.assertEqual(assigned["plan_term"]["expires_on"], "2020-07-30")
        self.assertEqual(assigned["plan_term"]["days_remaining"], 30)
        self.assertEqual(
            credit_service.credit_summary(self.conn, user_id=1)["transactions"][0]["note"],
            "初级套餐 · 当日套餐额度",
        )

        with self.assertRaises(HTTPException) as raised:
            credit_service.grant_current_plan_credits(
                self.conn,
                user_id=1,
                granted_by=1,
                now=started_at,
            )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(credit_service.credit_summary(self.conn, user_id=1)["balance"], 80)

        self.assertEqual(credit_service.grant_due_plan_credits(self.conn, now=started_at), [])
        for day in range(1, 30):
            issued = credit_service.grant_due_plan_credits(
                self.conn,
                now=started_at + timedelta(days=day),
            )
            self.assertEqual(len(issued), 1)
            self.assertEqual(issued[0]["plan_grant"]["grant_key"], f"daily:1:2020-07-{day + 1:02d}")

        before_expiry = credit_service.credit_summary(self.conn, user_id=1)
        self.assertEqual(before_expiry["balance"], 80)
        self.assertEqual(before_expiry["balances"], {"experience": 0, "supplemental": 20, "plan": 60})
        self.assertEqual(
            credit_service.grant_due_plan_credits(self.conn, now=started_at + timedelta(days=30)),
            [],
        )
        summary = credit_service.credit_summary(self.conn, user_id=1)
        self.assertEqual(summary["balance"], 20)
        self.assertEqual(summary["balances"], {"experience": 0, "supplemental": 20, "plan": 0})
        self.assertEqual(summary["plan_term"]["status"], "expired")
        self.assertEqual(summary["concurrency"]["limit"], 1)

    def test_resetting_a_paid_plan_creates_a_new_term_and_issues_today(self) -> None:
        opened_at = datetime(2020, 7, 1, 4, tzinfo=timezone.utc)
        first = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="basic",
            granted_by=1,
            now=opened_at,
        )
        renewed = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="advanced",
            granted_by=1,
            now=opened_at,
        )

        self.assertEqual(first["plan_grant"]["grant_key"], "daily:1:2020-07-01")
        self.assertEqual(renewed["plan_grant"]["grant_key"], "daily:2:2020-07-01")
        self.assertTrue(renewed["initial_granted"])
        self.assertEqual(renewed["balance"], 20 + 150)
        self.assertEqual(renewed["plan_term"]["expires_on"], "2020-07-30")

    def test_experience_credits_are_used_first_and_paid_credits_reset_each_day(self) -> None:
        opened_at = datetime(2020, 7, 1, 4, tzinfo=timezone.utc)
        self.conn.execute(
            """
            UPDATE credit_accounts
            SET balance = 30, experience_balance = 30, supplemental_balance = 0,
                plan_balance = 0, plan_balance_grant_key = NULL
            WHERE user_id = 1
            """
        )

        subscribed = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="basic",
            granted_by=1,
            now=opened_at,
        )
        self.assertEqual(subscribed["balance"], 90)
        self.assertEqual(
            credit_service.credit_summary(self.conn, user_id=1)["balances"],
            {"experience": 30, "supplemental": 0, "plan": 60},
        )

        credit_service.grant_due_plan_credits(self.conn, now=opened_at + timedelta(days=1))
        after_midnight = credit_service.credit_summary(self.conn, user_id=1)
        self.assertEqual(after_midnight["balance"], 90)
        self.assertEqual(after_midnight["balances"], {"experience": 30, "supplemental": 0, "plan": 60})
        self.assertEqual(
            self.conn.execute("SELECT kind, delta FROM credit_ledger ORDER BY id DESC LIMIT 2").fetchall()[1]["kind"],
            "plan_expire",
        )

        reserved = credit_service.reserve_job_credits(
            self.conn,
            job=self.job,
            quote=credit_service.quote_for_stages(self.conn, ["full_generate"]),
        )
        self.assertEqual(reserved["balance"], 80)
        self.assertEqual(
            credit_service.credit_summary(self.conn, user_id=1)["balances"],
            {"experience": 20, "supplemental": 0, "plan": 60},
        )
        allocation = self.conn.execute(
            "SELECT experience_credits, supplemental_credits, plan_credits FROM agent_job_credits WHERE job_id = 1"
        ).fetchone()
        self.assertEqual(tuple(allocation), (10, 0, 0))

        admin_account = credit_service.admin_credit_overview(self.conn)["accounts"][0]
        self.assertEqual(
            admin_account["balances"],
            {"experience": 20, "supplemental": 0, "plan": 60},
        )

    def test_yesterday_plan_reservation_is_not_refunded_into_today_plan(self) -> None:
        opened_at = datetime(2020, 7, 1, 4, tzinfo=timezone.utc)
        self.conn.execute(
            """
            UPDATE credit_accounts
            SET balance = 0, experience_balance = 0, supplemental_balance = 0,
                plan_balance = 0, plan_balance_grant_key = NULL
            WHERE user_id = 1
            """
        )
        credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="basic",
            granted_by=1,
            now=opened_at,
        )
        credit_service.reserve_job_credits(
            self.conn,
            job=self.job,
            quote=credit_service.quote_for_stages(self.conn, ["full_generate"]),
        )
        credit_service.grant_due_plan_credits(self.conn, now=opened_at + timedelta(days=1))

        credit_service.release_job_credits(
            self.conn,
            job_id=1,
            now=opened_at + timedelta(days=1),
        )

        summary = credit_service.credit_summary(self.conn, user_id=1)
        self.assertEqual(summary["balance"], 60)
        self.assertEqual(summary["balances"], {"experience": 0, "supplemental": 0, "plan": 60})
        self.assertEqual(
            self.conn.execute("SELECT status FROM agent_job_credits WHERE job_id = 1").fetchone()["status"],
            "released",
        )

    def test_saving_an_active_paid_plan_again_does_not_renew_or_duplicate_today(self) -> None:
        opened_at = datetime(2020, 7, 1, 4, tzinfo=timezone.utc)
        first = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="basic",
            granted_by=1,
            now=opened_at,
        )
        saved_again = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="basic",
            granted_by=1,
            now=opened_at,
        )

        self.assertTrue(first["initial_granted"])
        self.assertFalse(saved_again["initial_granted"])
        self.assertEqual(saved_again["balance"], first["balance"])
        self.assertEqual(saved_again["plan_grant"]["grant_key"], "daily:1:2020-07-01")
        self.assertEqual(saved_again["plan_term"]["expires_on"], first["plan_term"]["expires_on"])

    def test_free_plan_allowance_can_only_be_granted_once(self) -> None:
        first = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="free",
            granted_by=1,
            now=datetime(2020, 7, 1, 4, tzinfo=timezone.utc),
        )
        self.assertEqual(first["balance"], 75)
        self.assertTrue(first["initial_granted"])
        self.assertEqual(first["plan_term"]["status"], "unlimited")

        second = credit_service.set_user_credit_plan(
            self.conn,
            user_id=1,
            plan_code="free",
            granted_by=1,
            now=datetime(2020, 7, 2, 4, tzinfo=timezone.utc),
        )
        self.assertFalse(second["initial_granted"])
        self.assertEqual(second["balance"], 75)

    def test_plan_allowances_remain_fixed_when_stage_prices_change(self) -> None:
        prices = dict(credit_service.STAGE_CREDITS)
        prices["full_generate"] = 12
        prices["foreign_review"] = 18
        credit_service.update_stage_prices(self.conn, prices=prices)

        plans = {item["code"]: item for item in credit_service.public_plans(self.conn)}

        self.assertEqual(plans["free"]["allowance"], 55)
        self.assertEqual(plans["basic"]["allowance"], 60)
        self.assertEqual(plans["advanced"]["allowance"], 150)
        self.assertEqual(plans["free"]["description"], "预估可完成 1 次完整剧本改写，和 1 次海外审稿。")
        self.assertEqual(plans["basic"]["description"], "预估每天可完成 1 次完整剧本改写。")
        self.assertEqual(plans["advanced"]["description"], "预估每天可完成 3 次完整剧本改写。")

    def test_existing_current_grants_are_upgraded_to_the_new_allowances_once(self) -> None:
        today = self.conn.execute("SELECT DATE('now', '+8 hours')").fetchone()[0]
        daily_key = f"daily:1:{today}"
        self.conn.execute(
            """
            UPDATE credit_accounts
            SET balance = 156, experience_balance = 51, supplemental_balance = 0,
                plan_balance = 105, plan_balance_grant_key = ?, plan_code = 'advanced',
                plan_expires_at = DATETIME('now', '+1 day')
            WHERE user_id = 1
            """,
            (daily_key,),
        )
        self.conn.execute(
            """
            INSERT INTO credit_plan_grants (user_id, plan_code, grant_key, credits)
            VALUES (1, 'free', 'welcome', 51), (1, 'advanced', ?, 105)
            """,
            (daily_key,),
        )
        self.conn.commit()

        session.init_db()

        account = self.conn.execute(
            "SELECT balance, experience_balance, plan_balance FROM credit_accounts WHERE user_id = 1"
        ).fetchone()
        self.assertEqual(tuple(account), (205, 55, 150))
        grants = {
            row["grant_key"]: row["credits"]
            for row in self.conn.execute(
                "SELECT grant_key, credits FROM credit_plan_grants WHERE user_id = 1"
            ).fetchall()
        }
        self.assertEqual(grants, {"welcome": 55, daily_key: 150})
        adjustments = self.conn.execute(
            "SELECT delta, note FROM credit_ledger WHERE user_id = 1 ORDER BY id"
        ).fetchall()
        self.assertEqual([(row["delta"], row["note"]) for row in adjustments], [
            (4, "体验套餐 · 额度调整至 55"),
            (45, "高级套餐 · 当日套餐额度调整至 150"),
        ])

        session.init_db()
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM credit_ledger WHERE user_id = 1").fetchone()[0],
            2,
        )

    def test_plan_concurrency_limits_are_one_two_and_three(self) -> None:
        plans = {item["code"]: item for item in credit_service.public_plans(self.conn)}

        self.assertEqual(plans["free"]["max_concurrent_jobs"], 1)
        self.assertEqual(plans["basic"]["max_concurrent_jobs"], 2)
        self.assertEqual(plans["advanced"]["max_concurrent_jobs"], 3)

    def test_each_plan_accepts_its_limit_and_trigger_rejects_the_next_job(self) -> None:
        next_project_id = 10
        next_job_id = 10
        for plan_code, limit in (("free", 1), ("basic", 2), ("advanced", 3)):
            with self.subTest(plan_code=plan_code):
                self.conn.execute(
                    "UPDATE credit_accounts SET plan_code = ? WHERE user_id = 1",
                    (plan_code,),
                )
                for _ in range(limit):
                    self.add_project(next_project_id)
                    self.add_job(next_job_id, next_project_id)
                    next_project_id += 1
                    next_job_id += 1

                summary = credit_service.credit_summary(self.conn, user_id=1)
                self.assertEqual(summary["concurrency"]["active"], limit)
                self.assertEqual(summary["concurrency"]["limit"], limit)
                self.assertTrue(summary["concurrency"]["reached"])
                self.assertIn("请等待其中一个任务完成或取消后再试", summary["concurrency"]["message"])

                self.add_project(next_project_id)
                with self.assertRaises(sqlite3.IntegrityError) as raised:
                    self.add_job(next_job_id, next_project_id)
                self.assertIn(credit_service.CONCURRENCY_LIMIT_ERROR, str(raised.exception))
                next_project_id += 1
                next_job_id += 1
                self.conn.execute(
                    "UPDATE agent_jobs SET status = 'succeeded' WHERE status IN ('queued', 'running')"
                )

    def test_finished_or_canceled_task_releases_concurrency_capacity(self) -> None:
        self.add_project(2)
        self.add_job(2, 2)
        with self.assertRaises(HTTPException):
            credit_service.ensure_concurrent_job_capacity(self.conn, user_id=1)

        self.conn.execute("UPDATE agent_jobs SET status = 'canceled' WHERE id = 2")

        credit_service.ensure_concurrent_job_capacity(self.conn, user_id=1)
        summary = credit_service.credit_summary(self.conn, user_id=1)
        self.assertEqual(summary["concurrency"]["active"], 0)
        self.assertEqual(summary["concurrency"]["available"], 1)

    def test_concurrency_rejection_does_not_create_job_or_reserve_credits(self) -> None:
        self.add_project(2)
        self.add_job(2, 2)
        project = self.add_project(3)
        user = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()

        with self.assertRaises(HTTPException) as raised:
            agent_runner.create_job(
                self.conn,
                project=project,
                user=user,
                stage="chat_edit",
                target_stage="full_generate",
                prompt="请调整当前剧本",
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("最多可同时运行 1 个 AI 任务", raised.exception.detail)
        self.assertIsNone(self.conn.execute("SELECT id FROM agent_jobs WHERE project_id = 3").fetchone())
        self.assertEqual(credit_service.credit_summary(self.conn, user_id=1)["balance"], 20)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) AS count FROM agent_job_credits").fetchone()["count"], 0)

    def test_novel_admission_rejection_happens_before_job_creation_and_credit_reservation(self) -> None:
        self.add_project(2)
        self.conn.execute("UPDATE projects SET task_type = 'novel' WHERE id = 2")
        project = self.conn.execute("SELECT * FROM projects WHERE id = 2").fetchone()
        user = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()
        rejection = HTTPException(
            status_code=422,
            detail="这是一部 50.1 万字的宏篇巨著，剧本化效果不会很好。\n建议分多季，每季30万字左右，再按季实现剧本化。",
        )

        with patch.object(agent_runner, "assert_novel_analysis_admission", side_effect=rejection) as admission:
            with self.assertRaises(HTTPException) as raised:
                agent_runner.create_job(
                    self.conn,
                    project=project,
                    user=user,
                    stage="chat_edit",
                    target_stage="novel_analysis",
                    prompt="开始小说解读",
                )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("建议分多季", raised.exception.detail)
        admission.assert_called_once_with(project)
        self.assertIsNone(self.conn.execute("SELECT id FROM agent_jobs WHERE project_id = 2").fetchone())
        self.assertEqual(self.conn.execute("SELECT COUNT(*) AS count FROM agent_job_credits").fetchone()["count"], 0)

    def test_database_trigger_blocks_requeue_when_capacity_is_full(self) -> None:
        self.add_project(2)
        self.add_job(2, 2)
        self.add_project(3)
        self.add_job(3, 3, job_status="failed")

        with self.assertRaises(sqlite3.IntegrityError) as raised:
            self.conn.execute("UPDATE agent_jobs SET status = 'queued' WHERE id = 3")

        self.assertIn(credit_service.CONCURRENCY_LIMIT_ERROR, str(raised.exception))
        self.assertEqual(self.conn.execute("SELECT status FROM agent_jobs WHERE id = 3").fetchone()["status"], "failed")

    def test_failed_continuation_retry_is_blocked_when_capacity_is_full(self) -> None:
        self.conn.execute("UPDATE agent_jobs SET status = 'failed' WHERE id = 1")
        source = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 1").fetchone()
        project = self.conn.execute("SELECT * FROM projects WHERE id = 1").fetchone()
        self.add_project(2)
        self.add_job(2, 2)

        with patch.object(agent_runner, "job_has_resumable_continuation", return_value=True):
            with self.assertRaises(HTTPException) as raised:
                agent_runner.resume_failed_continuation_job(
                    self.conn,
                    job=source,
                    project=project,
                    username="writer",
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("最多可同时运行 1 个 AI 任务", raised.exception.detail)
        self.assertEqual(self.conn.execute("SELECT status FROM agent_jobs WHERE id = 1").fetchone()["status"], "failed")

    def test_reserve_settle_and_release_keep_a_ledger(self) -> None:
        quote = credit_service.quote_for_stages(self.conn, ["full_generate"])
        reserved = credit_service.reserve_job_credits(self.conn, job=self.job, quote=quote)

        self.assertTrue(reserved["managed"])
        self.assertEqual(reserved["balance"], 10)
        self.assertEqual(credit_service.job_credit_details(self.conn, job_id=1), {"credits": 10, "status": "reserved"})

        credit_service.settle_job_credits(self.conn, job_id=1)
        self.assertEqual(credit_service.job_credit_details(self.conn, job_id=1), {"credits": 10, "status": "settled"})
        self.conn.execute("UPDATE agent_jobs SET status = 'succeeded' WHERE id = 1")

        self.conn.execute(
            "INSERT INTO agent_jobs (id, project_id, user_id, stage, target_stage, claude_session_id) VALUES (2, 1, 1, 'chat_edit', 'outline_rewrite', 'session')"
        )
        retry_job = self.conn.execute("SELECT * FROM agent_jobs WHERE id = 2").fetchone()
        credit_service.reserve_job_credits(
            self.conn,
            job=retry_job,
            quote=credit_service.quote_for_stages(self.conn, ["outline_rewrite"]),
        )
        credit_service.release_job_credits(self.conn, job_id=2)

        self.assertEqual(credit_service.credit_summary(self.conn, user_id=1)["balance"], 10)
        self.assertEqual(credit_service.job_credit_details(self.conn, job_id=2), {"credits": 3, "status": "released"})
        ledger = self.conn.execute("SELECT kind, delta FROM credit_ledger ORDER BY id").fetchall()
        self.assertEqual([(row["kind"], row["delta"]) for row in ledger], [
            ("reserve", -10),
            ("reserve", -3),
            ("release", 3),
        ])

    def test_insufficient_balance_does_not_create_a_reservation(self) -> None:
        quote = credit_service.quote_for_stages(self.conn, ["full_generate", "foreign_review"])
        with self.assertRaises(HTTPException) as raised:
            credit_service.reserve_job_credits(self.conn, job=self.job, quote=quote)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIsNone(credit_service.job_credit_details(self.conn, job_id=1))
        self.assertEqual(credit_service.credit_summary(self.conn, user_id=1)["balance"], 20)

    def test_resuming_a_released_job_reserves_the_original_amount_again(self) -> None:
        credit_service.reserve_job_credits(
            self.conn,
            job=self.job,
            quote=credit_service.quote_for_stages(self.conn, ["full_generate"]),
        )
        credit_service.release_job_credits(self.conn, job_id=1)

        resumed = credit_service.re_reserve_job_credits(self.conn, job_id=1)

        self.assertTrue(resumed["managed"])
        self.assertEqual(resumed["credits"], 10)
        self.assertEqual(resumed["balance"], 10)
        self.assertEqual(credit_service.job_credit_details(self.conn, job_id=1), {"credits": 10, "status": "reserved"})

    def test_insufficient_balance_does_not_leave_a_queued_job(self) -> None:
        self.conn.execute("UPDATE credit_accounts SET balance = 0 WHERE user_id = 1")
        self.conn.execute(
            "INSERT INTO projects (id, owner_user_id, name, workspace_dir, claude_session_id) VALUES (2, 1, '第二个项目', 'workspaces/second', 'session')"
        )
        project = self.conn.execute("SELECT * FROM projects WHERE id = 2").fetchone()
        user = self.conn.execute("SELECT * FROM users WHERE id = 1").fetchone()

        with self.assertRaises(HTTPException) as raised:
            agent_runner.create_job(
                self.conn,
                project=project,
                user=user,
                stage="chat_edit",
                target_stage="full_generate",
                prompt="请调整当前剧本",
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIsNone(self.conn.execute("SELECT id FROM agent_jobs WHERE project_id = 2").fetchone())
        self.assertEqual(credit_service.credit_summary(self.conn, user_id=1)["balance"], 0)

    def test_recovery_superseding_an_old_job_releases_its_reservation(self) -> None:
        self.conn.execute("UPDATE agent_jobs SET status = 'queued' WHERE id = 1")
        credit_service.reserve_job_credits(
            self.conn,
            job=self.job,
            quote=credit_service.quote_for_stages(self.conn, ["full_generate"]),
        )
        self.conn.execute(
            """
            INSERT INTO agent_jobs (id, project_id, user_id, stage, target_stage, status, claude_session_id)
            VALUES (2, 1, 1, 'chat_edit', 'outline_rewrite', 'failed', 'session')
            """
        )

        released = agent_runner.release_stale_project_recovery_slot(
            self.conn,
            job_id=2,
            project_id=1,
        )

        self.assertTrue(released)
        self.assertEqual(credit_service.credit_summary(self.conn, user_id=1)["balance"], 20)
        self.assertEqual(credit_service.job_credit_details(self.conn, job_id=1), {"credits": 10, "status": "released"})


if __name__ == "__main__":
    unittest.main()
