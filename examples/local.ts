/**
 * Local (named) tunnel — the full lifecycle, auto-persisted.
 *
 * On first run: authenticates, creates a named tunnel on Cloudflare, routes
 * DNS, and starts it. On subsequent runs: reuses the saved config directly
 * (no Cloudflare API calls needed).
 *
 * Prerequisites: a Cloudflare account with a zone you control; the hostname
 * must belong to that zone.
 *
 * Run with:  bun run examples/local.ts app.example.com http://localhost:3000
 */

import { TunnelKit } from '../src/index.js';

const hostname = process.argv[2];
const service = process.argv[3] ?? 'http://localhost:3000';
if (!hostname) {
	console.error('Usage: bun run examples/local.ts <hostname> [service]');
	process.exit(1);
}

const tk = new TunnelKit({ logger: console });

await tk.bin.ensure();

// 1. Authenticate (once). Open the URL in a browser; cloudflared writes a cert on approval.
if (!tk.local.checkAuth().authenticated) {
	console.log('Not authenticated — starting login...');
	await new Promise<void>((resolve, reject) => {
		tk.local.login({
			onUrl: (url) => console.log('\n  Open this URL to authorize:\n  ' + url + '\n'),
			onComplete: resolve,
			onError: reject
		});
	});
	console.log('Authenticated.\n');
}

// 2. Get or create a tunnel config for this hostname.
//    First run: creates a Cloudflare tunnel and routes the DNS record.
//    Subsequent runs: reads the saved config from tk.store — no API calls.
const tunnelId = hostname.replace(/[^a-z0-9]/gi, '-');
const config = await tk.local.prepare({ id: tunnelId, hostname, service });

// 3. Run it. TunnelKit persists the config automatically.
await tk.local.start(config);
console.log(`\n  → https://${hostname}  (serving ${service})\n`);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
