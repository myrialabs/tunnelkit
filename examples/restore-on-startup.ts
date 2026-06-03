/**
 * Case: restore tunnels after a restart.
 *
 * A long-running app persists its tunnels with TunnelStore, then re-launches
 * them on boot. This is the "reconnect everything" routine you'd call at
 * startup. (Quick tunnels are ephemeral by nature and are not persisted.)
 *
 * Run with:  bun run examples/restore-on-startup.ts
 */

import { TunnelKit, TunnelStore } from '../src/index.js';

const tk = new TunnelKit({ logger: console });
const store = new TunnelStore();

if (!tk.isBinaryInstalled()) await tk.installBinary();

const remotes = store.getRemotes();
const locals = store.getLocals().filter((l) => l.ingress.length > 0);

if (remotes.length === 0 && locals.length === 0) {
	console.log('Nothing persisted yet. Run examples/local.ts to create one.');
	process.exit(0);
}

for (const r of remotes) {
	console.log(`Restoring remote: ${r.label}`);
	await tk.startRemote({ id: r.id, token: r.token, label: r.label });
}

for (const l of locals) {
	console.log(`Restoring local: ${l.name}`);
	await tk.startLocal({
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
