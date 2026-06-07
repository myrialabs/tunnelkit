/**
 * Case: run several quick tunnels at once and track them live.
 *
 * One manager can run many tunnels. The `status-changed` event fires whenever
 * any tunnel starts or stops — ideal for pushing state to a UI or dashboard.
 *
 * Run with:  bun run examples/multiple-tunnels.ts 3000 3001 5173
 */

import { TunnelKit } from '../src/index.js';

const services = process.argv.slice(2).filter(Boolean);
if (services.length === 0) services.push('3000', '3001');

const tk = new TunnelKit({ logger: console });
await tk.ensureBinary();

tk.on('status-changed', (tunnels) => {
	console.log('\n── active tunnels ──');
	for (const t of tunnels) console.log(`  ${t.id.padEnd(12)} → ${t.publicUrl}`);
});

// Start them concurrently (a bare port is shorthand for http://localhost:<port>).
await Promise.all(services.map((service) => tk.quick.start({ service })));

console.log(`\nStarted ${services.length} tunnels. Ctrl-C to stop all.`);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
