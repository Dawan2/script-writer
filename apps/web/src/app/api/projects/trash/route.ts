import { proxyJson } from "@/lib/server/backend";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const page = url.searchParams.get("page");
  const pageSize = url.searchParams.get("page_size");
  if (page) params.set("page", page);
  if (pageSize) params.set("page_size", pageSize);
  const query = params.toString();
  return proxyJson(`/projects/trash${query ? `?${query}` : ""}`);
}
