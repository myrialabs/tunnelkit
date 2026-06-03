/**
 * Low-level API — drive a cloudflared process directly with CloudflaredTunnel.
 *
 * Use this when you want full control over process lifecycle and events and
 * don't need TunnelKit's registry / timeouts / auto-stop.
 *
 * Run with:  bun run examples/low-level.ts 3000
 */

import { CloudflaredTunnel } from '../src/index.js';

const port = Number(process.argv[2] ?? 3000);

// Events are fully typed.
const tunnel = CloudflaredTunnel.quick(`http://localhost:${port}`);

tunnel.on('url', (url) => console.log('Public URL:', url));
tunnel.on('connected', (info) => console.log('Connected:', info));
tunnel.on('disconnected', (info) => console.log('Disconnected:', info));
tunnel.on('error', (err) => console.error('Error:', err.message));
tunnel.on('exit', (code, signal) => console.log(`Exited (code=${code}, signal=${signal})`));

process.on('SIGINT', () => {
	tunnel.stop();
	process.exit(0);
});
