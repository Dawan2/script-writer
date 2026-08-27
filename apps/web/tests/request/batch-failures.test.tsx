import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { BatchTasksPage } from "@/components/batch-tasks/batch-tasks-page";
import type { BatchTask, User } from "@/lib/types";

import { failure, installHttpFaults, json } from "../support/http-faults";

afterEach(cleanup);

const user: User = {
  id: 1,
  username: "hehua",
  display_name: "何华",
  role: "user"
} as User;

function task(id: number, projectName: string): BatchTask {
  return {
    id,
    batch_id: 1,
    batch_name: "春节档三部",
    creator_name: "何华",
    project_id: id * 10,
    project_name: projectName,
    project_deleted: false,
    scenario: { key: "rewrite", name: "剧本改写" },
    phase: { key: "world_view", name: "世界观", file_name: "world_view.md" },
    pause_at: { key: null, name: "完整执行", file_name: null },
    status: "running",
    result: "正在执行",
    duration_seconds: 30,
    started_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    created_at: "2026-01-01T00:00:00Z",
    retry_count: 0,
    max_retries: 2,
    run_count: 1,
    last_error: null
  };
}

const tasks = [task(1, "长夜将明"), task(2, "南风知我意"), task(3, "错位星轨")];

function installBatchRoutes() {
  const http = installHttpFaults();
  http.route("GET /api/batch-tasks/scenarios").always(
    json({ scenarios: [{ key: "rewrite", name: "剧本改写", stages: [] }], regions: [] })
  );
  http.route("GET /api/batch-tasks").always(json({ tasks, scenarios: [], max_parallel: 2 }));
  return http;
}

async function selectAllTasks() {
  const actor = userEvent.setup();
  render(<BatchTasksPage user={user} />);
  await actor.click(await screen.findByLabelText("全选任务"));
  await actor.click(screen.getByRole("button", { name: /批量操作/ }));
  return actor;
}

describe("AT-07 批量操作的失败按项呈现", () => {
  it("3 项里 2 项失败：每项一条说明，成功项按实际计数表述", async () => {
    const http = installBatchRoutes();
    http.route("POST /api/batch-tasks/bulk").always(
      json({
        updated: 1,
        failures: [
          { task_id: 2, message: "任务正在执行阶段校验，暂时不能暂停" },
          { task_id: 3, message: "任务已经结束，不需要暂停" }
        ]
      })
    );

    const actor = await selectAllTasks();
    await actor.click(screen.getByRole("menuitem", { name: /暂停所选任务/ }));

    const alerts = screen.getAllByRole("alert").map((node) => node.textContent ?? "");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain("南风知我意");
    expect(alerts[0]).toContain("任务正在执行阶段校验，暂时不能暂停");
    expect(alerts[1]).toContain("错位星轨");
    expect(alerts[1]).toContain("任务已经结束，不需要暂停");

    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toContain("成功 1 项");
    expect(notice).toContain("失败 2 项");
    expect(notice).not.toContain("已暂停 3 项");
  });

  it("删除时一项失败，其余项照样删掉", async () => {
    const http = installBatchRoutes();
    const first = http.route("DELETE /api/batch-tasks/1").always(json({ ok: true }));
    const second = http.route("DELETE /api/batch-tasks/2").always(
      failure(409, {
        error: {
          code: "STATE_CONFLICT",
          category: "conflict",
          retryable: false,
          message: "任务正在执行，先暂停再删除记录",
          hint: "先暂停这条任务。",
          traceId: "trace-409"
        }
      })
    );
    const third = http.route("DELETE /api/batch-tasks/3").always(json({ ok: true }));

    const actor = await selectAllTasks();
    await actor.click(screen.getByRole("menuitem", { name: /删除所选记录/ }));
    await actor.click(screen.getByRole("button", { name: "删除记录" }));

    expect(first.callCount()).toBe(1);
    expect(second.callCount()).toBe(1);
    expect(third.callCount()).toBe(1);

    const alerts = screen.getAllByRole("alert").map((node) => node.textContent ?? "");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("南风知我意");
    expect(alerts[0]).toContain("任务正在执行，先暂停再删除记录");

    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toContain("成功 2 项");
    expect(notice).toContain("失败 1 项");
  });
});
