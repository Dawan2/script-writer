import { expect, test } from "@playwright/test";

// 端到端最小骨架：证明浏览器、本地服务、路由与选择器这条链路是通的。
// 各工作项在此基础上补自己的过程类用例，不要把断言堆进这个文件。
test.describe("落地页", () => {
  test("首屏可见，标题与主行动按钮都在", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1, name: "出海剧作家" })).toBeVisible();
    await expect(page.getByRole("button", { name: "让剧本出海" }).first()).toBeVisible();
  });

  test("未登录时点主行动按钮会弹出登录窗口", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "让剧本出海" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("登录｜出海剧作家")).toBeVisible();
    await expect(dialog.getByLabel("用户名")).toBeVisible();
    await expect(dialog.getByLabel("密码")).toBeVisible();
  });
});
