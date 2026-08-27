import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjects } from "@/lib/api-client";
import { useRequestScope } from "@/lib/use-request-scope";

import { installHttpFaults, timeout } from "../support/http-faults";

afterEach(cleanup);

function ProjectCount({ onLoaded }: { onLoaded: (count: number) => void }) {
  const scope = useRequestScope();
  useEffect(() => {
    void scope.run(
      (signal) => getProjects(undefined, { signal }),
      (projects) => onLoaded(projects.length)
    );
  }, [scope, onLoaded]);
  return <p role="status">正在读取项目</p>;
}

describe("AT-03 组件卸载即取消，且不回写状态", () => {
  it("响应返回前卸载：请求被取消，回写函数一次都没被调用", async () => {
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(timeout());
    const onLoaded = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const view = render(<ProjectCount onLoaded={onLoaded} />);
    await Promise.resolve();
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(route.calls()[0].aborted).toBe(true);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });
});
