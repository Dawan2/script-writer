from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


LOCAL_SCRIPT_SYNC_WEB_BASE_URL = "http://127.0.0.1:3000"
LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN = "orca-script-workbench-local-script-sync"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = "虎鲸｜剧本出海工作站 API"
    secret_key: str = "dev-change-me-before-production"
    access_token_expire_minutes: int = 60 * 24 * 7
    # Long-form writing has no fixed total-duration limit. A live request is
    # governed by the response-stall windows below, not by elapsed wall time.
    agent_model_response_stall_seconds: int = 600
    agent_worker_response_stall_seconds: int = 600
    agent_stage_script_stall_seconds: int = 600
    agent_cli_stall_retry_delay_seconds: int = 2
    agent_execution_lease_seconds: int = 90
    agent_job_recovery_poll_seconds: int = 15
    full_generate_parallel_workers: int = 2
    novel_analysis_parallel_workers: int = 3
    batch_task_max_parallel: int = 2
    batch_task_scheduler_poll_seconds: int = 10
    batch_task_auto_retry_limit: int = 3
    script_sync_max_parallel: int = 1
    script_sync_scheduler_poll_seconds: int = 10
    script_sync_execution_lease_seconds: int = 900
    script_distillation_max_parallel: int = 3
    script_distillation_scheduler_poll_seconds: int = 10
    # Used only by the API worker and the local Next server to export the
    # delivery-format Word attachments without relying on a browser session.
    internal_web_base_url: str = ""
    script_sync_internal_token: str = ""
    # Local npm development starts the API and Next server as a colocated pair.
    # Production keeps this disabled and supplies both values explicitly.
    script_sync_local_mode: bool = False
    # Remote OpenClaw calls authenticate the account on every HTTPS request.
    # This only caps the multipart source file; account credentials are never
    # included in a task payload or persisted by the API.
    openclaw_api_max_upload_bytes: int = 100 * 1024 * 1024
    preference_summary_scheduler_poll_seconds: int = 20
    credit_plan_grant_poll_seconds: int = 30
    internal_agent_tool_base_url: str = "http://127.0.0.1:8000"

    repo_root: Path = Path(__file__).resolve().parents[4]

    @property
    def data_dir(self) -> Path:
        return self.repo_root / "data"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "workbench.sqlite3"

    @property
    def agents_dir(self) -> Path:
        return self.repo_root / "Agents"

    @property
    def workspaces_dir(self) -> Path:
        return self.agents_dir / "workspaces"

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    def _use_local_script_sync_defaults(self) -> bool:
        return bool(
            self.script_sync_local_mode
            and not self.internal_web_base_url.strip()
            and not self.script_sync_internal_token.strip()
        )

    @property
    def script_sync_attachment_export_base_url(self) -> str:
        if self._use_local_script_sync_defaults():
            return LOCAL_SCRIPT_SYNC_WEB_BASE_URL
        return self.internal_web_base_url.strip().rstrip("/")

    @property
    def script_sync_attachment_export_token(self) -> str:
        if self._use_local_script_sync_defaults():
            return LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN
        return self.script_sync_internal_token.strip()


settings = Settings()
