import { proxyJson } from "@/lib/server/backend";


export async function GET() {
  const response = await proxyJson("/me/writer-preferences");
  response.headers.set("cache-control", "no-store");
  return response;
}


export async function POST(request: Request) {
  return proxyJson("/me/writer-preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
