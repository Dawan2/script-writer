import { proxyJson, backendFetch } from "@/lib/server/backend";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query");
  return proxyJson(`/projects${query ? `?query=${encodeURIComponent(query)}` : ""}`);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const response = await backendFetch("/projects", {
    method: "POST",
    body: formData
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}
