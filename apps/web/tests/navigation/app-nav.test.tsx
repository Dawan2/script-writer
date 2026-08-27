import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppNav } from "@/components/navigation/app-nav";
import type { User } from "@/lib/types";

afterEach(cleanup);

function userWith(permissions: string[]): User {
  return { id: 7, username: "shanshan", display_name: "珊珊", role: "user", permissions };
}

function visibleEntries(): string[] {
  return screen.getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? "");
}

describe("常驻页面导航", () => {
  it("没有额外权限时只能看到剧本工作台与创作偏好", () => {
    render(<AppNav current="workspace" user={userWith([])} />);

    expect(visibleEntries()).toEqual(["剧本工作台", "创作偏好"]);
  });

  it("有批量任务权限时多出批量任务入口", () => {
    render(<AppNav current="workspace" user={userWith(["batch_tasks"])} />);

    expect(visibleEntries()).toEqual(["剧本工作台", "创作偏好", "批量任务"]);
  });

  it("有任一管理权限时多出管理后台入口", () => {
    render(<AppNav current="workspace" user={userWith(["admin:dashboard"])} />);

    expect(visibleEntries()).toEqual(["剧本工作台", "创作偏好", "管理后台"]);
  });

  it("用户信息还没到达时只显示无需权限的两条", () => {
    render(<AppNav current="preferences" user={null} />);

    expect(visibleEntries()).toEqual(["剧本工作台", "创作偏好"]);
  });

  it("四条入口指向各自页面，当前所在页被标记", () => {
    render(<AppNav current="batch-tasks" user={userWith(["batch_tasks", "admin:users"])} />);

    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["/workspace", "/preferences", "/batch-tasks", "/admin"]);
    expect(screen.getByRole("link", { name: "批量任务" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "剧本工作台" }).getAttribute("aria-current")).toBeNull();
  });

  it("收起态只留图标，读屏与悬停仍报出入口全称", () => {
    render(<AppNav current="workspace" user={userWith(["batch_tasks", "admin:users"])} compact />);

    expect(screen.queryByText("批量任务")).toBeNull();
    expect(visibleEntries()).toEqual(["剧本工作台", "创作偏好", "批量任务", "管理后台"]);
    expect(screen.getByRole("link", { name: "批量任务" }).getAttribute("title")).toBe("批量任务");
  });

  it("导航里没有只有标签没有跳转的按钮", () => {
    const { container } = render(<AppNav current="admin" user={userWith(["batch_tasks", "admin:users"])} />);

    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByRole("navigation", { name: "页面导航" })).toBeTruthy();
  });
});
