/**
 * Events — track tunnel state changes in real time.
 *
 * TunnelKit fires three high-level events:
 *   status-changed  — any tunnel starts, stops, or changes connection count
 *   connection      — a single edge connection comes up or goes down
 *   ingress-update  — a remote tunnel's ingress rules sync from Cloudflare
 *
 * status-changed alone is enough to build a health view. The connection event
 * gives per-edge detail (datacenter, IP) as it happens.
 *
 * Run with:  bun run examples/events.ts 3000
 */

import { TunnelKit } from '../src/index.js';

const service = process.argv[2] ?? '3000';

const tk = new TunnelKit();
await tk.bin.ensure();

// Fires on every start, stop, and connection change.
tk.on('status-changed', (tunnels) => {
	console.log('\n── tunnels ──');
	for (const t of tunnels) {
		console.log(`  ${t.id.padEnd(16)} ${t.publicUrl}  (${t.connections.length} connection(s))`);
	}
});

// Fires as each individual edge link comes up or goes down.
// A non-empty connections list means the tunnel is publicly reachable.
tk.on('connection', ({ id, info, status }) => {
	console.log(`[${id}] edge ${status}: ${info.location.colo} (${info.location.ip})`);
});

await tk.quick.start({ service });

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
