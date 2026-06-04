/**
 * Minimal example: start a quick tunnel pointing at a local service.
 *
 * Run with:  bun run examples/quick.ts 3000
 * (a bare port is shorthand for http://localhost:<port>; a full URL also works)
 */

import { TunnelKit } from '../src/index.js';

const service = process.argv[2] ?? '3000';

const tk = new TunnelKit({ logger: console });

if (!tk.isBinaryInstalled()) {
	console.log('cloudflared not found — downloading...');
	await tk.installBinary();
}

tk.on('status-changed', (tunnels) => {
	console.log('status-changed:', tunnels);
});

const { publicUrl, service: target } = await tk.startQuick({ service, autoStopMinutes: 10 });
console.log(`\n  → ${publicUrl}  (proxying ${target})\n`);

process.on('SIGINT', async () => {
	console.log('\nStopping tunnel...');
	await tk.stopAll();
	process.exit(0);
});
