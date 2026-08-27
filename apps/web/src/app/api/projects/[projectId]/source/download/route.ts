import { backendFetch } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export const runtime = "nodejs";

export async function GET(_request: Request, context: Params) {
  const { projectId } = await context.params;
  const response = await backendFetch(`/projects/${projectId}/source/download`);
  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "content-length"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
