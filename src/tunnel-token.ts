/**
 * Tunnel-token parsing helpers.
 *
 * Pulled into a dedicated module so the pure regex/extractor logic can be
 * unit-tested without importing the whole CLI (which calls `main()` on load).
 */

// Matches a Cloudflare tunnel token: a long base64url string starting with
// `ey` (the base64 encoding of `{` — every tunnel token is a base64-encoded
// JSON blob). 40 chars after `ey` keeps us well clear of accidental short
// matches in pasted shell commands (e.g. an `ey` inside a JSON flag) while
// still capturing every real token, which is typically >100 chars. The
// character class stops at whitespace, dots, quotes, and other non-base64url
// so a JWT (e.g. `ey…payload.ey…signature.sig…`) cleanly extracts the first
// segment (which is how cloudflared's `service install <token>` and
// `--token <token>` forms both pass the token through).
const TUNNEL_TOKEN_RE = /ey[A-Za-z0-9_-]{40,}/;

/**
 * Pull a tunnel JWT out of free-form input. Users routinely paste the whole
 * `cloudflared service install eyJh…` or `… --token eyJh…` line from the
 * dashboard; this extracts just the token. Falls back to the trimmed input
 * when nothing matches, so a hand-typed token still works.
 */
export function extractTunnelToken(input: string): string {
	const trimmed = input.trim();
	const match = trimmed.match(TUNNEL_TOKEN_RE);
	return match ? match[0] : trimmed;
}
