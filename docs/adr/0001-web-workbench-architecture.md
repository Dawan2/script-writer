# ADR 0001: Web Workbench Architecture

## Status

Accepted

## Context

The existing project is a Claude Code based script overseas adaptation Agent. It already has a working Agent structure:

- `CLAUDE.md`
- `.claude/skills`
- `package.json` with Agent skill scripts
- `workspaces/` with project inputs, progress JSON, and Markdown outputs

The new product, “虎鲸｜剧本出海工作站”, needs to wrap this Agent in a browser-based workstation for internal users and future commercialization. The site requires a Next.js frontend, a FastAPI backend, and SQLite metadata storage.

The Agent must remain independently usable. Opening only the Agent directory should still allow manual Claude Code usage and direct npm script execution.

## Decision

Use a “site shell + independent Agent subproject” repository layout:

```text
.
├── apps/
│   ├── web/                  # Next.js frontend
│   └── api/                  # FastAPI backend
├── Agents/                   # Standalone Claude Code Agent project
│   ├── CLAUDE.md
│   ├── package.json
│   ├── package-lock.json
│   ├── .claude/
│   │   └── skills/
│   └── workspaces/
├── docs/
├── tmp/
├── package.json              # Site-level scripts
└── README.md
```

## Boundaries

### `Agents/`

`Agents/` is the execution home of the existing Claude Code Agent. It must remain a complete, independently openable Agent project.

The site must not merge Agent scripts into the root `package.json`. The backend can call Agent commands only through a controlled service layer with `cwd=Agents`.

### `apps/api`

FastAPI owns:

- Authentication and authorization.
- SQLite access.
- Project metadata.
- Mapping `project_id` to an allowed workspace path.
- Reading and writing Markdown files under `Agents/workspaces`.
- Launching Claude Code or Agent npm scripts through a runner.
- Capturing Agent logs and job state.

FastAPI must never trust a browser-provided absolute path.

### `apps/web`

Next.js owns:

- Login and session-facing UI.
- The liquid-glass dark workstation shell.
- Project list interactions.
- Markdown preview/edit/source modes.
- Agent chat and streaming log display.

The browser talks to the site API/BFF, not directly to arbitrary workspace files.

### SQLite

SQLite stores metadata and audit data, not long script bodies.

Recommended early tables:

- `users`
- `projects`
- `agent_jobs`
- `agent_events`
- `file_versions`

The `projects.workspace_dir` value points to an allowed project directory under `Agents/workspaces`. It may be stored as a normalized relative path or as a backend-resolved absolute path.

### Markdown And Progress Files

Long-form content remains in Markdown files under `Agents/workspaces`.

`01-project-progress.json` remains the source of truth for stage progress. The backend reads it to render the right-side file rail and updates project metadata after Agent jobs finish.

## Claude Session Binding

Each `projects` row has a `claude_session_id`.

The first Agent job for a project should start Claude Code with that project session ID. Later jobs resume the same session so logs and reasoning history can be traced back to the project.

The backend also records each run in `agent_jobs` and `agent_events` so the UI can display historical execution logs even after a page refresh.

## MVP Non-Goals

The MVP does not include:

- Online payment.
- Team or organization management.
- Fine-grained role matrices beyond `admin` and `user`.
- PostgreSQL migration.
- Rewriting existing Agent skills.
- External multi-tenant billing or quota systems.

## Consequences

This layout adds a clear boundary between product infrastructure and Agent execution. It avoids turning the web app into a fragile wrapper around root-level Agent files, while preserving the ability to run the Agent manually from `Agents/`.

The backend runner must be careful about path resolution, subprocess arguments, job timeouts, and concurrent execution. Those are backend responsibilities, not frontend responsibilities.

## Next Implementation Order

1. Finish the repository migration and verify `cd Agents && npm run check`.
2. Scaffold `apps/web` and `apps/api`.
3. Build the static dark liquid-glass workstation UI.
4. Add authentication and SQLite.
5. Index projects from `Agents/workspaces`.
6. Add Markdown file read/write.
7. Add Agent job execution and streaming logs.
