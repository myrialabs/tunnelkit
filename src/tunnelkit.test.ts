import { describe, it, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { platform, tmpdir } from 'os';
import { join } from 'path';
import { TunnelKit, resolveQuickService } from './tunnelkit.js';
import { TunnelStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'tunnelkit-mgr-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('TunnelKit store option', () => {
	it('exposes a default TunnelStore at dataDir', () => {
		const tk = new TunnelKit({ dataDir: dir });
		expect(tk.store).toBeInstanceOf(TunnelStore);
		expect(tk.store.path).toBe(join(dir, 'config.json'));
	});

	it('keeps the default store with store: true', () => {
		const tk = new TunnelKit({ dataDir: dir, store: true });
		expect(tk.store).toBeInstanceOf(TunnelStore);
	});

	it('returns a noop TunnelStore with store: false', () => {
		const tk = new TunnelKit({ dataDir: dir, store: false });
		expect(tk.store).toBeInstanceOf(TunnelStore);
		// noop store reads empty and writes nothing
		expect(tk.store.getRemotes()).toEqual([]);
		expect(tk.store.path).toBe('');
	});

	it('uses a caller-supplied store instance (advanced)', () => {
		const custom = new TunnelStore({ dataDir: dir });
		const tk = new TunnelKit({ dataDir: '/somewhere/else', store: custom });
		expect(tk.store).toBe(custom);
	});
});

describe('TunnelKit isTunnelKnown default', () => {
	it('defaults to a store-aware predicate when a store is configured', () => {
		const dataDir = join(dir, 'known-default');
		const store = new TunnelStore({ dataDir });
		store.upsertLocal({ id: 'L1', name: 'one', tunnelId: 'uuid-xyz', credentialsFile: '/tmp/c.json', ingress: [] });

		const tk = new TunnelKit({ dataDir, store });
		const predicate = (tk as unknown as { isTunnelKnown: (id: string) => boolean }).isTunnelKnown;
		expect(predicate('uuid-xyz')).toBe(true);
		expect(predicate('uuid-other')).toBe(false);
	});

	it('defaults to a constant false when store is disabled', () => {
		const tk = new TunnelKit({ dataDir: dir, store: false });
		const predicate = (tk as unknown as { isTunnelKnown: (id: string) => boolean }).isTunnelKnown;
		expect(predicate('any-id')).toBe(false);
	});

	it('honors a caller-supplied isTunnelKnown over the default', () => {
		const dataDir = join(dir, 'known-custom');
		const store = new TunnelStore({ dataDir });
		store.upsertLocal({ id: 'L1', name: 'one', tunnelId: 'uuid-xyz', credentialsFile: '/tmp/c.json', ingress: [] });

		const tk = new TunnelKit({
			dataDir,
			store,
			isTunnelKnown: (id) => id === 'manual-match'
		});
		const predicate = (tk as unknown as { isTunnelKnown: (id: string) => boolean }).isTunnelKnown;
		expect(predicate('manual-match')).toBe(true);
		expect(predicate('uuid-xyz')).toBe(false);
	});
});

describe('TunnelKit.bin', () => {
	it('bin.ensure() returns the managed path without downloading when one already exists', async () => {
		const dataDir = join(dir, 'ensure-binary-existing');
		const installDir = join(dataDir, 'bin');
		const binaryName = platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
		const binaryPath = join(installDir, binaryName);
		// Drop a fake binary file so resolveCloudflaredBinary finds it before the
		// PATH fallback. bin.ensure() should not try to install over it.
		if (!existsSync(installDir)) {
			mkdirSync(installDir, { recursive: true });
		}
		writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

		const tk = new TunnelKit({ dataDir, installDir });
		const resolved = await tk.bin.ensure();
		expect(resolved).toBe(binaryPath);
		expect(tk.bin.status().installed).toBe(true);
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
