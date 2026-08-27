import { redirect } from "next/navigation";
import { BatchTasksPage } from "@/components/batch-tasks/batch-tasks-page";
import { backendFetch } from "@/lib/server/backend";
import type { User } from "@/lib/types";

export default async function BatchTasksRoute() {
  const response = await backendFetch("/auth/me");
  if (response.status === 401) redirect("/?login=1");
  if (!response.ok) redirect("/workspace");
  const payload = await response.json() as { user: User };
  if (!payload.user.permissions.includes("batch_tasks")) redirect("/workspace");
  return <BatchTasksPage user={payload.user} />;
}
