import { describe, it, expect } from 'bun:test';
import { extractTunnelToken } from './tunnel-token.js';

const SAMPLE = 'eyJhIjoiOWQxN2Y0ZmItNGE3NC00ZDc0LWEwMjMtNGQxMjY1OWE3NTQ3IiwidCI6IjRiNzcwM2I0LTMxOTAtNGRkNS04OTUyLTVjNGRhYmY4N2RiYSIsInMiOiJleUppWVhOb1pYSnpJanBiSW5SbFpTQnpjM0lpY21WMGNua2lPbnNpY3VwTENKbGVIQWlPakVzSWpvaVpYVnpJanAwY25WbGZRPT0ifQ';

// A real Cloudflare token is hundreds of base64url chars; the test strings
// here are trimmed down but still > 40 chars after `ey` to satisfy the regex.
const SHORT_TOKEN = 'ey' + 'A'.repeat(60);

describe('extractTunnelToken', () => {
	it('returns a bare token unchanged', () => {
		expect(extractTunnelToken(SAMPLE)).toBe(SAMPLE);
		expect(extractTunnelToken(SHORT_TOKEN)).toBe(SHORT_TOKEN);
	});

	it('trims surrounding whitespace', () => {
		expect(extractTunnelToken(`  ${SAMPLE}  \n`)).toBe(SAMPLE);
	});

	it('extracts the token from a `cloudflared service install` command', () => {
		const cmd = `cloudflared service install ${SAMPLE}`;
		expect(extractTunnelToken(cmd)).toBe(SAMPLE);
	});

	it('extracts the token from a `cloudflared.exe service install` command', () => {
		const cmd = `C:\\Program Files\\cloudflared\\cloudflared.exe service install ${SAMPLE}`;
		expect(extractTunnelToken(cmd)).toBe(SAMPLE);
	});

	it('extracts the token from a `cloudflared tunnel run --token` command', () => {
		const cmd = `cloudflared tunnel run --token ${SAMPLE} my-tunnel`;
		expect(extractTunnelToken(cmd)).toBe(SAMPLE);
	});

	it('extracts the token from a `docker run … --token` command', () => {
		const cmd = `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${SAMPLE}`;
		expect(extractTunnelToken(cmd)).toBe(SAMPLE);
	});

	it('handles single-quoted and double-quoted tokens', () => {
		expect(extractTunnelToken(`--token '${SAMPLE}'`)).toBe(SAMPLE);
		expect(extractTunnelToken(`--token "${SAMPLE}"`)).toBe(SAMPLE);
	});

	it('returns the trimmed input when no token pattern is present', () => {
		// Too short to match the 40-char minimum — let the caller error out.
		expect(extractTunnelToken('eyShort')).toBe('eyShort');
		expect(extractTunnelToken('  hello world  ')).toBe('hello world');
		expect(extractTunnelToken('')).toBe('');
	});
});
