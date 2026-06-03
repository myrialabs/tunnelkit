/**
 * Remote (token-based) tunnel.
 *
 * A "remote" tunnel is created and configured in the Cloudflare dashboard, then
 * run locally from its token. Ingress (which hostnames map to which services)
 * is managed in the dashboard and pushed to cloudflared at runtime — tunnelkit
 * surfaces it via the `ingress-update` event and the resolved promise.
 *
 * Run with:  CF_TUNNEL_TOKEN=ey... bun run examples/remote.ts
 */

import { TunnelKit } from '../src/index.js';

const token = process.env.CF_TUNNEL_TOKEN;
if (!token) {
	console.error('Set CF_TUNNEL_TOKEN (copy it from the Cloudflare Zero Trust dashboard).');
	process.exit(1);
}

const tk = new TunnelKit({ logger: console });

if (!tk.isBinaryInstalled()) {
	await tk.installBinary();
}

tk.on('ingress-update', ({ id, ingress }) => {
	console.log(`[${id}] ingress updated:`, ingress);
});

const { ingress } = await tk.startRemote({ id: 'prod', token, label: 'prod' });
console.log('Connected. Ingress:', ingress);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
