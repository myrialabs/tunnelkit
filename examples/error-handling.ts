/**
 * Case: handle the errors tunnel operations can throw.
 *
 * The notable typed error is CloudflaredMissingError (no binary resolvable).
 * Connection timeouts, bad tokens, and DNS failures surface as plain Errors
 * with descriptive messages.
 *
 * Run with:  bun run examples/error-handling.ts
 */

import { TunnelKit, CloudflaredMissingError } from '../src/index.js';

// A short timeout so a stuck start fails fast in this demo.
const tk = new TunnelKit({ logger: console, quickTimeoutMs: 8000 });

async function startWithRecovery(port: number) {
	try {
		const { publicUrl } = await tk.startQuick({ port });
		console.log('Started:', publicUrl);
	} catch (err) {
		if (err instanceof CloudflaredMissingError) {
			console.log('cloudflared not found — installing, then retrying once...');
			await tk.installBinary();
			const { publicUrl } = await tk.startQuick({ port });
			console.log('Started after install:', publicUrl);
			return;
		}
		// Timeout, bad config, process crash, etc.
		console.error('Could not start tunnel:', err instanceof Error ? err.message : err);
	}
}

await startWithRecovery(3000);

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
