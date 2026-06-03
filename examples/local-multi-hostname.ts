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

import { TunnelKit, TunnelStore } from '../src/index.js';

const tk = new TunnelKit({ logger: console });
const store = new TunnelStore();

const localId = process.argv[2];
if (!localId) {
	const locals = store.getLocals();
	if (locals.length === 0) {
		console.log('No saved local tunnels. Run examples/local.ts first.');
	} else {
		console.log('Saved local tunnels (pass an id):');
		for (const l of locals) console.log(`  ${l.id}  ${l.name}`);
	}
	process.exit(0);
}

// Define the hostname → service map you want this tunnel to serve.
const routes: Array<[string, string]> = [
	['api.example.com', 'http://localhost:3000'],
	['web.example.com', 'http://localhost:5173']
];

for (const [hostname, service] of routes) {
	const updated = store.addLocalIngress(localId, hostname, service);
	if (!updated) {
		console.error(`No local tunnel with id ${localId}`);
		process.exit(1);
	}
	await tk.routeDns(updated.tunnelId, hostname);
	console.log(`Routed ${hostname} → ${service}`);
}

const cfg = store.getLocal(localId)!;
await tk.startLocal({
	id: cfg.id,
	name: cfg.name,
	tunnelId: cfg.tunnelId,
	credentialsFile: cfg.credentialsFile,
	ingress: cfg.ingress
});
console.log('\nServing:', cfg.ingress);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
