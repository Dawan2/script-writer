import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { installHttpFaults, json } from "../support/http-faults";

afterEach(cleanup);

// 基座自检：组件渲染、用户操作模拟、故障注入能串在一起，
// 界面交互类的验收（点了按钮之后界面变成什么样）因此可以自动执行。
function SaveButton() {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const save = async () => {
    setState("saving");
    try {
      const response = await fetch("/api/projects/1/files/world_view", { method: "PUT", body: "{}" });
      setState(response.ok ? "saved" : "failed");
    } catch {
      setState("failed");
    }
  };
  return (
    <div>
      <button type="button" onClick={() => void save()}>
        保存
      </button>
      <p role="status">{{ idle: "未保存", saving: "正在保存", saved: "已保存", failed: "保存失败" }[state]}</p>
    </div>
  );
}

describe("组件渲染与用户操作", () => {
  it("点击保存后界面显示保存结果", async () => {
    const http = installHttpFaults();
    http.route("PUT /api/projects/*/files/**").always(json({ file: {} }));

    render(<SaveButton />);
    expect(screen.getByRole("status").textContent).toBe("未保存");

    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("status").textContent).toBe("已保存");
    expect(http.calls()).toHaveLength(1);
  });

  it("请求失败时界面显示失败而不是停在正在保存", async () => {
    const http = installHttpFaults();
    http.route("PUT /api/projects/*/files/**").always(json({ detail: "文档已被他人修改" }, { status: 409 }));

    render(<SaveButton />);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("status").textContent).toBe("保存失败");
    expect(http.calls()[0].method).toBe("PUT");
  });
});
