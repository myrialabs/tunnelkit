/**
 * Restore saved tunnels on startup.
 *
 * TunnelKit auto-saves every remote and local tunnel you start, so bringing
 * them back after a restart is a single call. Quick tunnels are ephemeral and
 * never saved.
 *
 * Run with:  bun run examples/restore-on-startup.ts
 */

import { TunnelKit } from '../src/index.js';

const tk = new TunnelKit({ logger: console });

await tk.bin.ensure();

const { remotes, locals } = await tk.restoreAll();

if (remotes + locals === 0) {
	console.log('Nothing saved yet. Start some tunnels first (e.g. bun run examples/remote.ts).');
	process.exit(0);
}

console.log(`\nRestored ${remotes} remote(s) and ${locals} local(s).`);
console.log('Running:', tk.list().map((t) => t.id));

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
