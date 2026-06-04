/**
 * Case: receive webhooks on your laptop.
 *
 * Starts a real local HTTP server, then exposes it with a quick tunnel so an
 * external service (Stripe, GitHub, etc.) can POST to a public URL. Every
 * request is logged. Uses `node:http` so it runs on both Node and Bun.
 *
 * Run with:  bun run examples/webhook-server.ts 4000
 */

import { createServer } from 'node:http';
import { TunnelKit } from '../src/index.js';

const port = Number(process.argv[2] ?? 4000);

const server = createServer((req, res) => {
	let body = '';
	req.on('data', (chunk) => (body += chunk));
	req.on('end', () => {
		console.log(`← ${req.method} ${req.url}`, body || '(empty body)');
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ received: true }));
	});
});
server.listen(port, () => console.log(`Local server listening on http://localhost:${port}`));

const tk = new TunnelKit({ logger: console });
if (!tk.isBinaryInstalled()) await tk.installBinary();

// No autoStopMinutes → the tunnel stays up until you stop it.
const { publicUrl } = await tk.startQuick({ service: port });
console.log(`\n  Public webhook URL: ${publicUrl}\n  Point your webhook here and watch requests arrive.\n`);

const shutdown = async () => {
	await tk.stopAll();
	server.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
