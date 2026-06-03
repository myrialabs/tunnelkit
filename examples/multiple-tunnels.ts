/**
 * Case: run several quick tunnels at once and track them live.
 *
 * One manager can run many tunnels. The `status-changed` event fires whenever
 * any tunnel starts or stops — ideal for pushing state to a UI or dashboard.
 *
 * Run with:  bun run examples/multiple-tunnels.ts 3000 3001 5173
 */

import { TunnelKit } from '../src/index.js';

const ports = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (ports.length === 0) ports.push(3000, 3001);

const tk = new TunnelKit({ logger: console });
if (!tk.isBinaryInstalled()) await tk.installBinary();

tk.on('status-changed', (tunnels) => {
	console.log('\n── active tunnels ──');
	for (const t of tunnels) console.log(`  ${t.id.padEnd(12)} → ${t.publicUrl}`);
});

// Start them concurrently.
await Promise.all(ports.map((port) => tk.startQuick({ port, autoStopMinutes: 0 })));

console.log(`\nStarted ${ports.length} tunnels. Ctrl-C to stop all.`);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
