import { NextResponse } from "next/server";
import { getDistinctProviders, getDistinctModels, getDistinctStatuses } from "@/lib/requestDetailsDb";

/**
 * GET /api/usage/request-details/filters
 * Returns available filter options for the request logs UI
 */
export async function GET() {
  try {
    const [providers, models, statuses] = await Promise.all([
      getDistinctProviders(),
      getDistinctModels(),
      getDistinctStatuses(),
    ]);
    return NextResponse.json({ providers, models, statuses });
  } catch (error) {
    console.error("[API] Failed to get filter options:", error);
    return NextResponse.json({ error: "Failed to fetch filter options" }, { status: 500 });
  }
}
