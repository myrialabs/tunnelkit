import { describe, it, expect } from 'bun:test';
import { resolveQuickService } from './manager.js';

describe('resolveQuickService', () => {
	it('expands a bare numeric port to a localhost URL', () => {
		expect(resolveQuickService(3000)).toBe('http://localhost:3000');
		expect(resolveQuickService('8080')).toBe('http://localhost:8080');
	});

	it('trims surrounding whitespace before resolving', () => {
		expect(resolveQuickService('  3000  ')).toBe('http://localhost:3000');
	});

	it('passes a full service URL through unchanged', () => {
		expect(resolveQuickService('http://localhost:9000')).toBe('http://localhost:9000');
		expect(resolveQuickService('https://192.168.1.5:8443')).toBe('https://192.168.1.5:8443');
	});

	it('rejects an out-of-range port', () => {
		expect(() => resolveQuickService(0)).toThrow();
		expect(() => resolveQuickService('70000')).toThrow();
	});

	it('rejects an empty target', () => {
		expect(() => resolveQuickService('   ')).toThrow();
	});
});
