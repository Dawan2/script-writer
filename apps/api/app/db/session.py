import hashlib
import json
import sqlite3
from collections.abc import Iterator

from app.core.config import settings


def get_connection() -> sqlite3.Connection:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.database_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def get_db() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_active INTEGER NOT NULL DEFAULT 1,
                is_system INTEGER NOT NULL DEFAULT 0,
                role_assignments_initialized INTEGER NOT NULL DEFAULT 0,
                auth_version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS roles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                is_system INTEGER NOT NULL DEFAULT 0,
                permissions_configured INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS role_permissions (
                role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                permission_key TEXT NOT NULL,
                PRIMARY KEY (role_id, permission_key)
            );

            CREATE TABLE IF NOT EXISTS user_roles (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
                assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, role_id)
            );

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL REFERENCES users(id),
                name TEXT NOT NULL,
                workspace_dir TEXT NOT NULL UNIQUE,
                target_region TEXT,
                task_type TEXT NOT NULL DEFAULT 'rewrite',
                current_stage TEXT NOT NULL DEFAULT 'project_init',
                status TEXT NOT NULL DEFAULT 'active',
                completed_at TEXT,
                completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                claude_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS project_permissions (
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                permission TEXT NOT NULL CHECK(permission IN ('view', 'edit')),
                granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (project_id, user_id)
            );

            CREATE INDEX IF NOT EXISTS idx_project_permissions_user
                ON project_permissions (user_id, project_id);

            CREATE TABLE IF NOT EXISTS file_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                file_path TEXT NOT NULL,
                edited_by INTEGER NOT NULL REFERENCES users(id),
                content_hash TEXT NOT NULL,
                content_snapshot TEXT,
                operation TEXT NOT NULL DEFAULT 'unknown',
                job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                restored_from_version_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS agent_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                stage TEXT NOT NULL,
                prompt TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                claude_session_id TEXT NOT NULL,
                dry_run INTEGER NOT NULL DEFAULT 0,
                regenerate_current_file INTEGER NOT NULL DEFAULT 0,
                reference_current_file INTEGER,
                optimization_scope TEXT,
                started_at TEXT,
                finished_at TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS credit_accounts (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
                experience_balance INTEGER NOT NULL DEFAULT 0 CHECK(experience_balance >= 0),
                supplemental_balance INTEGER NOT NULL DEFAULT 0 CHECK(supplemental_balance >= 0),
                plan_balance INTEGER NOT NULL DEFAULT 0 CHECK(plan_balance >= 0),
                plan_balance_grant_key TEXT,
                plan_code TEXT NOT NULL DEFAULT 'free',
                plan_assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                plan_expires_at TEXT,
                plan_term_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS credit_stage_prices (
                stage TEXT PRIMARY KEY,
                credits INTEGER NOT NULL CHECK(credits > 0),
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS credit_plan_limits (
                plan_code TEXT PRIMARY KEY,
                max_concurrent_jobs INTEGER NOT NULL CHECK(max_concurrent_jobs > 0),
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS agent_job_credits (
                job_id INTEGER PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                credits INTEGER NOT NULL CHECK(credits > 0),
                experience_credits INTEGER NOT NULL DEFAULT 0 CHECK(experience_credits >= 0),
                supplemental_credits INTEGER NOT NULL DEFAULT 0 CHECK(supplemental_credits >= 0),
                plan_credits INTEGER NOT NULL DEFAULT 0 CHECK(plan_credits >= 0),
                plan_credit_grant_key TEXT,
                status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'settled', 'released')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                settled_at TEXT,
                released_at TEXT
            );

            CREATE TABLE IF NOT EXISTS credit_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                delta INTEGER NOT NULL CHECK(delta <> 0),
                balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS credit_plan_grants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                plan_code TEXT NOT NULL,
                grant_key TEXT NOT NULL,
                credits INTEGER NOT NULL CHECK(credits > 0),
                granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, grant_key)
            );

            CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
            ON credit_ledger(user_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_credit_ledger_job
            ON credit_ledger(job_id);
            CREATE INDEX IF NOT EXISTS idx_agent_job_credits_status
            ON agent_job_credits(status, user_id);
            CREATE INDEX IF NOT EXISTS idx_credit_plan_grants_created
            ON credit_plan_grants(user_id, id DESC);

            CREATE TABLE IF NOT EXISTS preference_summary_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                archive_iteration INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                evidence_json TEXT,
                result_json TEXT,
                error_message TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(project_id, archive_iteration)
            );

            CREATE TABLE IF NOT EXISTS system_notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                job_id INTEGER UNIQUE REFERENCES agent_jobs(id) ON DELETE CASCADE,
                preference_summary_job_id INTEGER UNIQUE REFERENCES preference_summary_jobs(id) ON DELETE CASCADE,
                system_notification_id INTEGER REFERENCES system_notifications(id) ON DELETE CASCADE,
                kind TEXT NOT NULL DEFAULT 'agent_completed',
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                target_stage TEXT,
                target_path TEXT,
                read_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK(
                    job_id IS NOT NULL
                    OR preference_summary_job_id IS NOT NULL
                    OR system_notification_id IS NOT NULL
                )
            );

            CREATE TABLE IF NOT EXISTS agent_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                raw_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS agent_job_recovery_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
                scope TEXT NOT NULL,
                recovery_group TEXT NOT NULL,
                reason_code TEXT NOT NULL,
                attempt INTEGER NOT NULL CHECK(attempt > 0),
                retry_limit INTEGER NOT NULL CHECK(retry_limit > 0),
                delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK(delay_seconds >= 0),
                strategy TEXT NOT NULL,
                checkpoint_path TEXT,
                status TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK(status IN ('scheduled', 'running', 'recovered', 'failed', 'exhausted')),
                root_cause TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(job_id, scope, recovery_group, attempt)
            );

            CREATE TABLE IF NOT EXISTS project_stage_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                claude_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(project_id, stage)
            );

            CREATE TABLE IF NOT EXISTS agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                stage TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS stage_approvals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                artifact_hash TEXT NOT NULL,
                quality_contract_version TEXT,
                memory_revision INTEGER,
                approved_by INTEGER NOT NULL REFERENCES users(id),
                job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS artifact_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                file_path TEXT NOT NULL,
                old_hash TEXT NOT NULL,
                new_hash TEXT NOT NULL,
                change_kind TEXT NOT NULL,
                impact_json TEXT NOT NULL,
                edited_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS document_comment_threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                anchor_start INTEGER NOT NULL,
                anchor_end INTEGER NOT NULL,
                anchor_text TEXT NOT NULL,
                anchor_prefix TEXT NOT NULL DEFAULT '',
                anchor_suffix TEXT NOT NULL DEFAULT '',
                preview_start INTEGER,
                preview_end INTEGER,
                source_job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK(anchor_start >= 0),
                CHECK(anchor_end >= anchor_start)
            );

            CREATE TABLE IF NOT EXISTS document_comment_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id INTEGER NOT NULL REFERENCES document_comment_threads(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                is_root INTEGER NOT NULL DEFAULT 0 CHECK(is_root IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS agent_evolution_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending',
                evidence_json TEXT NOT NULL,
                proposal_json TEXT,
                applied_version TEXT,
                reviewed_by INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS system_agent_evolution_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT NOT NULL DEFAULT 'queued',
                triggered_by INTEGER NOT NULL REFERENCES users(id),
                range_start TEXT,
                range_end TEXT NOT NULL,
                evidence_path TEXT,
                report_path TEXT,
                report_sha256 TEXT,
                execution_requirements TEXT,
                execution_log_path TEXT,
                error_message TEXT,
                analysis_started_at TEXT,
                analysis_completed_at TEXT,
                execution_started_at TEXT,
                execution_completed_at TEXT,
                reviewed_by INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                actor_username TEXT NOT NULL,
                action TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT,
                target_label TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                project_id INTEGER,
                outcome TEXT NOT NULL DEFAULT 'success',
                source TEXT NOT NULL DEFAULT 'api',
                severity TEXT NOT NULL DEFAULT 'info',
                request_id TEXT,
                parent_event_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS writer_preference_profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS writer_preferences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'ai')),
                enabled INTEGER NOT NULL DEFAULT 1,
                position INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                evidence_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS writer_preference_scopes (
                preference_id INTEGER NOT NULL REFERENCES writer_preferences(id) ON DELETE CASCADE,
                scope TEXT NOT NULL CHECK(scope IN (
                    'global', 'novel_analysis', 'world_view', 'outline_rewrite', 'character_rewrite',
                    'trial_generate', 'full_generate', 'dialogue_translate', 'foreign_review', 'humanizer_zh'
                )),
                PRIMARY KEY (preference_id, scope)
            );

            CREATE TABLE IF NOT EXISTS system_writer_preferences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_preference_id INTEGER UNIQUE REFERENCES writer_preferences(id) ON DELETE SET NULL,
                content TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'ai')),
                version INTEGER NOT NULL DEFAULT 1,
                evidence_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS system_writer_preference_scopes (
                system_preference_id INTEGER NOT NULL REFERENCES system_writer_preferences(id) ON DELETE CASCADE,
                scope TEXT NOT NULL CHECK(scope IN (
                    'global', 'novel_analysis', 'world_view', 'outline_rewrite', 'character_rewrite',
                    'trial_generate', 'full_generate', 'dialogue_translate', 'foreign_review', 'humanizer_zh'
                )),
                PRIMARY KEY (system_preference_id, scope)
            );

            CREATE TABLE IF NOT EXISTS user_system_writer_preference_refs (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                system_preference_id INTEGER NOT NULL REFERENCES system_writer_preferences(id) ON DELETE CASCADE,
                enabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, system_preference_id)
            );

            CREATE TABLE IF NOT EXISTS agent_preference_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL UNIQUE REFERENCES agent_jobs(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                stage TEXT NOT NULL,
                profile_revision INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                snapshot_sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS batch_task_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS batch_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id INTEGER NOT NULL REFERENCES batch_task_batches(id) ON DELETE CASCADE,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                scenario TEXT NOT NULL,
                current_stage TEXT,
                stop_after_stage TEXT,
                source_path TEXT NOT NULL,
                input_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'paused', 'succeeded', 'failed')),
                current_job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                last_job_id INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                next_attempt_at TEXT,
                last_error TEXT,
                started_at TEXT,
                finished_at TEXT,
                run_duration_seconds INTEGER NOT NULL DEFAULT 0,
                active_started_at TEXT,
                execution_owner TEXT,
                execution_lease_expires_at TEXT,
                run_count INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS openclaw_api_requests (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                idempotency_key TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                response_json TEXT NOT NULL,
                batch_id INTEGER NOT NULL REFERENCES batch_task_batches(id) ON DELETE RESTRICT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, idempotency_key)
            );

            CREATE TABLE IF NOT EXISTS script_sync_config (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                base_url TEXT,
                base_token TEXT,
                table_id TEXT,
                table_name TEXT,
                fields_json TEXT NOT NULL DEFAULT '[]',
                verified_at TEXT,
                authorization_url TEXT,
                authorization_device_code TEXT,
                authorization_created_at TEXT,
                updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_sync_mappings (
                source_key TEXT PRIMARY KEY,
                source_label TEXT NOT NULL,
                target_field_id TEXT NOT NULL,
                target_field_name TEXT NOT NULL,
                target_field_type TEXT NOT NULL,
                auto_create INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_sync_records (
                project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                base_record_id TEXT,
                target_key TEXT NOT NULL DEFAULT '',
                source_hash TEXT NOT NULL DEFAULT '',
                config_hash TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'synced', 'needs_update', 'failed', 'ignored')),
                synced_at TEXT,
                last_attempt_at TEXT,
                last_error TEXT,
                attachment_tokens_json TEXT NOT NULL DEFAULT '{}',
                synced_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_sync_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
                last_error TEXT,
                started_at TEXT,
                finished_at TEXT,
                execution_owner TEXT,
                execution_lease_expires_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_library_scripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                source_type TEXT NOT NULL CHECK(source_type IN ('manual', 'short-writing-skill')),
                source_label TEXT NOT NULL DEFAULT '',
                original_filename TEXT NOT NULL,
                source_file_path TEXT NOT NULL,
                source_sha256 TEXT NOT NULL UNIQUE,
                chars INTEGER NOT NULL DEFAULT 0,
                episode_count INTEGER,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'ready', 'failed')),
                summary TEXT NOT NULL DEFAULT '',
                theme_tags_json TEXT NOT NULL DEFAULT '[]',
                setting_tags_json TEXT NOT NULL DEFAULT '[]',
                background_tags_json TEXT NOT NULL DEFAULT '[]',
                audience_tags_json TEXT NOT NULL DEFAULT '[]',
                case_card_json TEXT NOT NULL DEFAULT '{}',
                formulas_json TEXT NOT NULL DEFAULT '{}',
                distillation_result_json TEXT NOT NULL DEFAULT '{}',
                distillation_version TEXT NOT NULL DEFAULT '',
                distillation_stage TEXT NOT NULL DEFAULT 'queued',
                distillation_stage_label TEXT NOT NULL DEFAULT '等待处理',
                distillation_progress_current INTEGER NOT NULL DEFAULT 0,
                distillation_progress_total INTEGER NOT NULL DEFAULT 0,
                distillation_progress_message TEXT NOT NULL DEFAULT '等待处理',
                distillation_mode TEXT NOT NULL DEFAULT 'single',
                error_message TEXT,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_library_source_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                script_id INTEGER NOT NULL REFERENCES script_library_scripts(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                locator TEXT NOT NULL,
                start_char INTEGER NOT NULL,
                end_char INTEGER NOT NULL,
                content TEXT NOT NULL,
                UNIQUE(script_id, chunk_index)
            );

            CREATE TABLE IF NOT EXISTS script_library_formula_cards (
                id TEXT PRIMARY KEY,
                formula_type TEXT NOT NULL CHECK(formula_type IN ('core', 'world', 'gratification', 'mechanism')),
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                applicable_tags_json TEXT NOT NULL DEFAULT '[]',
                source_script_ids_json TEXT NOT NULL DEFAULT '[]',
                source_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'active', 'retired')),
                origin TEXT NOT NULL,
                content_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_library_formulas (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL CHECK(category IN (
                    'story_engine', 'world_rule', 'character_relationship', 'long_arc',
                    'episode_structure', 'hook_information', 'audience_payoff',
                    'emotional_progression', 'scene_conflict', 'dialogue_action'
                )),
                name TEXT NOT NULL,
                stages_json TEXT NOT NULL DEFAULT '[]',
                creative_decision TEXT NOT NULL,
                creative_problem TEXT NOT NULL,
                applicable_tags_json TEXT NOT NULL DEFAULT '[]',
                source_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'active', 'retired')),
                origin TEXT NOT NULL DEFAULT 'script-distillation',
                revision INTEGER NOT NULL DEFAULT 1,
                content_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_library_formula_sources (
                formula_id TEXT NOT NULL REFERENCES script_library_formulas(id) ON DELETE CASCADE,
                script_id INTEGER NOT NULL REFERENCES script_library_scripts(id) ON DELETE CASCADE,
                candidate_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('reuse', 'improve', 'create')),
                decision_reason TEXT NOT NULL DEFAULT '',
                evidence_references_json TEXT NOT NULL DEFAULT '[]',
                contribution_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (formula_id, script_id, candidate_id)
            );

            CREATE TABLE IF NOT EXISTS script_library_principles (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                stages_json TEXT NOT NULL DEFAULT '[]',
                statement TEXT NOT NULL,
                rationale TEXT NOT NULL,
                applies_when_json TEXT NOT NULL DEFAULT '[]',
                fails_or_changes_when_json TEXT NOT NULL DEFAULT '[]',
                review_criteria_json TEXT NOT NULL DEFAULT '[]',
                skill_keys_json TEXT NOT NULL DEFAULT '[]',
                source_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'active', 'retired')),
                version INTEGER NOT NULL DEFAULT 1,
                origin TEXT NOT NULL DEFAULT 'manual-review',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_library_principle_observations (
                id TEXT PRIMARY KEY,
                script_id INTEGER NOT NULL REFERENCES script_library_scripts(id) ON DELETE CASCADE,
                local_observation_id TEXT NOT NULL,
                principle_id TEXT REFERENCES script_library_principles(id) ON DELETE SET NULL,
                relation TEXT NOT NULL CHECK(relation IN ('supports', 'bounds', 'counters', 'proposes')),
                stages_json TEXT NOT NULL DEFAULT '[]',
                statement TEXT NOT NULL,
                rationale TEXT NOT NULL,
                applies_when_json TEXT NOT NULL DEFAULT '[]',
                fails_or_changes_when_json TEXT NOT NULL DEFAULT '[]',
                review_criteria_json TEXT NOT NULL DEFAULT '[]',
                related_formula_ids_json TEXT NOT NULL DEFAULT '[]',
                evidence_references_json TEXT NOT NULL DEFAULT '[]',
                decision_reason TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'linked', 'rejected')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(script_id, local_observation_id)
            );

            CREATE TABLE IF NOT EXISTS script_distillation_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                script_id INTEGER NOT NULL REFERENCES script_library_scripts(id) ON DELETE CASCADE,
                requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
                model_config_snapshot_json TEXT,
                error_message TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS script_library_batch_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued'
                    CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
                phase TEXT NOT NULL DEFAULT 'case_cards'
                    CHECK(phase IN ('case_cards', 'formulas', 'principles', 'completed')),
                target_count INTEGER NOT NULL DEFAULT 0,
                case_card_count INTEGER NOT NULL DEFAULT 0,
                formula_count INTEGER NOT NULL DEFAULT 0,
                principle_count INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS ai_model_configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                model_type TEXT NOT NULL CHECK(model_type IN ('claude_code', 'image')),
                request_url TEXT NOT NULL DEFAULT '',
                api_key TEXT NOT NULL DEFAULT '',
                model_name TEXT NOT NULL DEFAULT '',
                api_protocol TEXT NOT NULL DEFAULT 'anthropic' CHECK(api_protocol IN ('anthropic', 'openai')),
                thinking_level TEXT NOT NULL DEFAULT 'medium',
                image_size TEXT NOT NULL DEFAULT '',
                image_output_format TEXT NOT NULL DEFAULT 'png',
                image_watermark INTEGER NOT NULL DEFAULT 0,
                fallback_model_id INTEGER REFERENCES ai_model_configs(id) ON DELETE SET NULL,
                is_enabled INTEGER NOT NULL DEFAULT 1,
                last_tested_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS ai_function_model_routes (
                scenario_key TEXT NOT NULL,
                action_key TEXT NOT NULL,
                model_type TEXT NOT NULL CHECK(model_type IN ('claude_code', 'image')),
                model_config_id INTEGER NOT NULL REFERENCES ai_model_configs(id) ON DELETE RESTRICT,
                updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (scenario_key, action_key)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_one_active_per_project
            ON agent_jobs(project_id)
            WHERE status IN ('queued', 'running');

            CREATE INDEX IF NOT EXISTS idx_agent_events_job_id_id
            ON agent_events(job_id, id);

            CREATE INDEX IF NOT EXISTS idx_agent_events_job_id_seq
            ON agent_events(job_id, seq);

            CREATE INDEX IF NOT EXISTS idx_agent_job_recovery_attempts_job_scope
            ON agent_job_recovery_attempts(job_id, scope, recovery_group, attempt DESC);

            CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at
            ON notifications(user_id, created_at DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
            ON notifications(user_id, id DESC)
            WHERE read_at IS NULL;

            CREATE INDEX IF NOT EXISTS idx_agent_messages_project_stage_id
            ON agent_messages(project_id, stage, id);

            CREATE INDEX IF NOT EXISTS idx_stage_approvals_project_stage_id
            ON stage_approvals(project_id, stage, id);

            CREATE INDEX IF NOT EXISTS idx_artifact_changes_project_stage_id
            ON artifact_changes(project_id, stage, id);

            CREATE INDEX IF NOT EXISTS idx_document_comment_threads_project_stage
            ON document_comment_threads(project_id, stage, id);

            CREATE INDEX IF NOT EXISTS idx_document_comment_messages_thread
            ON document_comment_messages(thread_id, id);

            CREATE INDEX IF NOT EXISTS idx_file_versions_project_stage_id
            ON file_versions(project_id, stage, id DESC);

            CREATE INDEX IF NOT EXISTS idx_projects_deleted_at
            ON projects(deleted_at)
            WHERE deleted_at IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
            ON audit_logs(created_at DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_script_library_scripts_status
            ON script_library_scripts(status, id DESC);

            CREATE INDEX IF NOT EXISTS idx_script_library_source_chunks_script
            ON script_library_source_chunks(script_id, chunk_index);

            CREATE INDEX IF NOT EXISTS idx_script_library_formulas_category
            ON script_library_formulas(category, status, source_count DESC);

            CREATE INDEX IF NOT EXISTS idx_script_library_formula_sources_script
            ON script_library_formula_sources(script_id, formula_id);

            CREATE INDEX IF NOT EXISTS idx_script_library_principles_stage
            ON script_library_principles(status, source_count DESC);

            CREATE INDEX IF NOT EXISTS idx_script_library_principle_observations_script
            ON script_library_principle_observations(script_id, status);

            CREATE INDEX IF NOT EXISTS idx_script_library_batch_runs_status
            ON script_library_batch_runs(status, phase, id);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_script_distillation_one_active_per_script
            ON script_distillation_jobs(script_id)
            WHERE status IN ('queued', 'running');

            CREATE INDEX IF NOT EXISTS idx_audit_logs_target
            ON audit_logs(target_type, target_id, id DESC);

            CREATE INDEX IF NOT EXISTS idx_projects_owner_deleted_at
            ON projects(owner_user_id, deleted_at DESC, id DESC)
            WHERE deleted_at IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_writer_preferences_user_position
            ON writer_preferences(user_id, position, id);

            CREATE INDEX IF NOT EXISTS idx_writer_preference_scopes_scope
            ON writer_preference_scopes(scope, preference_id);

            CREATE INDEX IF NOT EXISTS idx_system_writer_preference_scopes_scope
            ON system_writer_preference_scopes(scope, system_preference_id);

            CREATE INDEX IF NOT EXISTS idx_user_system_writer_preference_refs_user
            ON user_system_writer_preference_refs(user_id, system_preference_id);

            CREATE INDEX IF NOT EXISTS idx_user_system_writer_preference_refs_system
            ON user_system_writer_preference_refs(system_preference_id, user_id);

            CREATE INDEX IF NOT EXISTS idx_agent_preference_snapshots_user_stage
            ON agent_preference_snapshots(user_id, stage, id);

            CREATE INDEX IF NOT EXISTS idx_preference_summary_jobs_user_created
            ON preference_summary_jobs(user_id, created_at DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_preference_summary_jobs_status_id
            ON preference_summary_jobs(status, id);

            CREATE INDEX IF NOT EXISTS idx_system_agent_evolution_runs_created
            ON system_agent_evolution_runs(created_at DESC, id DESC);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_system_agent_evolution_one_active
            ON system_agent_evolution_runs((1))
            WHERE status IN ('queued', 'analyzing', 'applying');

            CREATE INDEX IF NOT EXISTS idx_batch_tasks_scheduler
            ON batch_tasks(status, next_attempt_at, id);

            CREATE INDEX IF NOT EXISTS idx_batch_tasks_project
            ON batch_tasks(project_id, id DESC);

            CREATE INDEX IF NOT EXISTS idx_batch_task_batches_created
            ON batch_task_batches(created_at DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_script_sync_records_status
            ON script_sync_records(status, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_script_sync_jobs_scheduler
            ON script_sync_jobs(status, created_at, id);
            CREATE INDEX IF NOT EXISTS idx_script_sync_jobs_project
            ON script_sync_jobs(project_id, id DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_script_sync_jobs_one_active_per_project
            ON script_sync_jobs(project_id)
            WHERE status IN ('queued', 'running');

            CREATE INDEX IF NOT EXISTS idx_ai_model_configs_type
            ON ai_model_configs(model_type, is_enabled, id);

            CREATE INDEX IF NOT EXISTS idx_role_permissions_permission
            ON role_permissions(permission_key, role_id);
            CREATE INDEX IF NOT EXISTS idx_user_roles_role
            ON user_roles(role_id, user_id);
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(projects)").fetchall()}
        if "task_type" not in columns:
            conn.execute("ALTER TABLE projects ADD COLUMN task_type TEXT NOT NULL DEFAULT 'rewrite'")

        def ensure_preference_scope(scope_table: str, id_column: str, parent_table: str) -> None:
            table = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (scope_table,)
            ).fetchone()
            table_sql = str(table["sql"] or "") if table else ""
            if "humanizer_zh" in table_sql and "novel_analysis" in table_sql:
                return
            replacement = f"{scope_table}_new"
            conn.executescript(
                f"""
                DROP TABLE IF EXISTS {replacement};
                CREATE TABLE {replacement} (
                    {id_column} INTEGER NOT NULL REFERENCES {parent_table}(id) ON DELETE CASCADE,
                    scope TEXT NOT NULL CHECK(scope IN (
                        'global', 'novel_analysis', 'world_view', 'outline_rewrite', 'character_rewrite',
                        'trial_generate', 'full_generate', 'dialogue_translate', 'foreign_review', 'humanizer_zh'
                    )),
                    PRIMARY KEY ({id_column}, scope)
                );
                INSERT INTO {replacement} ({id_column}, scope)
                SELECT {id_column}, scope FROM {scope_table};
                DROP TABLE {scope_table};
                ALTER TABLE {replacement} RENAME TO {scope_table};
                """
            )

        ensure_preference_scope("writer_preference_scopes", "preference_id", "writer_preferences")
        ensure_preference_scope("system_writer_preference_scopes", "system_preference_id", "system_writer_preferences")

        def ensure_script_sync_record_statuses() -> None:
            table = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'script_sync_records'"
            ).fetchone()
            table_sql = str(table["sql"] or "").lower() if table else ""
            if "'ignored'" in table_sql:
                return
            conn.executescript(
                """
                DROP TABLE IF EXISTS script_sync_records_new;
                CREATE TABLE script_sync_records_new (
                    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    base_record_id TEXT,
                    target_key TEXT NOT NULL DEFAULT '',
                    source_hash TEXT NOT NULL DEFAULT '',
                    config_hash TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'synced', 'needs_update', 'failed', 'ignored')),
                    synced_at TEXT,
                    last_attempt_at TEXT,
                    last_error TEXT,
                    attachment_tokens_json TEXT NOT NULL DEFAULT '{}',
                    synced_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO script_sync_records_new (
                    project_id, base_record_id, target_key, source_hash, config_hash, status, synced_at,
                    last_attempt_at, last_error, attachment_tokens_json, synced_by, updated_at
                )
                SELECT
                    project_id, base_record_id, target_key, source_hash, config_hash, status, synced_at,
                    last_attempt_at, last_error, attachment_tokens_json, synced_by, updated_at
                FROM script_sync_records;
                DROP TABLE script_sync_records;
                ALTER TABLE script_sync_records_new RENAME TO script_sync_records;
                CREATE INDEX IF NOT EXISTS idx_script_sync_records_status
                ON script_sync_records(status, updated_at DESC);
                """
            )

        ensure_script_sync_record_statuses()
        # Keep the existing Base column intact, but stop carrying the retired
        # field in locally saved mappings.
        conn.execute("DELETE FROM script_sync_mappings WHERE source_key = 'selling_points'")

        def ensure_script_sync_data_source_mapping() -> None:
            existing_mapping = conn.execute(
                "SELECT 1 FROM script_sync_mappings WHERE source_key = 'data_source'"
            ).fetchone()
            if existing_mapping:
                return
            config = conn.execute(
                "SELECT fields_json FROM script_sync_config WHERE id = 1"
            ).fetchone()
            if not config:
                return
            try:
                fields = json.loads(config["fields_json"] or "[]")
            except (TypeError, json.JSONDecodeError):
                return
            if not isinstance(fields, list):
                return
            field = next(
                (
                    item
                    for item in fields
                    if isinstance(item, dict)
                    and item.get("name") == "剧本来源"
                    and item.get("type") == "select"
                    and not item.get("multiple", False)
                    and item.get("writable", True)
                ),
                None,
            )
            if not field or not field.get("id"):
                return
            conn.execute(
                """
                INSERT INTO script_sync_mappings (
                    source_key, source_label, target_field_id, target_field_name, target_field_type, auto_create, updated_at
                ) VALUES ('data_source', '剧本来源', ?, '剧本来源', 'select', 0, CURRENT_TIMESTAMP)
                """,
                (str(field["id"]),),
            )

        ensure_script_sync_data_source_mapping()
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_writer_preference_scopes_scope
            ON writer_preference_scopes(scope, preference_id);
            CREATE INDEX IF NOT EXISTS idx_system_writer_preference_scopes_scope
            ON system_writer_preference_scopes(scope, system_preference_id);
            """
        )

        def add_column(table: str, name: str, definition: str) -> bool:
            table_columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if name not in table_columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
                return True
            return False

        add_column("file_versions", "previous_content_hash", "TEXT")
        add_column("file_versions", "change_kind", "TEXT NOT NULL DEFAULT 'unknown'")
        add_column("file_versions", "change_summary", "TEXT")
        add_column("file_versions", "memory_revision", "INTEGER")
        add_column("file_versions", "content_snapshot", "TEXT")
        add_column("file_versions", "operation", "TEXT NOT NULL DEFAULT 'unknown'")
        add_column("file_versions", "job_id", "INTEGER")
        add_column("file_versions", "restored_from_version_id", "INTEGER")
        add_column("agent_jobs", "target_stage", "TEXT")
        add_column("agent_jobs", "logical_thread_id", "TEXT")
        add_column("agent_jobs", "regenerate_current_file", "INTEGER NOT NULL DEFAULT 0")
        add_column("agent_jobs", "reference_current_file", "INTEGER")
        add_column("agent_jobs", "optimization_scope", "TEXT")
        add_column("agent_jobs", "raw_log_path", "TEXT")
        add_column("agent_jobs", "raw_log_bytes", "INTEGER")
        add_column("agent_jobs", "raw_log_sha256", "TEXT")
        add_column("agent_jobs", "retry_of_job_id", "INTEGER")
        add_column("agent_jobs", "error_code", "TEXT")
        add_column("agent_jobs", "error_category", "TEXT")
        add_column("agent_jobs", "error_retryable", "INTEGER")
        add_column("agent_jobs", "error_details_json", "TEXT")
        add_column("agent_jobs", "authoring_session_id", "TEXT")
        add_column("agent_jobs", "authoring_session_origin", "TEXT")
        add_column("script_library_scripts", "distillation_result_json", "TEXT NOT NULL DEFAULT '{}'")
        add_column("script_library_scripts", "distillation_stage", "TEXT NOT NULL DEFAULT 'queued'")
        add_column("script_library_scripts", "distillation_stage_label", "TEXT NOT NULL DEFAULT '等待处理'")
        add_column("script_library_scripts", "distillation_progress_current", "INTEGER NOT NULL DEFAULT 0")
        add_column("script_library_scripts", "distillation_progress_total", "INTEGER NOT NULL DEFAULT 0")
        add_column("script_library_scripts", "distillation_progress_message", "TEXT NOT NULL DEFAULT '等待处理'")
        add_column("script_library_scripts", "distillation_mode", "TEXT NOT NULL DEFAULT 'single'")
        add_column("script_library_scripts", "source_project_id", "INTEGER REFERENCES projects(id) ON DELETE SET NULL")
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_script_library_scripts_source_project
            ON script_library_scripts(source_project_id, id DESC)
            """
        )
        add_column("agent_jobs", "execution_owner", "TEXT")
        add_column("agent_jobs", "execution_lease_expires_at", "TEXT")
        add_column("ai_model_configs", "last_tested_at", "TEXT")
        add_column("ai_model_configs", "api_protocol", "TEXT NOT NULL DEFAULT 'anthropic'")
        add_column("agent_jobs", "model_config_snapshot_json", "TEXT")
        add_column("project_stage_sessions", "preference_revision", "INTEGER NOT NULL DEFAULT 0")
        add_column("stage_approvals", "quality_contract_version", "TEXT")
        add_column("users", "is_system", "INTEGER NOT NULL DEFAULT 0")
        add_column("users", "role_assignments_initialized", "INTEGER NOT NULL DEFAULT 0")
        add_column("roles", "permissions_configured", "INTEGER NOT NULL DEFAULT 0")
        add_column("document_comment_threads", "source_job_id", "INTEGER REFERENCES agent_jobs(id) ON DELETE SET NULL")
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_document_comment_threads_source_job_anchor
            ON document_comment_threads(source_job_id, anchor_start, anchor_end)
            WHERE source_job_id IS NOT NULL
            """
        )
        add_column("users", "auth_version", "INTEGER NOT NULL DEFAULT 0")
        add_column("projects", "status", "TEXT NOT NULL DEFAULT 'active'")
        add_column("projects", "completed_at", "TEXT")
        add_column("projects", "completed_by", "INTEGER")
        add_column("batch_tasks", "stop_after_stage", "TEXT")
        add_column("batch_tasks", "run_duration_seconds", "INTEGER")
        add_column("batch_tasks", "active_started_at", "TEXT")
        add_column("audit_logs", "project_id", "INTEGER")
        add_column("audit_logs", "outcome", "TEXT NOT NULL DEFAULT 'success'")
        add_column("audit_logs", "source", "TEXT NOT NULL DEFAULT 'api'")
        add_column("audit_logs", "severity", "TEXT NOT NULL DEFAULT 'info'")
        add_column("audit_logs", "request_id", "TEXT")
        add_column("audit_logs", "parent_event_id", "INTEGER")
        # Older deployments recorded successful connection tests in the audit
        # log before the per-model status field existed. Preserve the latest
        # still-current success so the model list shows it immediately after
        # this upgrade.
        conn.execute(
            """
            UPDATE ai_model_configs
            SET last_tested_at = (
                SELECT MAX(audit.created_at)
                FROM audit_logs AS audit
                WHERE audit.action = 'model_config.test'
                  AND audit.target_type = 'model_config'
                  AND audit.target_id = CAST(ai_model_configs.id AS TEXT)
                  AND audit.outcome = 'success'
                  AND audit.created_at >= ai_model_configs.updated_at
            )
            WHERE last_tested_at IS NULL
              AND EXISTS (
                SELECT 1
                FROM audit_logs AS audit
                WHERE audit.action = 'model_config.test'
                  AND audit.target_type = 'model_config'
                  AND audit.target_id = CAST(ai_model_configs.id AS TEXT)
                  AND audit.outcome = 'success'
                  AND audit.created_at >= ai_model_configs.updated_at
              )
            """
        )
        add_column("credit_accounts", "plan_code", "TEXT NOT NULL DEFAULT 'free'")
        # SQLite cannot add a column with CURRENT_TIMESTAMP as a non-constant
        # default. New databases get the default from CREATE TABLE; existing
        # databases are backfilled immediately below.
        add_column("credit_accounts", "plan_assigned_at", "TEXT")
        add_column("credit_accounts", "plan_expires_at", "TEXT")
        add_column("credit_accounts", "plan_term_id", "INTEGER NOT NULL DEFAULT 0")
        experience_balance_added = add_column("credit_accounts", "experience_balance", "INTEGER NOT NULL DEFAULT 0")
        supplemental_balance_added = add_column("credit_accounts", "supplemental_balance", "INTEGER NOT NULL DEFAULT 0")
        plan_balance_added = add_column("credit_accounts", "plan_balance", "INTEGER NOT NULL DEFAULT 0")
        plan_balance_grant_key_added = add_column("credit_accounts", "plan_balance_grant_key", "TEXT")
        add_column("preference_summary_jobs", "model_config_snapshot_json", "TEXT")
        add_column("system_agent_evolution_runs", "model_config_snapshot_json", "TEXT")
        add_column("script_sync_jobs", "model_config_snapshot_json", "TEXT")
        experience_credits_added = add_column("agent_job_credits", "experience_credits", "INTEGER NOT NULL DEFAULT 0")
        supplemental_credits_added = add_column("agent_job_credits", "supplemental_credits", "INTEGER NOT NULL DEFAULT 0")
        plan_credits_added = add_column("agent_job_credits", "plan_credits", "INTEGER NOT NULL DEFAULT 0")
        add_column("agent_job_credits", "plan_credit_grant_key", "TEXT")
        conn.execute(
            "UPDATE credit_accounts SET plan_assigned_at = COALESCE(plan_assigned_at, updated_at, CURRENT_TIMESTAMP)"
        )
        # Existing paid accounts become one 30-day term from the date they were
        # configured. Timestamps are stored in UTC, so convert through Shanghai
        # midnight to preserve 30 calendar days of daily issuance.
        conn.execute(
            """
            UPDATE credit_accounts
            SET plan_expires_at = DATETIME(
                DATE(DATETIME(plan_assigned_at, '+8 hours'), '+30 days'),
                '-8 hours'
            )
            WHERE plan_code IN ('basic', 'advanced') AND plan_expires_at IS NULL
            """
        )
        if any((experience_balance_added, supplemental_balance_added, plan_balance_added, plan_balance_grant_key_added)):
            today = conn.execute("SELECT DATE('now', '+8 hours')").fetchone()[0]
            account_rows = conn.execute(
                "SELECT user_id, balance, plan_code FROM credit_accounts"
            ).fetchall()
            for account in account_rows:
                user_id = int(account["user_id"])
                balance = int(account["balance"])
                welcome = conn.execute(
                    "SELECT credits FROM credit_plan_grants WHERE user_id = ? AND grant_key = 'welcome'",
                    (user_id,),
                ).fetchone()
                daily_grant = conn.execute(
                    """
                    SELECT grant_key, credits
                    FROM credit_plan_grants
                    WHERE user_id = ? AND grant_key LIKE ?
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (user_id, f"daily:%:{today}"),
                ).fetchone()
                plan_balance = 0
                plan_grant_key = None
                if account["plan_code"] in ("basic", "advanced") and daily_grant:
                    plan_balance = min(balance, int(daily_grant["credits"]))
                    plan_grant_key = daily_grant["grant_key"] if plan_balance else None
                long_lived = balance - plan_balance
                experience_balance = min(long_lived, int(welcome["credits"])) if welcome else 0
                supplemental_balance = long_lived - experience_balance
                conn.execute(
                    """
                    UPDATE credit_accounts
                    SET experience_balance = ?, supplemental_balance = ?, plan_balance = ?,
                        plan_balance_grant_key = ?
                    WHERE user_id = ?
                    """,
                    (experience_balance, supplemental_balance, plan_balance, plan_grant_key, user_id),
                )
        if any((experience_credits_added, supplemental_credits_added, plan_credits_added)):
            # Existing reservations do not contain source metadata. Preserve
            # their full refund value as long-lived supplemental credits.
            conn.execute(
                """
                UPDATE agent_job_credits
                SET experience_credits = 0, supplemental_credits = credits, plan_credits = 0
                WHERE experience_credits = 0 AND supplemental_credits = 0 AND plan_credits = 0
                """
            )
        # Earlier daily grants used the idempotency key as part of the visible
        # ledger note. Keep the key in its dedicated field and leave users with
        # a clear description of the entitlement.
        conn.execute(
            """
            UPDATE credit_ledger
            SET note = CASE
                WHEN INSTR(note, ' · ') > 0
                    THEN SUBSTR(note, 1, INSTR(note, ' · ') - 1) || ' · 当日套餐额度'
                ELSE '当日套餐额度'
            END
            WHERE kind = 'plan_grant' AND note LIKE '%daily:%'
            """
        )
        # Bring today's active package grant and the one-time experience grant
        # up to the current commercial allowance exactly once. The grant row is
        # the source of truth, so checking its previous amount keeps this
        # migration idempotent across restarts.
        today = conn.execute("SELECT DATE('now', '+8 hours')").fetchone()[0]
        quota_upgrades = (
            ("free", "welcome", 51, 55, "experience", "体验套餐 · 额度调整至 55"),
            ("basic", f"daily:%:{today}", 42, 60, "plan", "初级套餐 · 当日套餐额度调整至 60"),
            ("advanced", f"daily:%:{today}", 105, 150, "plan", "高级套餐 · 当日套餐额度调整至 150"),
        )
        for plan_code, grant_key, previous_credits, current_credits, source, note in quota_upgrades:
            is_daily = plan_code in {"basic", "advanced"}
            grant_match = "grant_key LIKE ?" if is_daily else "grant_key = ?"
            active_plan_clause = """
                AND credit_accounts.plan_code = credit_plan_grants.plan_code
                AND credit_accounts.plan_balance_grant_key = credit_plan_grants.grant_key
                AND (credit_accounts.plan_expires_at IS NULL OR credit_accounts.plan_expires_at > CURRENT_TIMESTAMP)
            """ if is_daily else ""
            grants = conn.execute(
                f"""
                SELECT credit_plan_grants.id, credit_plan_grants.user_id
                FROM credit_plan_grants
                JOIN credit_accounts ON credit_accounts.user_id = credit_plan_grants.user_id
                WHERE credit_plan_grants.plan_code = ?
                  AND credit_plan_grants.credits = ?
                  AND {grant_match}
                  {active_plan_clause}
                """,
                (plan_code, previous_credits, grant_key),
            ).fetchall()
            increase = current_credits - previous_credits
            for grant in grants:
                updated_grant = conn.execute(
                    "UPDATE credit_plan_grants SET credits = ? WHERE id = ? AND credits = ?",
                    (current_credits, grant["id"], previous_credits),
                )
                if updated_grant.rowcount != 1:
                    continue
                updated_account = conn.execute(
                    """
                    UPDATE credit_accounts
                    SET balance = balance + ?,
                        experience_balance = experience_balance + CASE WHEN ? = 'experience' THEN ? ELSE 0 END,
                        plan_balance = plan_balance + CASE WHEN ? = 'plan' THEN ? ELSE 0 END,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = ?
                    """,
                    (increase, source, increase, source, increase, grant["user_id"]),
                )
                if updated_account.rowcount != 1:
                    continue
                balance_after = conn.execute(
                    "SELECT balance FROM credit_accounts WHERE user_id = ?", (grant["user_id"],)
                ).fetchone()[0]
                conn.execute(
                    """
                    INSERT INTO credit_ledger (user_id, kind, delta, balance_after, note)
                    VALUES (?, 'plan_grant', ?, ?, ?)
                    """,
                    (grant["user_id"], increase, balance_after, note),
                )

        conn.executemany(
            "INSERT OR IGNORE INTO credit_stage_prices (stage, credits) VALUES (?, ?)",
            [
                ("novel_analysis", 5),
                ("world_view", 1),
                ("character_rewrite", 2),
                ("outline_rewrite", 3),
                ("trial_generate", 5),
                ("full_generate", 10),
                ("dialogue_translate", 4),
                ("foreign_review", 15),
                ("humanizer_zh", 5),
            ],
        )
        # The public scenario was introduced at 3 credits. Upgrade that old
        # default while leaving any administrator-selected non-default price intact.
        conn.execute(
            """
            UPDATE credit_stage_prices
            SET credits = 5, updated_at = CURRENT_TIMESTAMP
            WHERE stage = 'humanizer_zh' AND credits = 3
            """
        )
        conn.executemany(
            """
            INSERT INTO credit_plan_limits (plan_code, max_concurrent_jobs)
            VALUES (?, ?)
            ON CONFLICT(plan_code) DO UPDATE SET
                max_concurrent_jobs = excluded.max_concurrent_jobs,
                updated_at = CURRENT_TIMESTAMP
            """,
            [("free", 1), ("basic", 2), ("advanced", 3)],
        )
        conn.executescript(
            """
            DROP TRIGGER IF EXISTS trg_agent_jobs_user_concurrency_insert;
            DROP TRIGGER IF EXISTS trg_agent_jobs_user_concurrency_requeue;

            CREATE TRIGGER trg_agent_jobs_user_concurrency_insert
            BEFORE INSERT ON agent_jobs
            WHEN NEW.status IN ('queued', 'running')
            BEGIN
                SELECT CASE WHEN (
                    SELECT COUNT(*)
                    FROM agent_jobs
                    WHERE user_id = NEW.user_id AND status IN ('queued', 'running')
                ) >= COALESCE(
                    (
                        SELECT max_concurrent_jobs
                        FROM credit_plan_limits
                        WHERE plan_code = COALESCE((
                            SELECT CASE
                                WHEN plan_code IN ('basic', 'advanced')
                                     AND plan_expires_at IS NOT NULL
                                     AND plan_expires_at <= CURRENT_TIMESTAMP THEN 'free'
                                ELSE plan_code
                            END
                            FROM credit_accounts
                            WHERE user_id = NEW.user_id
                        ), 'free')
                    ),
                    1
                ) AND NOT EXISTS (
                    SELECT 1 FROM agent_jobs
                    WHERE project_id = NEW.project_id AND status IN ('queued', 'running')
                ) THEN RAISE(ABORT, 'AI_CONCURRENCY_LIMIT_REACHED') END;
            END;

            CREATE TRIGGER trg_agent_jobs_user_concurrency_requeue
            BEFORE UPDATE OF status ON agent_jobs
            WHEN NEW.status IN ('queued', 'running')
                 AND OLD.status NOT IN ('queued', 'running')
            BEGIN
                SELECT CASE WHEN (
                    SELECT COUNT(*)
                    FROM agent_jobs
                    WHERE user_id = NEW.user_id AND status IN ('queued', 'running')
                ) >= COALESCE(
                    (
                        SELECT max_concurrent_jobs
                        FROM credit_plan_limits
                        WHERE plan_code = COALESCE((
                            SELECT CASE
                                WHEN plan_code IN ('basic', 'advanced')
                                     AND plan_expires_at IS NOT NULL
                                     AND plan_expires_at <= CURRENT_TIMESTAMP THEN 'free'
                                ELSE plan_code
                            END
                            FROM credit_accounts
                            WHERE user_id = NEW.user_id
                        ), 'free')
                    ),
                    1
                ) AND NOT EXISTS (
                    SELECT 1 FROM agent_jobs
                    WHERE project_id = NEW.project_id AND status IN ('queued', 'running')
                ) THEN RAISE(ABORT, 'AI_CONCURRENCY_LIMIT_REACHED') END;
            END;
            """
        )
        # Existing accounts enter the managed credit system at a zero balance.
        # Administrators can issue the initial balance from the credit console.
        conn.execute(
            "INSERT OR IGNORE INTO credit_accounts (user_id, balance) SELECT id, 0 FROM users"
        )

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_logs_project_created ON audit_logs(project_id, id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_user_id, id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_logs_action_outcome ON audit_logs(action, outcome, id DESC)"
        )

        # Existing records predate elapsed-run tracking. Preserve their completed
        # duration once, then use the dedicated counter for all future updates.
        conn.execute(
            """
            UPDATE batch_tasks
            SET run_duration_seconds = MAX(0, CAST(
                (julianday(COALESCE(finished_at, updated_at)) - julianday(started_at)) * 86400
                AS INTEGER
            ))
            WHERE run_duration_seconds IS NULL AND started_at IS NOT NULL
            """
        )
        conn.execute("UPDATE batch_tasks SET run_duration_seconds = 0 WHERE run_duration_seconds IS NULL")
        conn.execute(
            """
            UPDATE batch_tasks
            SET active_started_at = started_at
            WHERE status = 'running' AND started_at IS NOT NULL AND active_started_at IS NULL
            """
        )

        # Keep existing queued work on the same three-retry contract as newly
        # created tasks. Older records were created when the default was two.
        batch_retry_limit = max(0, int(getattr(settings, "batch_task_auto_retry_limit", 3)))
        conn.execute(
            "UPDATE batch_tasks SET max_retries = ? WHERE max_retries < ?",
            (batch_retry_limit, batch_retry_limit),
        )

        notification_columns = {
            row["name"]: row for row in conn.execute("PRAGMA table_info(notifications)").fetchall()
        }
        notifications_need_rebuild = (
            "preference_summary_job_id" not in notification_columns
            or "target_path" not in notification_columns
            or "system_notification_id" not in notification_columns
            or bool(notification_columns.get("job_id") and notification_columns["job_id"]["notnull"])
        )
        if notifications_need_rebuild:
            conn.executescript(
                """
                CREATE TABLE notifications_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                    job_id INTEGER UNIQUE REFERENCES agent_jobs(id) ON DELETE CASCADE,
                    preference_summary_job_id INTEGER UNIQUE REFERENCES preference_summary_jobs(id) ON DELETE CASCADE,
                    system_notification_id INTEGER REFERENCES system_notifications(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL DEFAULT 'agent_completed',
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    target_stage TEXT,
                    target_path TEXT,
                    read_at TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CHECK(
                        job_id IS NOT NULL
                        OR preference_summary_job_id IS NOT NULL
                        OR system_notification_id IS NOT NULL
                    )
                );
                """
            )
            migration_columns = [
                name
                for name in (
                    "id",
                    "user_id",
                    "project_id",
                    "job_id",
                    "preference_summary_job_id",
                    "system_notification_id",
                    "kind",
                    "title",
                    "message",
                    "target_stage",
                    "target_path",
                    "read_at",
                    "created_at",
                )
                if name in notification_columns
            ]
            if migration_columns:
                columns_sql = ", ".join(migration_columns)
                conn.execute(
                    f"INSERT INTO notifications_v2 ({columns_sql}) "
                    f"SELECT {columns_sql} FROM notifications"
                )
            conn.executescript(
                """
                DROP TABLE notifications;
                ALTER TABLE notifications_v2 RENAME TO notifications;
                """
            )

        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at
            ON notifications(user_id, created_at DESC, id DESC)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
            ON notifications(user_id, id DESC)
            WHERE read_at IS NULL
            """
        )

        conn.execute("UPDATE projects SET status = 'active' WHERE status IS NULL OR status NOT IN ('active', 'completed')")
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_projects_status_created_at
            ON projects(status, created_at DESC)
            WHERE deleted_at IS NULL
            """
        )

        legacy_log_jobs = conn.execute(
            "SELECT id FROM agent_jobs WHERE raw_log_path IS NULL OR raw_log_sha256 IS NULL"
        ).fetchall()
        for legacy_job in legacy_log_jobs:
            log_path = settings.data_dir / "zdebug" / "jobs" / f"agent_job_{legacy_job['id']}.jsonl"
            if not log_path.exists():
                continue
            digest = hashlib.sha256()
            with log_path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
            conn.execute(
                """
                UPDATE agent_jobs
                SET raw_log_path = ?, raw_log_bytes = ?, raw_log_sha256 = ?
                WHERE id = ?
                """,
                (str(log_path), log_path.stat().st_size, digest.hexdigest(), legacy_job["id"]),
            )

        conn.execute(
            """
            UPDATE agent_jobs
            SET target_stage = CASE
                    WHEN stage IN ('novel_analysis', 'world_view', 'outline_rewrite', 'character_rewrite', 'trial_generate', 'full_generate', 'dialogue_translate', 'foreign_review', 'humanizer_zh') THEN stage
                    ELSE COALESCE((SELECT current_stage FROM projects WHERE projects.id = agent_jobs.project_id), stage)
                END,
                logical_thread_id = COALESCE(
                    logical_thread_id,
                    (SELECT claude_session_id FROM projects WHERE projects.id = agent_jobs.project_id)
                )
            WHERE target_stage IS NULL OR logical_thread_id IS NULL
            """
        )

        # Seed historical completions as already read so the list has context
        # without showing a migration-time unread badge.
        conn.execute(
            """
            INSERT INTO notifications (
                user_id, project_id, job_id, kind, title, message,
                target_stage, read_at, created_at
            )
            SELECT
                job.user_id,
                job.project_id,
                job.id,
                'agent_completed',
                CASE job.stage
                    WHEN 'chat_edit' THEN '对话调整已完成'
                    WHEN 'all' THEN '全流程生成已完成'
                    ELSE 'AI 任务已完成'
                END,
                '「' || project.name || '」的最新结果已更新',
                CASE
                    WHEN job.stage = 'all' THEN project.current_stage
                    ELSE COALESCE(job.target_stage, job.stage)
                END,
                COALESCE(job.finished_at, job.updated_at),
                COALESCE(job.finished_at, job.updated_at)
            FROM agent_jobs AS job
            JOIN projects AS project ON project.id = job.project_id
            WHERE job.status = 'succeeded'
            ON CONFLICT(job_id) DO NOTHING
            """
        )

        # Preserve pre-migration project conversations without reusing their oversized sessions.
        legacy_jobs = conn.execute(
            """
            SELECT job.* FROM agent_jobs AS job
            WHERE NOT EXISTS (SELECT 1 FROM agent_messages WHERE agent_messages.job_id = job.id)
            ORDER BY job.id
            """
        ).fetchall()
        for job in legacy_jobs:
            stage = job["target_stage"] or job["stage"]
            if job["prompt"]:
                conn.execute(
                    """
                    INSERT INTO agent_messages (project_id, job_id, stage, role, content, metadata_json, created_at)
                    VALUES (?, ?, ?, 'user', ?, ?, ?)
                    """,
                    (
                        job["project_id"],
                        job["id"],
                        stage,
                        job["prompt"],
                        json.dumps({"migrated": True, "requested_stage": job["stage"]}, ensure_ascii=False),
                        job["created_at"],
                    ),
                )
            events = conn.execute(
                "SELECT * FROM agent_events WHERE job_id = ? ORDER BY id DESC",
                (job["id"],),
            ).fetchall()
            result_text = ""
            result_metadata = {"migrated": True}
            for event in events:
                if event["raw_json"]:
                    try:
                        raw = json.loads(event["raw_json"])
                    except json.JSONDecodeError:
                        raw = {}
                    if raw.get("type") == "result" and raw.get("result"):
                        result_text = str(raw["result"])
                        result_metadata.update({
                            "is_error": bool(raw.get("is_error")),
                            "duration_ms": raw.get("duration_ms"),
                            "num_turns": raw.get("num_turns"),
                            "total_cost_usd": raw.get("total_cost_usd"),
                        })
                        break
                if event["event_type"] == "result" or event["message"].startswith(("✔", "✖")):
                    result_text = event["message"]
                    break
            if result_text:
                conn.execute(
                    """
                    INSERT INTO agent_messages (project_id, job_id, stage, role, content, metadata_json, created_at)
                    VALUES (?, ?, ?, 'assistant', ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
                    """,
                    (
                        job["project_id"],
                        job["id"],
                        stage,
                        result_text,
                        json.dumps(result_metadata, ensure_ascii=False),
                        job["finished_at"],
                    ),
                )

        # Keep legacy accounts working immediately after the RBAC migration.
        from app.services.role_service import ensure_role_defaults

        ensure_role_defaults(conn)
