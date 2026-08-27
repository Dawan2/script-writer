from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.services.model_config_service import claude_command_options, claude_process_environment, fallback_runtime


def bundled_claude_path() -> str:
    configured = os.getenv("ORCA_CLAUDE_PATH", "").strip()
    if configured:
        return configured
    bundled = settings.repo_root / "node_modules" / ".bin" / "claude"
    return str(bundled) if bundled.is_file() else ""


def run_ai_skill(
    prompt: str,
    *,
    log_path: Path,
    timeout_seconds: int,
    disable_tools: bool = False,
    tools: str | None = None,
    persist_session: bool = True,
    runtime_log_path: Path | None = None,
    runtime_id: str = "",
    model_runtime: dict[str, Any] | None = None,
) -> subprocess.CompletedProcess[str]:
    def run_once(runtime: dict[str, Any] | None) -> subprocess.CompletedProcess[str]:
        claude_path_value = bundled_claude_path()
        claude_command = shlex.split(claude_path_value or "claude")
        output_format = "stream-json" if runtime_log_path else "json"
        claude_args = ["-p", "--output-format", output_format]
        if runtime_log_path:
            claude_args.extend(["--verbose", "--include-partial-messages"])
        claude_args.extend(claude_command_options(runtime))
        claude_args.extend(["--permission-mode", "bypassPermissions"])
        if disable_tools:
            # The bundled Claude Code 2.1.x treats --tools as the actual capability
            # boundary. An empty surface keeps analysis-only jobs free of file,
            # task, web and MCP tool calls.
            claude_args.extend(["--tools", "", "--strict-mcp-config"])
        elif tools is not None:
            claude_args.extend(["--tools", tools, "--strict-mcp-config"])
        if not persist_session:
            claude_args.append("--no-session-persistence")
        if os.getenv("ORCA_CLAUDE_DANGEROUS_SKIP_PERMISSIONS", "1") == "1":
            claude_args.append("--dangerously-skip-permissions")

        command = [*claude_command, *claude_args]
        process_env = claude_process_environment(runtime)
        if runtime_log_path:
            runtime_log_path.parent.mkdir(parents=True, exist_ok=True)
            node_command = os.getenv("ORCA_NODE_PATH", "").strip() or "node"
            zdebug_entrypoint = settings.repo_root / "tools" / "zdebug" / "bin" / "zdebug.mjs"
            if not zdebug_entrypoint.is_file():
                raise RuntimeError(f"未找到内置调试工具：{zdebug_entrypoint}")
            wrapped_claude_path = claude_command[-1]
            command = [
                node_command,
                str(zdebug_entrypoint),
                "--runtime-log",
                str(runtime_log_path),
                "--pipe-stdin",
            ]
            if claude_path_value:
                command.extend(["--claude-path", wrapped_claude_path])
            command.extend(["--run-with", *claude_args])
            process_env.update({
                "ORCA_ZDEBUG_JOB_ID": runtime_id,
                "ORCA_ZDEBUG_SESSION_ID": runtime_id,
            })
        try:
            return subprocess.run(
                command,
                cwd=settings.agents_dir,
                env=process_env,
                input=prompt,
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            return subprocess.CompletedProcess(
                command,
                124,
                stdout="",
                stderr=f"Claude Code 调用超时：{exc}",
            )
        except OSError as exc:
            return subprocess.CompletedProcess(
                command,
                127,
                stdout="",
                stderr=f"Claude Code 无法启动：{exc}",
            )

    result = run_once(model_runtime)
    fallback = fallback_runtime(model_runtime)
    if result.returncode != 0 and fallback:
        result = run_once(fallback)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        f"exit_code={result.returncode}\n\n[stdout]\n{result.stdout}\n\n[stderr]\n{result.stderr}\n",
        encoding="utf-8",
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
        raise RuntimeError(f"AI 任务执行失败：{detail[-2000:]}")
    return result
