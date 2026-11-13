import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing ID parameter" }, { status: 400 });
    }

    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json({ error: "Request detail not found" }, { status: 404 });
    }

    // Return the full detail object, including payloads
    // The database layer handles redaction of sensitive credentials (API keys, tokens)
    return NextResponse.json(detail);
  } catch (error) {
    console.error(`[API] Failed to get request detail by id:`, error);
    return NextResponse.json(
      { error: "Failed to fetch request detail" },
      { status: 500 }
    );
  }
}
