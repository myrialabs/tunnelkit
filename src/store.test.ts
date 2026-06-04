import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TunnelStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'tunnelkit-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('remote round-trip persists across instances', () => {
	const store = new TunnelStore({ dataDir: dir });
	expect(store.getRemotes()).toEqual([]);
	const entry = store.addRemote('prod', 'secret-token');

	// A fresh instance reads the same file.
	const reopened = new TunnelStore({ dataDir: dir });
	expect(reopened.getRemote(entry.id)?.token).toBe('secret-token');

	expect(store.removeRemote(entry.id)).toBe(true);
	expect(store.getRemotes()).toEqual([]);
});

test('local ingress add updates and removes by hostname', () => {
	const store = new TunnelStore({ dataDir: dir });
	const local = store.addLocal('t', 'uuid-1', '/creds.json');

	store.addLocalIngress(local.id, 'a.example.com', 'http://localhost:3000');
	store.addLocalIngress(local.id, 'a.example.com', 'http://localhost:4000'); // same host → update

	let cfg = store.getLocal(local.id)!;
	expect(cfg.ingress).toHaveLength(1);
	expect(cfg.ingress[0].service).toBe('http://localhost:4000');

	cfg = store.removeLocalIngress(local.id, 'a.example.com')!;
	expect(cfg.ingress).toHaveLength(0);

	store.removeLocal(local.id);
});

test('upsertRemote inserts then updates the same id (no duplicates)', () => {
	const store = new TunnelStore({ dataDir: dir });
	store.upsertRemote('prod', 'prod', 'tok-1');
	store.upsertRemote('prod', 'prod', 'tok-2'); // same id → update in place

	const remotes = store.getRemotes().filter((r) => r.id === 'prod');
	expect(remotes).toHaveLength(1);
	expect(remotes[0].token).toBe('tok-2');
	store.removeRemote('prod');
});

test('upsertLocal replaces the entry (incl. ingress) for a stable id', () => {
	const store = new TunnelStore({ dataDir: dir });
	store.upsertLocal({ id: 'app', name: 'app', tunnelId: 'uuid-1', credentialsFile: '/c1.json', ingress: [{ hostname: 'a.example.com', service: 'http://localhost:3000' }] });
	store.upsertLocal({ id: 'app', name: 'app', tunnelId: 'uuid-2', credentialsFile: '/c2.json', ingress: [{ hostname: 'b.example.com', service: 'http://localhost:4000' }] });

	const locals = store.getLocals().filter((l) => l.id === 'app');
	expect(locals).toHaveLength(1);
	expect(locals[0].tunnelId).toBe('uuid-2');
	expect(locals[0].ingress).toEqual([{ hostname: 'b.example.com', service: 'http://localhost:4000' }]);
	store.removeLocal('app');
});

test('authorized zone get/set/clear', () => {
	const store = new TunnelStore({ dataDir: dir });
	expect(store.getZone()).toBeNull();
	store.setZone('example.com');
	expect(store.getZone()).toBe('example.com');
	store.clearZone();
	expect(store.getZone()).toBeNull();
});
