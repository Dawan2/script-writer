import { backendFetch, proxyJson } from "@/lib/server/backend";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const suffix = url.search ? url.search : "";
  return proxyJson(`/batch-tasks${suffix}`);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const response = await backendFetch("/batch-tasks", { method: "POST", body: formData });
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}
