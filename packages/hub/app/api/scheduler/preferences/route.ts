import { NextResponse } from "next/server";

// PreferenceObserver removed (Phase 22.6 dead code cleanup).
// Return empty data for backward compatibility with any clients.
export async function GET() {
  return NextResponse.json({ preferences: null, preferenceStrings: [] });
}
