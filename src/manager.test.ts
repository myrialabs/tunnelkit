import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TunnelKit, resolveQuickService } from './manager.js';
import { TunnelStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'tunnelkit-mgr-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('TunnelKit store option', () => {
	it('exposes a default TunnelStore at dataDir', () => {
		const tk = new TunnelKit({ dataDir: dir });
		expect(tk.store).toBeInstanceOf(TunnelStore);
		expect(tk.store?.path).toBe(join(dir, 'config.json'));
	});

	it('keeps the default store with store: true', () => {
		const tk = new TunnelKit({ dataDir: dir, store: true });
		expect(tk.store).toBeInstanceOf(TunnelStore);
	});

	it('disables persistence with store: false', () => {
		const tk = new TunnelKit({ dataDir: dir, store: false });
		expect(tk.store).toBeNull();
	});

	it('uses a caller-supplied store instance (advanced)', () => {
		const custom = new TunnelStore({ dataDir: dir });
		const tk = new TunnelKit({ dataDir: '/somewhere/else', store: custom });
		expect(tk.store).toBe(custom);
	});
});

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
