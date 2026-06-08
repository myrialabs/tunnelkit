/**
 * Command handlers for the tunnelkit CLI.
 *
 * One function per leaf command. Shared infrastructure lives in `cli-helpers.ts`;
 * interactive panel flows in `cli-flows.ts`.
 */

import { resolveQuickService, CLOUDFLARE_TUNNELS_DASHBOARD_URL } from './tunnelkit.js';
import { c, out, spinner, prompt, confirm } from './cli-ui.js';
import { firstValue, type ParsedArgs } from './cli-args.js';
import { extractTunnelToken } from './tunnel-token.js';
import {
	makeKit,
	makeStore,
	isInteractive,
	ensureBinary,
	performLogin,
	startQuick,
	startRemote,
	startLocalNew,
	startLocalSaved,
	validateQuickService,
	gatherRoutes,
	parseAutoStop
} from './cli-helpers.js';
import { enterSession } from './cli-flows.js';

export type Handler = (parsed: ParsedArgs) => void | Promise<void>;

async function cmdQuick(parsed: ParsedArgs): Promise<void> {
	let service = parsed.positionals[0];
	if (!service) {
		if (!isInteractive()) {
			throw new Error('quick requires a port or URL, e.g. `tunnelkit quick 3000` or `tunnelkit quick http://localhost:3000`');
		}
		service = await prompt('Local port or URL to expose', { default: '3000', required: true, validate: validateQuickService });
	}
	const resolved = resolveQuickService(service);
	const autoStopMinutes = parseAutoStop(parsed);

	const tk = makeKit(parsed);
	await startQuick(tk, resolved, autoStopMinutes);
	if (autoStopMinutes && autoStopMinutes > 0) out(c.dim(`  auto-stops in ${autoStopMinutes} min`));
	enterSession(tk);
}

async function cmdRemote(parsed: ParsedArgs): Promise<void> {
	const name = parsed.positionals[0];
	const tk = makeKit(parsed);
	const store = tk.store;

	let explicitToken = firstValue(parsed, 'token') ?? process.env.CF_TUNNEL_TOKEN;
	const saved = !explicitToken && name && store
		? store.getRemotes().find((r) => r.name === name || r.id === name)
		: undefined;

	if (!explicitToken && !saved && isInteractive()) {
		explicitToken = extractTunnelToken(await prompt('Tunnel token', { required: true }));
	}

	const token = explicitToken ?? saved?.token;
	if (!token) {
		throw new Error(
			name
				? `No saved tunnel named "${name}". Provide a token with --token <token> (or set CF_TUNNEL_TOKEN).`
				: 'remote requires a token via --token <token> or the CF_TUNNEL_TOKEN env var (or a saved name).'
		);
	}

	const explicitName = firstValue(parsed, 'name') ?? name;
	const tunnelName = firstValue(parsed, 'name') ?? saved?.name ?? name;
	const id = firstValue(parsed, 'id') ?? saved?.id ?? explicitName ?? 'cli-remote';

	await startRemote(tk, { id, token, name: tunnelName });

	if (store && explicitToken && explicitName) {
		out(c.dim(`  saved as "${explicitName}" — reuse with \`tunnelkit remote run ${explicitName}\``));
	}
	enterSession(tk);
}

async function cmdLocal(parsed: ParsedArgs): Promise<void> {
	let name = parsed.positionals[0];
	if (!name) {
		if (!isInteractive()) {
			throw new Error('local run requires a tunnel name, e.g. `tunnelkit local run my-app --route app.example.com=http://localhost:3000`');
		}
		name = await prompt('Tunnel name', { required: true });
	}

	const routes = gatherRoutes(parsed);
	const tk = makeKit(parsed);
	const store = tk.store;

	if (routes.length === 0) {
		const previous = store.getLocals().find((l) => l.name === name);
		if (!previous || previous.ingress.length === 0) {
			throw new Error('local run requires at least one --route hostname=service (or --hostname/--service), or a previously saved tunnel of the same name');
		}
		await startLocalSaved(tk, name, previous);
		enterSession(tk);
		return;
	}

	await startLocalNew(tk, name, routes);
	if (store) out(c.dim(`  saved — rerun with \`tunnelkit local run ${name}\``));
	enterSession(tk);
}

async function cmdLogin(parsed: ParsedArgs): Promise<void> {
	const tk = makeKit(parsed);
	await ensureBinary(tk);

	if (tk.local.checkAuth().authenticated) {
		out(c.accent('✓ Already authenticated with Cloudflare.'));
		return;
	}
	await performLogin(tk);
}

function cmdLogout(parsed: ParsedArgs): void {
	const tk = makeKit(parsed);
	const { success } = tk.local.logout();
	out(success ? c.accent('✓ Logged out (certificate removed).') : c.yellow('Nothing to remove.'));
}

async function cmdList(parsed: ParsedArgs): Promise<void> {
	const tk = makeKit(parsed);
	await ensureBinary(tk);

	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}

	const tunnels = await tk.local.list();
	if (tunnels.length === 0) {
		out(c.dim('No named tunnels on this account.'));
		return;
	}

	const nameWidth = Math.max(4, ...tunnels.map((t) => t.name.length));
	out(`  ${c.bold('NAME'.padEnd(nameWidth))}  ${c.bold('ID'.padEnd(36))}  ${c.bold('CONNS')}`);
	for (const t of tunnels) {
		out(`  ${t.name.padEnd(nameWidth)}  ${c.dim(t.id.padEnd(36))}  ${t.connections.length}`);
	}
}

async function cmdDelete(parsed: ParsedArgs): Promise<void> {
	const target = parsed.positionals[0];
	if (!target) throw new Error('local delete requires a tunnel name or id, e.g. `tunnelkit local delete my-app`');

	if (!parsed.flags.has('yes') && isInteractive()) {
		const ok = await confirm(`Delete "${target}" from Cloudflare? This cannot be undone.`, { default: false });
		if (!ok) {
			out(c.dim('Aborted.'));
			return;
		}
	}

	const tk = makeKit(parsed);
	await ensureBinary(tk);
	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}

	const spin = spinner(`Deleting "${target}"…`);
	try {
		await tk.local.delete(target);
	} catch (error) {
		spin.stop();
		throw error;
	}
	spin.stop(c.accent(`✓ Deleted ${target}.`));

	const store = tk.store;
	const saved = store.getLocals().find((l) => l.name === target || l.id === target);
	if (saved) store.removeLocal(saved.id);
}

function cmdSaved(parsed: ParsedArgs): void {
	const store = makeStore(parsed);
	if (!store) {
		out(c.dim('Saved store disabled (--no-save).'));
		return;
	}

	const remotes = store.getRemotes();
	const locals = store.getLocals();
	if (remotes.length === 0 && locals.length === 0) {
		out(c.dim('No saved tunnels.'));
		out(c.dim(`  ${store.path}`));
		return;
	}

	const nameWidth = Math.max(
		4,
		...remotes.map((r) => r.name.length),
		...locals.map((l) => l.name.length)
	);
	for (const r of remotes) {
		out(`  ${c.dim('○')}  ${c.bold(r.name.padEnd(nameWidth))}  ${c.dim('remote')}  ${c.dim(r.id)}`);
	}
	for (const l of locals) {
		const hosts = l.ingress.map((i) => i.hostname).filter(Boolean).join(', ');
		const info = hosts ? `→ ${hosts}` : l.tunnelId;
		out(`  ${c.dim('○')}  ${c.bold(l.name.padEnd(nameWidth))}  ${c.dim('local ')}  ${c.dim(info)}`);
	}
	out(c.dim(`\n  reuse with \`tunnelkit remote run <name>\` / \`tunnelkit local run <name>\`, remove with \`tunnelkit forget <name>\``));
}

async function cmdForget(parsed: ParsedArgs): Promise<void> {
	const target = parsed.positionals[0];
	if (!target) throw new Error('forget requires a saved name, e.g. `tunnelkit forget prod`');

	const store = makeStore(parsed);
	if (!store) throw new Error('Cannot forget a saved tunnel while --no-save is set.');

	const remote = store.getRemotes().find((r) => r.name === target || r.id === target);
	const local = remote ? undefined : store.getLocals().find((l) => l.name === target || l.id === target);
	if (!remote && !local) {
		out(c.yellow(`No saved tunnel named "${target}".`));
		return;
	}

	if (!parsed.flags.has('yes') && isInteractive()) {
		const message =
			remote
				? `Forget remote "${target}"? (Cloudflare tunnel is dashboard-managed and untouched.)`
				: `Forget local "${target}"? This DELETES the tunnel from Cloudflare (irreversible).`;
		const ok = await confirm(message, { default: false });
		if (!ok) {
			out(c.dim('Aborted.'));
			return;
		}
	}

	if (remote) {
		store.removeRemote(remote.id);
		out(
			c.accent(`✓ Forgot remote "${target}".`) +
				`\n${c.dim(`  (Cloudflare tunnel is dashboard-managed and untouched.)`)}`
		);
	} else {
		const tk = makeKit(parsed);
		await ensureBinary(tk);
		if (!tk.local.checkAuth().authenticated) {
			throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
		}
		const spin = spinner(`Deleting "${target}" from Cloudflare…`);
		try {
			await tk.local.delete(target);
		} finally {
			spin.stop();
		}
		store.removeLocal(local!.id);
		out(c.accent(`✓ Forgot local "${target}" — removed from Cloudflare and the local store.`));
	}
}

async function cmdInstall(parsed: ParsedArgs): Promise<void> {
	const version = parsed.positionals[0] ?? 'latest';
	const tk = makeKit(parsed);
	const spin = spinner(`Downloading cloudflared ${version}…`);
	try {
		const path = await tk.bin.install(version);
		spin.stop(`${c.accent('✓')} Installed to ${c.dim(path)}`);
	} catch (error) {
		spin.stop();
		throw error;
	}
}

function cmdStatus(parsed: ParsedArgs): void {
	const tk = makeKit(parsed);
	const status = tk.bin.status();
	if (!status.installed) {
		out(`  ${c.dim('binary')}   ${c.yellow('cloudflared: not installed')}`);
		out(c.dim('           run `tunnelkit install` to download it'));
		return;
	}
	out(`  ${c.dim('binary')}   ${c.accent('cloudflared')} ${status.version ?? 'unknown version'}`);
	out(`  ${c.dim('path')}     ${c.dim(status.path ?? '')}`);
}

function cmdDashboard(): void {
	out('\n  Cloudflare Tunnels dashboard:\n');
	out(`    ${c.url(CLOUDFLARE_TUNNELS_DASHBOARD_URL)}\n`);
	out(c.dim("  Opens the signed-in account's Tunnels page (manage remote & named tunnels).\n"));
}

/** Flat top-level commands (no mode namespace). */
export const COMMANDS: Record<string, Handler> = {
	quick: cmdQuick,
	saved: cmdSaved,
	forget: cmdForget,
	install: cmdInstall,
	status: cmdStatus,
	dashboard: cmdDashboard
};

/** Mode namespaces: `tunnelkit <namespace> <verb> …`. */
export const NAMESPACES: Record<string, Record<string, Handler>> = {
	remote: { run: cmdRemote },
	local: { login: cmdLogin, logout: cmdLogout, run: cmdLocal, list: cmdList, delete: cmdDelete }
};
