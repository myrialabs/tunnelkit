/**
 * Case: restore tunnels after a restart.
 *
 * TunnelKit auto-saves the remote/local tunnels you start, so restoring is just
 * reading them back from `tk.store` and starting each again — the "reconnect
 * everything" routine you'd call at boot. (Quick tunnels are ephemeral and not
 * persisted.)
 *
 * Run with:  bun run examples/restore-on-startup.ts
 */

import { TunnelKit } from '../src/index.js';

const tk = new TunnelKit({ logger: console }); // persistence on by default → tk.store

if (!tk.isBinaryInstalled()) await tk.installBinary();

const remotes = tk.store?.getRemotes() ?? [];
const locals = (tk.store?.getLocals() ?? []).filter((l) => l.ingress.length > 0);

if (remotes.length === 0 && locals.length === 0) {
	console.log('Nothing persisted yet. Run examples/local.ts to create one.');
	process.exit(0);
}

for (const r of remotes) {
	console.log(`Restoring remote: ${r.label}`);
	await tk.remote.start({ id: r.id, token: r.token, label: r.label });
}

for (const l of locals) {
	console.log(`Restoring local: ${l.name}`);
	await tk.local.start({
		id: l.id,
		name: l.name,
		tunnelId: l.tunnelId,
		credentialsFile: l.credentialsFile,
		ingress: l.ingress
	});
}

console.log('\nRestored:', tk.list());

process.on('SIGINT', async () => {
	await tk.stopAll();
	process.exit(0);
});
