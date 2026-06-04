/**
 * Local (named) tunnel — the full lifecycle, auto-persisted.
 *
 * This mirrors what a real app does: authenticate once, create a named tunnel,
 * route a hostname to it, then run it. TunnelKit saves the tunnel automatically
 * (to `tk.store`), so re-running reuses the saved tunnel instead of creating a
 * new one.
 *
 * Prerequisites: a Cloudflare account with a zone (domain) you control, and the
 * hostname you pass must belong to that zone.
 *
 * Run with:  bun run examples/local.ts app.example.com http://localhost:3000
 */

import { TunnelKit, type LocalTunnelConfig } from '../src/index.js';

const hostname = process.argv[2];
const service = process.argv[3] ?? 'http://localhost:3000';
if (!hostname) {
	console.error('Usage: bun run examples/local.ts <hostname> [service]');
	process.exit(1);
}

const tk = new TunnelKit({ logger: console }); // persistence on by default → tk.store

if (!tk.isBinaryInstalled()) {
	await tk.installBinary();
}

// 1. Authenticate (once). The auth URL must be opened in a browser; cloudflared
//    writes an origin cert when approved.
if (!tk.local.checkAuth().authenticated) {
	console.log('Not authenticated — starting login...');
	await new Promise<void>((resolve, reject) => {
		tk.local.login({
			onUrl: (url) => console.log('\n  Open this URL to authorize:\n  ' + url + '\n'),
			onComplete: resolve,
			onError: reject
		});
	});
	console.log('Authenticated.');
}

// 2. Reuse a saved tunnel for this hostname, or create a new one.
let config = tk.store?.getLocals().find((l) => l.ingress.some((r) => r.hostname === hostname)) as LocalTunnelConfig | undefined;
if (!config) {
	const name = `tunnelkit-${hostname.replace(/[^a-z0-9]/gi, '-')}`;
	const created = await tk.local.create(name);
	await tk.local.routeDns(name, hostname);
	config = { id: name, name, tunnelId: created.tunnelId, credentialsFile: created.credentialsFile, ingress: [{ hostname, service }] };
	console.log(`Created tunnel ${name} (${created.tunnelId}) and routed ${hostname}.`);
}

// 3. Run it. TunnelKit persists it to tk.store automatically.
await tk.local.start(config);
console.log(`\n  → https://${hostname}  (serving ${service})\n`);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
