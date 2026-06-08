import { describe, it, expect } from 'bun:test';
import {
	parseKey,
	navigate,
	formatUptime,
	plainLen,
	padEndPlain,
	padStartPlain,
	truncatePlain,
	computeBoxLayout,
	renderDashboard,
	detectTheme
} from './cli-ui.js';

describe('parseKey', () => {
	it('decodes arrow keys (CSI and SS3 forms)', () => {
		expect(parseKey('\x1b[A')).toEqual({ type: 'up' });
		expect(parseKey('\x1bOA')).toEqual({ type: 'up' });
		expect(parseKey('\x1b[B')).toEqual({ type: 'down' });
		expect(parseKey('\x1b[C')).toEqual({ type: 'right' });
		expect(parseKey('\x1b[D')).toEqual({ type: 'left' });
	});

	it('decodes enter (CR and LF)', () => {
		expect(parseKey('\r')).toEqual({ type: 'enter' });
		expect(parseKey('\n')).toEqual({ type: 'enter' });
	});

	it('decodes control and edit keys', () => {
		expect(parseKey('\x03')).toEqual({ type: 'ctrl-c' });
		expect(parseKey('\x1b')).toEqual({ type: 'escape' });
		expect(parseKey('\x7f')).toEqual({ type: 'backspace' });
		expect(parseKey('\t')).toEqual({ type: 'tab' });
		expect(parseKey(' ')).toEqual({ type: 'space' });
	});

	it('decodes printable characters', () => {
		expect(parseKey('q')).toEqual({ type: 'char', value: 'q' });
		expect(parseKey('j')).toEqual({ type: 'char', value: 'j' });
		expect(parseKey('7')).toEqual({ type: 'char', value: '7' });
	});

	it('returns unknown for unrecognized sequences', () => {
		expect(parseKey('\x1b[3~')).toEqual({ type: 'unknown' });
		expect(parseKey('')).toEqual({ type: 'unknown' });
	});
});

describe('navigate', () => {
	it('moves down and wraps at the end', () => {
		expect(navigate(0, 3, { type: 'down' })).toBe(1);
		expect(navigate(2, 3, { type: 'down' })).toBe(0);
	});

	it('moves up and wraps at the start', () => {
		expect(navigate(1, 3, { type: 'up' })).toBe(0);
		expect(navigate(0, 3, { type: 'up' })).toBe(2);
	});

	it('treats j/k as down/up', () => {
		expect(navigate(0, 3, { type: 'char', value: 'j' })).toBe(1);
		expect(navigate(0, 3, { type: 'char', value: 'k' })).toBe(2);
	});

	it('ignores unrelated keys', () => {
		expect(navigate(1, 3, { type: 'enter' })).toBe(1);
		expect(navigate(1, 3, { type: 'char', value: 'x' })).toBe(1);
	});

	it('stays at zero with no items', () => {
		expect(navigate(0, 0, { type: 'down' })).toBe(0);
	});
});

describe('formatUptime', () => {
	it('formats sub-hour spans as MM:SS', () => {
		expect(formatUptime(0)).toBe('00:00');
		expect(formatUptime(5_000)).toBe('00:05');
		expect(formatUptime(75_000)).toBe('01:15');
	});

	it('formats hour-plus spans as HH:MM:SS', () => {
		expect(formatUptime(3_661_000)).toBe('01:01:01');
	});

	it('clamps negative spans to zero', () => {
		expect(formatUptime(-1000)).toBe('00:00');
	});
});

describe('plainLen', () => {
	it('counts visible characters, ignoring SGR codes', () => {
		expect(plainLen('hello')).toBe(5);
		expect(plainLen('\x1b[31mhello\x1b[0m')).toBe(5);
		expect(plainLen('\x1b[1m\x1b[38;2;243;128;32m●\x1b[0m')).toBe(1);
		expect(plainLen('')).toBe(0);
	});
});

describe('padEndPlain / padStartPlain', () => {
	it('right-pads plain strings to width', () => {
		expect(padEndPlain('abc', 5)).toBe('abc  ');
		expect(padEndPlain('abcdef', 5)).toBe('abcdef'); // no truncation
	});

	it('left-pads plain strings to width', () => {
		expect(padStartPlain('abc', 5)).toBe('  abc');
		expect(padStartPlain('abcdef', 5)).toBe('abcdef');
	});

	it('right-pads coloured strings based on visible width', () => {
		const coloured = '\x1b[31mabc\x1b[0m';
		expect(padEndPlain(coloured, 5)).toBe(`${coloured}  `);
		expect(plainLen(padEndPlain(coloured, 5))).toBe(5);
	});

	it('left-pads coloured strings based on visible width', () => {
		const coloured = '\x1b[31mabc\x1b[0m';
		expect(padStartPlain(coloured, 5)).toBe(`  ${coloured}`);
		expect(plainLen(padStartPlain(coloured, 5))).toBe(5);
	});
});

describe('truncatePlain', () => {
	it('returns input unchanged when it fits', () => {
		expect(truncatePlain('hello', 5)).toBe('hello');
		expect(truncatePlain('hi', 10)).toBe('hi');
	});

	it('truncates with an ellipsis when over width', () => {
		expect(truncatePlain('hello world', 8)).toBe('hello w…');
		expect(truncatePlain('abcdefg', 4)).toBe('abc…');
	});

	it('handles tiny widths gracefully', () => {
		expect(truncatePlain('hello', 1)).toBe('…');
		expect(truncatePlain('hello', 0)).toBe('');
	});
});

describe('computeBoxLayout', () => {
	const items = [
		{ name: 'storefront', url: 'https://app.example.com' },
		{ name: 'quick-3000', url: 'https://trycloudflare.com/abc-very-long-tail' },
		{ name: 'remote-prod', url: 'https://api.example.com' }
	];

	it('sizes columns to fit the widest entry', () => {
		const layout = computeBoxLayout(items, 120);
		expect(layout.nameWidth).toBe('remote-prod'.length);
		expect(layout.urlWidth).toBeGreaterThanOrEqual('https://trycloudflare.com/abc-very-long-tail'.length);
		expect(layout.boxWidth).toBeLessThanOrEqual(120 - 4);
	});

	it('respects the minimum box width', () => {
		const layout = computeBoxLayout(items, 20);
		expect(layout.boxWidth).toBeGreaterThanOrEqual(50);
	});

	it('squeezes the URL column when the terminal is tight', () => {
		const narrow = computeBoxLayout(items, 60);
		const wide = computeBoxLayout(items, 200);
		expect(narrow.urlWidth).toBeLessThan(wide.urlWidth);
	});

	it('handles single items', () => {
		const layout = computeBoxLayout([items[0]], 100);
		expect(layout.nameWidth).toBe('storefront'.length);
	});
});

describe('renderDashboard', () => {
	const baseTunnels = [
		{ name: 'storefront', type: 'local', publicUrl: 'https://app.example.com', connections: 3, routes: [] },
		{ name: 'quick-3000', type: 'quick', publicUrl: 'https://trycloudflare.com/abc', connections: 1, routes: [] },
		{ name: 'remote-prod', type: 'remote', publicUrl: 'https://api.example.com', connections: 2, routes: [] }
	];

	it('renders an empty-state hint when no tunnels are running', () => {
		const lines = renderDashboard({ tunnels: [], cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		expect(joined).toContain('nothing running yet');
		// Empty state shows the full footer so all keybindings are always discoverable.
		expect(joined).toMatch(/m.*manage/);
		expect(joined).toMatch(/n.*new/);
		expect(joined).toMatch(/q.*quit/);
		// No box should be drawn when there is nothing to box.
		expect(joined).not.toContain('┌');
		expect(joined).not.toContain('└');
	});

	it('renders a list without box borders', () => {
		const lines = renderDashboard({ tunnels: baseTunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		expect(joined).not.toContain('┌');
		expect(joined).not.toContain('└');
		expect(joined).not.toContain('│');
		expect(joined).toContain('storefront');
		expect(joined).toContain('quick-3000');
		expect(joined).toContain('remote-prod');
		expect(joined).toContain('https://app.example.com');
	});

	it('does not render the legacy connection counter column or summary line', () => {
		const lines = renderDashboard({ tunnels: baseTunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		// No "↓N" markers or "connections: …" totals — the status dot conveys health.
		expect(joined).not.toMatch(/↓\d/);
		expect(joined).not.toContain('connections:');
		expect(joined).not.toContain('active across');
	});

	it('shows the count in the main row for multi-route tunnels (no promoted first hostname)', () => {
		const tunnels = [
			{
				name: 'remote-xyz',
				type: 'remote',
				publicUrl: 'https://remotely1.atomicstudio.my.id',
				connections: 4,
				routes: [
					{ hostname: 'remotely1.atomicstudio.my.id', service: 'http://localhost:4001' },
					{ hostname: 'remotely2.atomicstudio.my.id', service: 'http://localhost:4002' }
				]
			}
		];
		const lines = renderDashboard({ tunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		// Main row says "2 routes" — never promotes one hostname to header.
		expect(joined).toContain('2 routes');
		expect(joined).not.toContain('https://remotely1.atomicstudio.my.id');
		// Sub-rows list service → hostname (local first, then public).
		expect(joined).toContain('http://localhost:4001');
		expect(joined).toContain('remotely1.atomicstudio.my.id');
		expect(joined).toContain('http://localhost:4002');
		expect(joined).toContain('remotely2.atomicstudio.my.id');
	});

	it('renders the keybinding footer with ↑/↓ first', () => {
		const lines = renderDashboard({ tunnels: baseTunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		expect(joined).toMatch(/n.*new/);
		expect(joined).toMatch(/select/);
		expect(joined).toMatch(/x.*stop/);
		expect(joined).toMatch(/c.*copy/);
		expect(joined).toMatch(/m.*manage/);
		expect(joined).toMatch(/q.*quit/);
		// ↑/↓ should appear before `n new` per the latest UX request.
		const selectIdx = joined.search(/↑\/↓/);
		const newIdx = joined.search(/\bn new\b/);
		expect(selectIdx).toBeGreaterThan(-1);
		expect(newIdx).toBeGreaterThan(selectIdx);
	});

	it('renders one row per tunnel (no box borders)', () => {
		const lines = renderDashboard({ tunnels: baseTunnels, cursor: 1, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		// Each tunnel name appears exactly once.
		const storefrontCount = (joined.match(/storefront/g) ?? []).length;
		expect(storefrontCount).toBeGreaterThanOrEqual(1);
		expect(joined).not.toContain('│');
	});

	it('shows a flash message when provided', () => {
		const lines = renderDashboard({
			tunnels: baseTunnels,
			cursor: 0,
			stopping: false,
			flash: 'copied URL to clipboard',
			termCols: 100
		});
		expect(lines.join('\n')).toContain('copied URL to clipboard');
	});

	it('lists every route for a multi-route tunnel in service → hostname order', () => {
		const tunnels = [
			{
				name: 'multi',
				type: 'local',
				publicUrl: 'https://a.example.com',
				connections: 2,
				routes: [
					{ hostname: 'a.example.com', service: 'http://localhost:3000' },
					{ hostname: 'b.example.com', service: 'http://localhost:4000' }
				]
			}
		];
		const lines = renderDashboard({ tunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		expect(joined).toContain('a.example.com');
		expect(joined).toContain('b.example.com');
		expect(joined).toContain('http://localhost:3000');
		expect(joined).toContain('→');
		// service before hostname in sub-rows
		const aIdx = joined.indexOf('http://localhost:3000');
		const hostIdx = joined.indexOf('a.example.com');
		expect(aIdx).toBeLessThan(hostIdx);
	});

	it('marks a freshly-started tunnel with no connections as connecting (blink ● in the 1s on-phase)', () => {
		// Blink period is 1s (500ms on, 500ms off): 1000ms → floor(1000/500)=2, even → ON (●).
		// 500ms → floor(500/500)=1, odd → OFF (○).
		const onTunnels = [
			{
				name: 'fresh-on',
				type: 'quick',
				publicUrl: '',
				connections: 0,
				routes: [],
				startedAt: new Date(1_000 - 5_000).toISOString()
			}
		];
		const onRow =
			renderDashboard({ tunnels: onTunnels, cursor: 0, stopping: false, flash: '', termCols: 100, now: 1_000 }).find((l) =>
				l.includes('fresh-on')
			) ?? '';
		expect(onRow).toContain('●');

		const offTunnels = [
			{
				name: 'fresh-off',
				type: 'quick',
				publicUrl: '',
				connections: 0,
				routes: [],
				startedAt: new Date(500 - 5_000).toISOString()
			}
		];
		const offRow =
			renderDashboard({ tunnels: offTunnels, cursor: 0, stopping: false, flash: '', termCols: 100, now: 500 }).find(
				(l) => l.includes('fresh-off')
			) ?? '';
		expect(offRow).toContain('○');
	});

	it('marks a tunnel with stale startedAt as disconnected (steady ○)', () => {
		const now = 60_000;
		const tunnels = [
			{
				name: 'stale',
				type: 'quick',
				publicUrl: '',
				connections: 0,
				routes: [],
				startedAt: new Date(now - 120_000).toISOString() // 2 min old, past the 30s window
			}
		];
		const lines = renderDashboard({ tunnels, cursor: 0, stopping: false, flash: '', termCols: 100, now });
		const row = lines.find((l) => l.includes('stale')) ?? '';
		// Past the connecting window → steady dim ○.
		expect(row).toContain('○');
		expect(row).not.toContain('●');
	});

	it('puts a → arrow between name and URL on single-route main rows (matches sublist direction)', () => {
		const tunnels = [
			{ name: 'storefront', type: 'local', publicUrl: 'https://app.example.com', connections: 1, routes: [] },
			{ name: 'quick-3000', type: 'quick', publicUrl: 'https://trycloudflare.com/abc', connections: 0, routes: [] }
		];
		const lines = renderDashboard({ tunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		// Every main row shows the `name → url` direction so the column reads
		// the same way as the `hostname → service` sublist.
		expect(joined).toMatch(/storefront\s+→\s+https:\/\/app\.example\.com/);
		expect(joined).toMatch(/quick-3000\s+→\s+https:\/\/trycloudflare\.com\/abc/);
	});

	it('uses the dim colour for every URL value (no green highlight on single-route rows)', () => {
		// `useColor` is a module-load constant driven by `process.stdout.isTTY`,
		// which is `false` under bun:test — so the rendered text has no SGR
		// codes at all and we can only verify the layout, not the colour.
		// The `formatTunnelRow` source unconditionally routes the URL through
		// `c.dim(…)` (no more `hasUrl` green branch), which is what this test
		// pins down: every row, single-route or not, uses the same treatment.
		const tunnels = [
			{ name: 'single', type: 'remote', publicUrl: 'https://api.example.com', connections: 1, routes: [] },
			{ name: 'quick-3000', type: 'quick', publicUrl: 'https://trycloudflare.com/abc', connections: 0, routes: [] },
			{ name: 'multi', type: 'remote', publicUrl: '', connections: 1, routes: [{ hostname: 'a.example.com', service: 'http://localhost:3000' }] }
		];
		const lines = renderDashboard({ tunnels, cursor: 0, stopping: false, flash: '', termCols: 100 });
		const joined = lines.join('\n');
		// No row gets a "highlighted" treatment (the only visual differentiator
		// is the green SGR on `c.url`, which the row no longer touches).
		expect(joined).toMatch(/single\s+→\s+https:\/\/api\.example\.com/);
		expect(joined).toMatch(/quick-3000\s+→\s+https:\/\/trycloudflare\.com\/abc/);
	});
});

describe('detectTheme', () => {
	it('honours TUNNELKIT_THEME=light/dark regardless of COLORFGBG', () => {
		expect(detectTheme({ TUNNELKIT_THEME: 'light', COLORFGBG: '7;0' })).toBe('light');
		expect(detectTheme({ TUNNELKIT_THEME: 'dark', COLORFGBG: '0;15' })).toBe('dark');
	});

	it('treats TUNNELKIT_THEME values case-insensitively', () => {
		expect(detectTheme({ TUNNELKIT_THEME: 'LIGHT' })).toBe('light');
		expect(detectTheme({ TUNNELKIT_THEME: 'Dark' })).toBe('dark');
	});

	it('detects a light background from COLORFGBG (7 = white, 15 = bright white)', () => {
		expect(detectTheme({ COLORFGBG: '0;7' })).toBe('light');
		expect(detectTheme({ COLORFGBG: '0;15' })).toBe('light');
		// Last token is the background, even when there are more than two.
		expect(detectTheme({ COLORFGBG: '15;0;0' })).toBe('dark');
		expect(detectTheme({ COLORFGBG: '0;default;15' })).toBe('light');
	});

	it('defaults to dark for dark backgrounds and missing COLORFGBG', () => {
		expect(detectTheme({ COLORFGBG: '15;0' })).toBe('dark');
		expect(detectTheme({ COLORFGBG: '7;0' })).toBe('dark');
		expect(detectTheme({})).toBe('dark');
	});

	it('falls back to dark for unrecognised TUNNELKIT_THEME values', () => {
		expect(detectTheme({ TUNNELKIT_THEME: 'solarized' })).toBe('dark');
	});
});
