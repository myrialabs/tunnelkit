import { describe, it, expect } from 'bun:test';
import { parseKey, navigate, formatUptime } from './cli-ui.js';

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
