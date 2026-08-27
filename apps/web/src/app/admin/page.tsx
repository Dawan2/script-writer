import { redirect } from "next/navigation";
import { AdminConsole } from "@/components/admin/admin-console";
import { backendFetch } from "@/lib/server/backend";
import type { User } from "@/lib/types";

export default async function AdminPage() {
  const response = await backendFetch("/auth/me");
  if (response.status === 401) redirect("/?login=1");
  if (!response.ok) redirect("/workspace");
  const payload = await response.json() as { user: User };
  if (!payload.user.permissions.some((permission) => permission.startsWith("admin:"))) redirect("/workspace");
  return <AdminConsole user={payload.user} />;
}
