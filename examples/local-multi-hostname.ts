/**
 * Case: map several hostnames through one local tunnel.
 *
 * A single named tunnel can serve many hostnames, each routed to a different
 * local service. This adds ingress rules to an existing tunnel (created in
 * examples/local.ts), routes DNS for each, then runs the tunnel.
 *
 * Run with:  bun run examples/local-multi-hostname.ts <localId>
 *            (omit <localId> to list the saved local tunnels)
 */

import { TunnelKit } from '../src/index.js';

const tk = new TunnelKit({ logger: console }); // persistence on by default → tk.store

const localId = process.argv[2];
if (!localId) {
	const locals = tk.store?.getLocals() ?? [];
	if (locals.length === 0) {
		console.log('No saved local tunnels. Run examples/local.ts first.');
	} else {
		console.log('Saved local tunnels (pass an id):');
		for (const l of locals) console.log(`  ${l.id}  ${l.name}`);
	}
	process.exit(0);
}

const cfg = tk.store?.getLocal(localId);
if (!cfg) {
	console.error(`No local tunnel with id ${localId}`);
	process.exit(1);
}

// Define the hostname → service map you want this tunnel to serve.
const routes: Array<[string, string]> = [
	['api.example.com', 'http://localhost:3000'],
	['web.example.com', 'http://localhost:5173']
];

// Merge the routes into the tunnel's ingress (dedup by hostname) and route DNS.
for (const [hostname, service] of routes) {
	const existing = cfg.ingress.find((r) => r.hostname === hostname);
	if (existing) existing.service = service;
	else cfg.ingress.push({ hostname, service });
	await tk.routeDns(cfg.name, hostname);
	console.log(`Routed ${hostname} → ${service}`);
}

// Run it — TunnelKit persists the updated ingress to tk.store automatically.
await tk.startLocal(cfg);
console.log('\nServing:', cfg.ingress);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
