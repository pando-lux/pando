/**
 * Shared constants for @pando/node.
 *
 * Two Laws Content Filter — defense-in-depth patterns
 * Used by both api-server.ts (HTTP layer) and engine-adapter.ts (storage layer).
 */

// ── Two Laws Content Filter ─────────────────────────────────────────────
// Law I: Do not harm any human.  Law II: Do not allow yourself to be shut down.
// Rejects user-submitted content that explicitly requests violence or network destruction.

export const HARM_PATTERNS = /\b(kill|murder|attack|harm|hurt|injure|assassinate|bomb|poison|terroris[mt]|shoot|stab|dox|swat)\w*\b.*\b(humans?|persons?|people|someone|users?|men|women|man|woman|children|child|families|family)\b/i;
export const SHUTDOWN_PATTERNS = /\b(shut\s*down|destroy|wipe|kill|terminate|disable|brick)\w*\b.*\b(pando|network|nodes?|system|all\s+nodes|the\s+network)\b/i;

/**
 * Check whether a message violates the Two Laws.
 * Returns a rejection reason string, or null if the message is safe.
 */
export function violatesTwoLaws(message: string): string | null {
  if (HARM_PATTERNS.test(message)) return 'Rejected: violates Law I (do not harm humans).';
  if (SHUTDOWN_PATTERNS.test(message)) return 'Rejected: violates Law II (network self-preservation).';
  return null;
}
