/**
 * Case: inspect and clean up named tunnels on your Cloudflare account.
 *
 * Lists every tunnel on the authenticated account; optionally deletes one by
 * name (handy for clearing orphans left by failed creates). Requires that you
 * have authenticated first (see examples/local.ts).
 *
 * Run with:  bun run examples/account-tunnels.ts              # list
 *            bun run examples/account-tunnels.ts old-tunnel   # delete by name
 */

import { TunnelKit } from '../src/index.js';

const tk = new TunnelKit({ logger: console });

if (!tk.local.checkAuth().authenticated) {
	console.error('Not authenticated. Run examples/local.ts to log in first.');
	process.exit(1);
}

const tunnels = await tk.local.list();
console.log(`Account has ${tunnels.length} tunnel(s):`);
for (const t of tunnels) {
	console.log(`  ${t.name.padEnd(24)} ${t.id}  (${t.connections.length} active connection(s))`);
}

const nameToDelete = process.argv[2];
if (nameToDelete) {
	const match = tunnels.find((t) => t.name === nameToDelete);
	if (!match) {
		console.error(`\nNo tunnel named "${nameToDelete}".`);
		process.exit(1);
	}
	console.log(`\nDeleting "${nameToDelete}" (${match.id})...`);
	await tk.local.delete(match.id);
	tk.local.cleanupFiles(match.id);
	console.log('Deleted.');
}
