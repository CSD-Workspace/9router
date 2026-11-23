import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { model, kind } = body;
    const customHeaders = body.headers || body.customHeaders || null;
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const origin = new URL(request.url).origin;
    const result = await pingModelByKind(model, kind || "llm", origin, customHeaders);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
