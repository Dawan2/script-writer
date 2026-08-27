import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import { API_BASE } from "@/lib/server/backend";

export async function POST(request: Request) {
  const body = await request.text();
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-audit-source": "web" },
    body,
    cache: "no-store"
  });
  const payload = await response.json();
  if (!response.ok) {
    return NextResponse.json(payload, { status: response.status });
  }
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, payload.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
  return NextResponse.json({ user: payload.user });
}
