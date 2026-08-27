import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/server/backend";

export async function GET() {
  const response = await backendFetch("/auth/me");
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  });
}
