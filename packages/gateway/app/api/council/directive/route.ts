import { NextResponse } from 'next/server';

/**
 * GET /api/council/directive (legacy route)
 * Directives are not yet implemented in the teams API.
 * Returns an empty array so the dashboard page degrades gracefully.
 */
export async function GET() {
  return NextResponse.json({ directives: [] });
}
