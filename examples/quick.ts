/**
 * Minimal example: start a quick tunnel pointing at a local port.
 *
 * Run with:  bun run examples/quick.ts 3000
 */

import { TunnelKit } from '../src/index.js';

const port = Number(process.argv[2] ?? 3000);

const tk = new TunnelKit({ logger: console });

if (!tk.isBinaryInstalled()) {
	console.log('cloudflared not found — downloading...');
	await tk.installBinary();
}

tk.on('status-changed', (tunnels) => {
	console.log('status-changed:', tunnels);
});

const { publicUrl } = await tk.startQuick({ port, autoStopMinutes: 10 });
console.log(`\n  → ${publicUrl}  (proxying http://localhost:${port})\n`);

process.on('SIGINT', async () => {
	console.log('\nStopping tunnel...');
	await tk.stopAll();
	process.exit(0);
});
