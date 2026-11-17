/**
 * Stopping waits for cloudflared to exit. Uses a fake `cloudflared` script:
 * like the real one it prints a trycloudflare URL and, on SIGINT, takes a
 * while to drain before exiting (or ignores SIGINT entirely).
 *
 * Before 0.1.0 `stop()` returned at once while cloudflared kept running for
 * seconds (measured 5.8 s for a quick tunnel), so a host's shutdown finished
 * with the tunnel still up, and a restart of the same tunnel overlapped it.
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { platform, tmpdir } from 'os';
import { join } from 'path';
import { CloudflaredTunnel } from './cloudflared-tunnel.js';
import { TunnelKit } from './tunnelkit.js';

const POSIX = platform() !== 'win32';
const dir = mkdtempSync(join(tmpdir(), 'tunnelkit-stop-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake cloudflared that drains for `drainMs` on SIGINT (or ignores it). */
function fakeCloudflared(name: string, drainMs: number | 'ignore'): string {
	const binDir = join(dir, name);
	mkdirSync(binDir, { recursive: true });
	const path = join(binDir, 'cloudflared');
	const onInt = drainMs === 'ignore' ? '() => {}' : `() => setTimeout(() => process.exit(0), ${drainMs})`;
	writeFileSync(
		path,
		`#!/usr/bin/env bun\nprocess.on('SIGINT', ${onInt});\nconsole.error('INF |  https://fake-${name}.trycloudflare.com  |');\nsetInterval(() => {}, 1000);\n`
	);
	chmodSync(path, 0o755);
	return path;
}

/** Resolves once the (fake) tunnel reported its URL — it is up and handling signals. */
const ready = (tunnel: CloudflaredTunnel) => new Promise<void>((resolve) => tunnel.once('url', () => resolve()));

const exited = (tunnel: CloudflaredTunnel) => tunnel.process.exitCode !== null || tunnel.process.signalCode !== null;

describe.skipIf(!POSIX)('CloudflaredTunnel.stop', () => {
	it('resolves only once the process has exited', async () => {
		const tunnel = CloudflaredTunnel.quick('http://localhost:1', fakeCloudflared('drain', 300));
		await ready(tunnel);
		const started = Date.now();
		await tunnel.stop();
		expect(exited(tunnel)).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
	});

	it('kills a process that does not exit within the grace window', async () => {
		const tunnel = CloudflaredTunnel.quick('http://localhost:1', fakeCloudflared('stubborn', 'ignore'));
		await ready(tunnel);
		await tunnel.stop(200);
		expect(exited(tunnel)).toBe(true);
		expect(tunnel.process.signalCode).toBe('SIGKILL');
	});

	it('returns the same stop to every caller, and resolves at once after exit', async () => {
		const tunnel = CloudflaredTunnel.quick('http://localhost:1', fakeCloudflared('twice', 100));
		await ready(tunnel);
		const first = tunnel.stop();
		expect(tunnel.stop()).toBe(first);
		await first;
		await tunnel.stop();
		expect(exited(tunnel)).toBe(true);
	});
});

describe.skipIf(!POSIX)('TunnelKit quick tunnels', () => {
	it('stop() waits for the process, and a restart of the same service never overlaps it', async () => {
		const installDir = join(dir, 'kit');
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, 'cloudflared'), await Bun.file(fakeCloudflared('kit', 300)).text());
		chmodSync(join(installDir, 'cloudflared'), 0o755);
		const tk = new TunnelKit({ dataDir: join(dir, 'kit-data'), installDir, store: false, quickTimeoutMs: 5000 });

		await tk.quick.start({ service: 4321 });
		const pids = () => new TextDecoder().decode(Bun.spawnSync(['pgrep', '-f', `${installDir}/cloudflared tunnel --url`]).stdout).trim().split('\n').filter(Boolean);
		expect(pids()).toHaveLength(1);

		const stopping = tk.stopAll();
		const restarted = tk.quick.start({ service: 4321 }); // waits for the stop of the same service
		await stopping;
		await restarted;
		expect(pids()).toHaveLength(1);
		expect(tk.list().filter((t) => t.id === 'quick:http://localhost:4321')).toHaveLength(1);

		await tk.stopAll();
		expect(pids()).toHaveLength(0);
	});
});
