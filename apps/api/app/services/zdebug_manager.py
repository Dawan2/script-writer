from __future__ import annotations

import json
import os
import re
import sqlite3
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.core.config import settings
from app.services.workspace_service import project_stage_label


PORT_START = 4301
PORT_END = 4400
STARTUP_TIMEOUT_SECONDS = 30
RECENT_OUTPUT_LIMIT = 6000
CHAT_REQUEST_MAX_CHARS = 80


def extract_chat_user_request(prompt: str | None, *, max_chars: int = CHAT_REQUEST_MAX_CHARS) -> str:
    text = (prompt or "").strip()
    marker = re.search(r"(?:^|\n)用户请求：[ \t]*\n", text)
    if marker:
        text = text[marker.end():]
        stop = re.search(r"\n\s*(?:用户附件：|请从工作区读取目标文件)", text)
        if stop:
            text = text[:stop.start()]
    compact = re.sub(r"\s+", " ", text).strip() or "用户对话"
    if len(compact) <= max_chars:
        return compact
    if max_chars <= 3:
        return compact[:max_chars]
    return compact[: max_chars - 3].rstrip() + "..."


def _utc_iso(timestamp: object) -> str:
    raw = str(timestamp or "").strip()
    if not raw:
        return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def worker_display_name(label: str) -> str:
    if label == "full-authoring-session-compact":
        return "承接试稿创作状态"
    novel_read_match = re.fullmatch(r"novel-read-(\d{3})(?:-(?:retry-\d+|rebuild|patch-\d+))?", label)
    if novel_read_match:
        return f"小说内容整理（第 {int(novel_read_match.group(1))} 部分）"
    if re.fullmatch(r"novel-merge-\d+-\d{3}(?:-(?:rebuild|patch-\d+))?", label):
        return "小说剧情关联"
    if label.startswith("novel-analysis-synthesis"):
        return "小说解读汇总"
    if "-narrative-review-" in label:
        return "叙事质量审读"
    if "-dialogue-review-" in label:
        return "台词语义审读"
    if "-semantic-repair" in label:
        return "定向修订"
    range_match = re.fullmatch(r"(\d{3})-(\d{3})-(generate|repair)", label)
    if range_match:
        start, end, action = range_match.groups()
        action_label = "正文生成" if action == "generate" else "定向修订"
        return f"{action_label}（第 {int(start)}-{int(end)} 集）"
    return "执行子任务"


def _worker_log_finished(log_path: Path) -> bool:
    try:
        with log_path.open("rb") as handle:
            handle.seek(max(0, log_path.stat().st_size - 16_384))
            return '"type":"zdebug_end"' in handle.read().decode("utf-8", errors="replace")
    except OSError:
        return False


def _worker_log_entry(
    *,
    job_id: int,
    label: str,
    log_path: Path,
    worker_number: int,
    session_id: str = "",
    live: bool,
) -> dict:
    try:
        modified_at = datetime.fromtimestamp(log_path.stat().st_mtime, timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
    except OSError:
        modified_at = _utc_iso("")
    return {
        "id": f"worker:{label}",
        "jobId": job_id,
        "sessionId": session_id,
        "name": worker_display_name(label),
        "tag": f"子进程 {worker_number}",
        "workerNumber": worker_number,
        "path": str(log_path.resolve()),
        "modifiedAt": modified_at,
        "live": live,
        "current": False,
    }


def _job_worker_log_files(project: sqlite3.Row, row: sqlite3.Row) -> list[dict]:
    if "workspace_dir" not in project.keys():
        return []
    workspace = (settings.agents_dir / str(project["workspace_dir"])).resolve()
    if not workspace.is_relative_to(settings.workspaces_dir.resolve()):
        return []
    worker_dir = workspace / "runtime" / "jobs" / str(row["id"]) / "workers"
    if not worker_dir.is_dir():
        return []
    worker_logs: list[dict] = []
    for worker_number, log_path in enumerate(
        sorted(worker_dir.glob("*.jsonl"), key=lambda item: item.stat().st_mtime),
        start=1,
    ):
        worker_logs.append(
            _worker_log_entry(
                job_id=int(row["id"]),
                label=log_path.stem,
                log_path=log_path,
                worker_number=worker_number,
                live=row["status"] in {"queued", "running"} and not _worker_log_finished(log_path),
            )
        )
    return worker_logs


def project_job_log_files(
    conn: sqlite3.Connection,
    *,
    project: sqlite3.Row,
    current_job_id: int,
) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, project_id, stage, target_stage, prompt, status, claude_session_id,
               raw_log_path, created_at, started_at
        FROM agent_jobs
        WHERE project_id = ? AND raw_log_path IS NOT NULL AND TRIM(raw_log_path) != ''
        ORDER BY COALESCE(started_at, created_at) DESC, id DESC
        """,
        (project["id"],),
    ).fetchall()
    files: list[dict] = []
    for row in rows:
        target_stage = row["target_stage"] or row["stage"]
        file_label = project_stage_label(project, target_stage)
        action_label = (
            extract_chat_user_request(row["prompt"])
            if row["stage"] == "chat_edit"
            else target_stage
        )
        entry = {
            "id": f"job-{row['id']}",
            "jobId": row["id"],
            "sessionId": row["claude_session_id"],
            "name": f"{file_label} · {action_label}",
            "path": str(Path(row["raw_log_path"]).resolve()),
            "modifiedAt": _utc_iso(row["started_at"] or row["created_at"]),
            "live": row["status"] in {"queued", "running"},
            "current": row["id"] == current_job_id,
        }
        workers = _job_worker_log_files(project, row)
        if workers:
            entry["workers"] = workers
        files.append(entry)
    return files


@dataclass
class ZDebugProcess:
    process_key: str
    job_id: int
    project_id: int
    project_path: Path
    session_id: str
    selected_log_id: str
    runtime_log_path: Path
    log_manifest_path: Path
    port: int
    process: subprocess.Popen
    status: str = "starting"
    recent_stdout: str = ""
    recent_stderr: str = ""
    started_at: float = field(default_factory=time.time)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


class ZDebugManager:
    def __init__(self) -> None:
        self._processes: dict[str, ZDebugProcess] = {}
        self._ports_in_use: set[int] = set()
        self._lock = threading.Lock()

    def start_for_job(
        self,
        *,
        job_id: int,
        project_id: int,
        project_path: Path,
        session_id: str,
        log_files: list[dict],
    ) -> dict:
        return self._start_log_viewer(
            process_key=f"agent_job_{job_id}",
            job_id=job_id,
            project_id=project_id,
            project_path=project_path,
            session_id=session_id,
            runtime_log_path=self.runtime_log_path(job_id),
            scope={"type": "project", "projectId": project_id},
            log_files=log_files,
        )

    def start_for_evolution_run(
        self,
        *,
        run_id: int,
        project_path: Path,
        runtime_log_path: Path,
        modified_at: str,
        live: bool,
    ) -> dict:
        session_id = f"agent-evolution-{run_id}"
        return self._start_log_viewer(
            process_key=f"agent_evolution_{run_id}",
            job_id=run_id,
            project_id=0,
            project_path=project_path,
            session_id=session_id,
            runtime_log_path=runtime_log_path,
            scope={"type": "system_agent_evolution", "runId": run_id},
            log_files=[{
                "id": session_id,
                "jobId": run_id,
                "sessionId": session_id,
                "name": f"Agent 进化分析 #{run_id}",
                "path": str(runtime_log_path.resolve()),
                "modifiedAt": _utc_iso(modified_at),
                "live": live,
                "current": True,
            }],
        )

    def _start_log_viewer(
        self,
        *,
        process_key: str,
        job_id: int,
        project_id: int,
        project_path: Path,
        session_id: str,
        runtime_log_path: Path,
        scope: dict,
        log_files: list[dict],
    ) -> dict:
        selected_log_id = next(
            (str(item["id"]) for item in log_files if item.get("current")),
            str(log_files[0]["id"]) if log_files else "",
        )
        with self._lock:
            existing = self._processes.get(process_key)
            if existing and existing.process.poll() is None:
                self._write_log_manifest(
                    job_id=job_id,
                    project_id=project_id,
                    selected_log_id=selected_log_id,
                    log_files=log_files,
                    manifest_key=process_key,
                    scope=scope,
                )
                existing.status = "running"
                existing.selected_log_id = selected_log_id
                return self._public_info(existing, reused=True)
            if existing:
                self._forget_process(existing)
            log_manifest_path = self._write_log_manifest(
                job_id=job_id,
                project_id=project_id,
                selected_log_id=selected_log_id,
                log_files=log_files,
                manifest_key=process_key,
                scope=scope,
            )

        port = self._find_available_port()
        command = [
            self._resolve_node_command(),
            str(self._tool_entrypoint()),
            "--serve",
            "--port",
            str(port),
            "--project",
            str(project_path),
            "--log-manifest",
            str(log_manifest_path),
            "--selected-log-id",
            selected_log_id,
            "--session-id",
            session_id,
        ]

        try:
            process = subprocess.Popen(
                command,
                cwd=settings.repo_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            with self._lock:
                self._ports_in_use.discard(port)
                log_manifest_path.unlink(missing_ok=True)
            raise RuntimeError(f"启动 ZDebug 失败：{exc}") from exc

        info = ZDebugProcess(
            process_key=process_key,
            job_id=job_id,
            project_id=project_id,
            project_path=project_path,
            session_id=session_id,
            selected_log_id=selected_log_id,
            runtime_log_path=runtime_log_path,
            log_manifest_path=log_manifest_path,
            port=port,
            process=process,
        )
        with self._lock:
            self._processes[process_key] = info

        self._start_output_reader(info, "stdout")
        self._start_output_reader(info, "stderr")
        self._start_exit_watcher(info)
        self._wait_until_ready(info)
        return self._public_info(info, reused=False)

    def cleanup(self) -> None:
        with self._lock:
            processes = list(self._processes.values())
        for info in processes:
            self._terminate(info)

    def stop_for_job(self, job_id: int) -> None:
        process_key = f"agent_job_{job_id}"
        with self._lock:
            info = self._processes.get(process_key)
        if info:
            self._terminate(info)

    def register_worker_log(
        self,
        *,
        job_id: int,
        label: str,
        runtime_log_path: Path,
        session_id: str,
        worker_number: int,
        live: bool,
    ) -> None:
        """Add or update a worker log in an already-open parent viewer."""
        process_key = f"agent_job_{job_id}"
        with self._lock:
            info = self._processes.get(process_key)
            if not info or info.process.poll() is not None:
                return
            try:
                manifest = json.loads(info.log_manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return
            files = manifest.get("files") if isinstance(manifest.get("files"), list) else []
            parent_id = f"job-{job_id}"
            parent = next(
                (item for item in files if isinstance(item, dict) and item.get("id") == parent_id),
                None,
            )
            if parent is None:
                return
            entry = _worker_log_entry(
                job_id=job_id,
                label=label,
                log_path=runtime_log_path,
                worker_number=worker_number,
                session_id=session_id,
                live=live,
            )
            workers = parent.get("workers") if isinstance(parent.get("workers"), list) else []
            parent["workers"] = [
                item for item in workers if not isinstance(item, dict) or item.get("id") != entry["id"]
            ] + [entry]
            try:
                self._write_log_manifest(
                    job_id=job_id,
                    project_id=info.project_id,
                    selected_log_id=str(manifest.get("selectedLogId") or info.selected_log_id),
                    log_files=files,
                    manifest_key=info.process_key,
                    scope=manifest.get("scope") if isinstance(manifest.get("scope"), dict) else None,
                )
            except OSError:
                return

    def runtime_log_path(self, job_id: int) -> Path:
        log_dir = settings.data_dir / "zdebug" / "jobs"
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir / f"agent_job_{job_id}.jsonl"

    def log_manifest_path(self, job_id: int) -> Path:
        return self._log_manifest_path(f"agent_job_{job_id}")

    def _log_manifest_path(self, manifest_key: str) -> Path:
        manifest_dir = settings.data_dir / "zdebug" / "manifests"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        safe_key = re.sub(r"[^a-zA-Z0-9_-]", "_", manifest_key)
        return manifest_dir / f"{safe_key}.json"

    def _write_log_manifest(
        self,
        *,
        job_id: int,
        project_id: int,
        selected_log_id: str,
        log_files: list[dict],
        manifest_key: str | None = None,
        scope: dict | None = None,
    ) -> Path:
        manifest_path = (
            self._log_manifest_path(manifest_key) if manifest_key else self.log_manifest_path(job_id)
        )
        temporary_path = manifest_path.with_suffix(".json.tmp")
        temporary_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "scope": scope or {"type": "project", "projectId": project_id},
                    "selectedLogId": selected_log_id,
                    "files": log_files,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(manifest_path)
        return manifest_path

    def _resolve_node_command(self) -> str:
        env_command = os.getenv("ORCA_NODE_PATH", "").strip()
        if env_command:
            return env_command
        return "node"

    def _tool_entrypoint(self) -> Path:
        entrypoint = settings.repo_root / "tools" / "zdebug" / "bin" / "zdebug.mjs"
        if not entrypoint.exists():
            raise RuntimeError(f"未找到内置调试工具：{entrypoint}")
        return entrypoint

    def _find_available_port(self) -> int:
        with self._lock:
            reserved = set(self._ports_in_use)
        for port in range(PORT_START, PORT_END + 1):
            if port in reserved:
                continue
            if self._can_bind(port):
                with self._lock:
                    if port not in self._ports_in_use:
                        self._ports_in_use.add(port)
                        return port
        raise RuntimeError(f"没有可用的 ZDebug 端口（{PORT_START}-{PORT_END}）。")

    def _can_bind(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                server.bind(("127.0.0.1", port))
            except OSError:
                return False
        return True

    def _wait_until_ready(self, info: ZDebugProcess) -> None:
        deadline = time.time() + STARTUP_TIMEOUT_SECONDS
        while time.time() < deadline:
            if info.process.poll() is not None:
                info.status = "error"
                raise RuntimeError(self._error_message(info, "ZDebug 进程已退出"))
            if self._can_connect(info.port):
                info.status = "running"
                return
            time.sleep(0.3)

        info.status = "error"
        self._terminate(info)
        raise RuntimeError(self._error_message(info, "ZDebug 启动超时"))

    def _can_connect(self, port: int) -> bool:
        for host in ("127.0.0.1", "::1"):
            try:
                with socket.create_connection((host, port), timeout=0.4):
                    return True
            except OSError:
                continue
        return False

    def _start_output_reader(self, info: ZDebugProcess, stream_name: str) -> None:
        stream = getattr(info.process, stream_name)
        if stream is None:
            return

        def read_stream() -> None:
            for chunk in iter(stream.readline, ""):
                if not chunk:
                    break
                self._append_recent_output(info, stream_name, chunk)

        thread = threading.Thread(target=read_stream, daemon=True)
        thread.start()

    def _start_exit_watcher(self, info: ZDebugProcess) -> None:
        def watch() -> None:
            info.process.wait()
            with self._lock:
                current = self._processes.get(info.process_key)
                if current is info:
                    info.status = "stopped" if info.status != "error" else "error"
                    self._forget_process(info)

        threading.Thread(target=watch, daemon=True).start()

    def _append_recent_output(self, info: ZDebugProcess, stream_name: str, chunk: str) -> None:
        attr = f"recent_{stream_name}"
        current = getattr(info, attr)
        combined = f"{current}{chunk}"
        if len(combined) > RECENT_OUTPUT_LIMIT:
            combined = combined[-RECENT_OUTPUT_LIMIT:]
        setattr(info, attr, combined)

    def _terminate(self, info: ZDebugProcess) -> None:
        if info.process.poll() is None:
            try:
                info.process.terminate()
                info.process.wait(timeout=3)
            except Exception:
                try:
                    info.process.kill()
                except Exception:
                    pass
        with self._lock:
            self._forget_process(info)

    def _forget_process(self, info: ZDebugProcess) -> None:
        self._processes.pop(info.process_key, None)
        self._ports_in_use.discard(info.port)
        info.log_manifest_path.unlink(missing_ok=True)

    def _error_message(self, info: ZDebugProcess, message: str) -> str:
        details = []
        stdout = info.recent_stdout.strip()
        stderr = info.recent_stderr.strip()
        if stdout:
            details.append("stdout: " + " | ".join(stdout.splitlines()[-6:]))
        if stderr:
            details.append("stderr: " + " | ".join(stderr.splitlines()[-6:]))
        return f"{message}；{'；'.join(details)}" if details else message

    def _public_info(self, info: ZDebugProcess, *, reused: bool) -> dict:
        return {
            "job_id": info.job_id,
            "project_id": info.project_id,
            "process_key": info.process_key,
            "status": info.status,
            "url": info.url,
            "port": info.port,
            "project_path": str(info.project_path),
            "session_id": info.session_id,
            "selected_log_id": info.selected_log_id,
            "runtime_log_path": str(info.runtime_log_path),
            "reused": reused,
        }


zdebug_manager = ZDebugManager()
