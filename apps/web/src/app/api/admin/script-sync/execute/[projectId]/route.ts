import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, context: Params) {
  const { projectId } = await context.params;
  const response = await backendFetch("/admin/script-sync/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_ids: [projectId] })
  });
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}
