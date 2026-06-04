import { describe, it, expect } from 'bun:test';
import { parseCliArgs, firstValue } from './cli-args.js';

describe('parseCliArgs', () => {
	it('collects positionals in order', () => {
		const parsed = parseCliArgs(['3000', 'extra']);
		expect(parsed.positionals).toEqual(['3000', 'extra']);
		expect(parsed.flags.size).toBe(0);
	});

	it('parses --key value', () => {
		const parsed = parseCliArgs(['--token', 'abc123']);
		expect(firstValue(parsed, 'token')).toBe('abc123');
	});

	it('parses --key=value', () => {
		const parsed = parseCliArgs(['--service=http://localhost:3000']);
		expect(firstValue(parsed, 'service')).toBe('http://localhost:3000');
	});

	it('collects repeated flags into an array', () => {
		const parsed = parseCliArgs(['--route', 'a.example.com=http://localhost:3000', '--route', 'b.example.com=http://localhost:4000']);
		expect(parsed.values.route).toEqual([
			'a.example.com=http://localhost:3000',
			'b.example.com=http://localhost:4000'
		]);
	});

	it('treats a value-less long flag as boolean', () => {
		const parsed = parseCliArgs(['--verbose'], { booleans: ['verbose'] });
		expect(parsed.flags.has('verbose')).toBe(true);
	});

	it('does not consume the next token for declared booleans', () => {
		const parsed = parseCliArgs(['--verbose', '3000'], { booleans: ['verbose'] });
		expect(parsed.flags.has('verbose')).toBe(true);
		expect(parsed.positionals).toEqual(['3000']);
	});

	it('resolves short aliases', () => {
		const parsed = parseCliArgs(['-h'], { booleans: ['help'], aliases: { h: 'help' } });
		expect(parsed.flags.has('help')).toBe(true);
	});

	it('keeps an equals sign inside a value', () => {
		const parsed = parseCliArgs(['--route', 'app.example.com=http://localhost:3000']);
		expect(firstValue(parsed, 'route')).toBe('app.example.com=http://localhost:3000');
	});

	it('treats everything after `--` as positional', () => {
		const parsed = parseCliArgs(['quick', '--', '--not-a-flag']);
		expect(parsed.positionals).toEqual(['quick', '--not-a-flag']);
	});

	it('treats a trailing long flag with no value as boolean', () => {
		const parsed = parseCliArgs(['--force']);
		expect(parsed.flags.has('force')).toBe(true);
		expect(parsed.values.force).toBeUndefined();
	});
});
