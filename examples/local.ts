/**
 * Local (named) tunnel — the full lifecycle, persisted with TunnelStore.
 *
 * This mirrors what a real app does: authenticate once, create a named tunnel,
 * persist it, route a hostname to it, then run it. Re-running reuses the saved
 * tunnel instead of creating a new one.
 *
 * Prerequisites: a Cloudflare account with a zone (domain) you control, and the
 * hostname you pass must belong to that zone.
 *
 * Run with:  bun run examples/local.ts app.example.com http://localhost:3000
 */

import { TunnelKit, TunnelStore } from '../src/index.js';

const hostname = process.argv[2];
const service = process.argv[3] ?? 'http://localhost:3000';
if (!hostname) {
	console.error('Usage: bun run examples/local.ts <hostname> [service]');
	process.exit(1);
}

const tk = new TunnelKit({ logger: console });
const store = new TunnelStore();

if (!tk.isBinaryInstalled()) {
	await tk.installBinary();
}

// 1. Authenticate (once). The auth URL must be opened in a browser; cloudflared
//    writes an origin cert when approved.
if (!tk.checkAuth().authenticated) {
	console.log('Not authenticated — starting login...');
	await new Promise<void>((resolve, reject) => {
		tk.login({
			onUrl: (url) => console.log('\n  Open this URL to authorize:\n  ' + url + '\n'),
			onComplete: resolve,
			onError: reject
		});
	});
	console.log('Authenticated.');
}

// 2. Reuse a saved tunnel for this hostname, or create + persist a new one.
let entry = store.getLocals().find((l) => l.ingress.some((r) => r.hostname === hostname));
if (!entry) {
	const name = `tunnelkit-${hostname.replace(/[^a-z0-9]/gi, '-')}`;
	const created = await tk.createTunnel(name);
	entry = store.addLocal(name, created.tunnelId, created.credentialsFile);
	store.addLocalIngress(entry.id, hostname, service);
	await tk.routeDns(created.tunnelId, hostname);
	entry = store.getLocal(entry.id)!;
	console.log(`Created tunnel ${name} (${created.tunnelId}) and routed ${hostname}.`);
}

// 3. Run it.
await tk.startLocal({
	id: entry.id,
	name: entry.name,
	tunnelId: entry.tunnelId,
	credentialsFile: entry.credentialsFile,
	ingress: entry.ingress
});
console.log(`\n  → https://${hostname}  (serving ${service})\n`);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
