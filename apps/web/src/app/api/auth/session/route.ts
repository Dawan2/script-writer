import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/server/backend";

export async function GET() {
  const response = await backendFetch("/auth/me");
  if (response.status === 401) {
    return NextResponse.json({ user: null });
  }

  const payload = await response.json().catch(() => ({}));
  return NextResponse.json(payload, { status: response.status });
}
