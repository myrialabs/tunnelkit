/**
 * In-session interactive flows for the tunnelkit CLI.
 *
 * Reached from the live session panel (`n` to add, `f` to forget). Each flow
 * runs against the same `TunnelKit` instance as any tunnel already in the panel.
 */

import { TunnelKit, resolveQuickService, CLOUDFLARE_TUNNELS_DASHBOARD_URL } from './tunnelkit.js';
import {
	c,
	out,
	prompt,
	confirm,
	select,
	spinner,
	runSession,
	clearScreen,
	CancelError,
	type Choice
} from './cli-ui.js';
import { extractTunnelToken } from './tunnel-token.js';
import {
	ensureBinary,
	performLogin,
	startQuick,
	startRemote,
	startLocalNew,
	startLocalSaved,
	validateQuickService,
	validateMinutes
} from './cli-helpers.js';

/**
 * Hand the terminal to the persistent multi-tunnel session panel. From there
 * the user can start more tunnels (`n`), stop the highlighted one (`x`), or
 * quit. The "add" and "forget" flows run against this same `tk`.
 */
export function enterSession(tk: TunnelKit): void {
	runSession(tk, {
		addTunnel: () => addTunnelFlow(tk),
		forgetSaved: () => forgetSavedFlow(tk)
	});
}

/**
 * In-session "add a tunnel" flow — reached from the panel via `n`. Loops so
 * Esc steps back to the mode menu rather than exiting the flow entirely; only
 * `q` in the panel actually quits.
 */
export async function addTunnelFlow(tk: TunnelKit): Promise<void> {
	for (;;) {
		clearScreen();
		const hasSaved = tk.store.getRemotes().length + tk.store.getLocals().length > 0;
		const choices: Choice<string>[] = [
			{ label: 'Quick tunnel', value: 'quick', hint: 'instant, no account' },
			{ label: 'Remote tunnel', value: 'remote', hint: 'token / dashboard' },
			{ label: 'Local tunnel', value: 'local', hint: 'named, needs account' }
		];
		if (hasSaved) choices.push({ label: 'Run a saved tunnel…', value: 'saved' });
		choices.push({ label: 'Back', value: 'back' });

		let mode: string;
		try {
			mode = await select('Start a new tunnel', choices);
		} catch (error) {
			if (error instanceof CancelError) return;
			throw error;
		}
		if (mode === 'back') return;

		try {
			if (mode === 'quick') await addQuick(tk);
			else if (mode === 'remote') await addRemote(tk);
			else if (mode === 'local') await addLocal(tk);
			else if (mode === 'saved') await addSaved(tk);
			return;
		} catch (error) {
			if (error instanceof CancelError) continue;
			out(c.red(`  ${error instanceof Error ? error.message : String(error)}`));
			await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
		}
	}
}

async function addQuick(tk: TunnelKit): Promise<void> {
	const service = await prompt('Local port or URL to expose', { default: '3000', required: true, validate: validateQuickService });
	const autoStop = await prompt('Auto-stop after N minutes (0 = never)', { default: '0', validate: validateMinutes });
	const minutes = Number(autoStop) > 0 ? Number(autoStop) : undefined;
	await startQuick(tk, resolveQuickService(service), minutes);
}

async function addRemote(tk: TunnelKit): Promise<void> {
	const saved = tk.store.getRemotes();
	const useNew = ' new';
	let pick = useNew;
	if (saved.length > 0) {
		pick = await select('Remote token', [
			...saved.map((r) => ({ label: r.name, value: r.id, hint: 'saved token' })),
			{ label: 'Paste a new token…', value: useNew }
		]);
	}
	if (pick !== useNew) {
		const entry = saved.find((r) => r.id === pick);
		if (entry) return await startRemote(tk, { id: entry.id, token: entry.token, name: entry.name });
	}
	out(`\n  Get your tunnel token from the Cloudflare dashboard:\n`);
	out(`    ${c.url(CLOUDFLARE_TUNNELS_DASHBOARD_URL)}\n`);
	const token = extractTunnelToken(await prompt('Tunnel token', { required: true }));
	const name = (await prompt('Name (optional)', { default: '' })).trim();
	const id = name || `remote-${Date.now()}`;
	// Silent: the panel re-renders with the new tunnel on resume.
	await startRemote(tk, { id, token, name: name || undefined, silent: true });
}

async function addLocal(tk: TunnelKit): Promise<void> {
	await ensureBinary(tk);
	if (!tk.local.checkAuth().authenticated) {
		const doLogin = await confirm('Not logged in to Cloudflare. Log in now?', { default: true });
		if (!doLogin) throw new CancelError();
		await performLogin(tk);
	}

	const saved = tk.store.getLocals();
	const name = await prompt('Tunnel name', { required: true, default: saved[0]?.name });
	const previous = saved.find((l) => l.name === name && l.ingress.length > 0);
	if (previous) {
		out(c.dim(`  reusing saved routes for "${name}"`));
		return await startLocalSaved(tk, name, previous);
	}

	// Route-collecting loop: always add the first route, then show a "What next?"
	// menu so the user can add another, undo the last one, finish, or cancel.
	const routes: { hostname: string; service: string }[] = [];
	let adding = true;
	while (adding) {
		if (routes.length > 0) clearScreen();
		const hostname = await prompt('Public hostname (e.g. app.example.com)', { required: true });
		const serviceRaw = await prompt('Local service URL', { default: 'http://localhost:3000', required: true });
		const service = resolveQuickService(serviceRaw);
		routes.push({ hostname, service });
		out(c.green(`✓ added ${hostname} → ${c.url(service)}`));

		const action = await pickRouteAction(routes);
		if (action === 'add') continue;
		if (action === 'remove-last') {
			const removed = routes.pop()!;
			out(c.dim(`  removed ${removed.hostname} → ${c.url(removed.service)}`));
			continue;
		}
		if (action === 'finish') {
			adding = false;
		} else if (action === 'cancel') {
			throw new CancelError();
		}
	}
	await startLocalNew(tk, name, routes, { silent: true });
}

type RouteAction = 'add' | 'remove-last' | 'finish' | 'cancel';

async function pickRouteAction(routes: { hostname: string; service: string }[]): Promise<RouteAction> {
	out('');
	if (routes.length > 0) {
		out(c.dim('  routes so far:'));
		routes.forEach((r, i) => {
			out(`    ${c.dim(`${i + 1}.`)} ${c.bold(r.hostname)} ${c.dim('→')} ${c.url(r.service)}`);
		});
		out('');
	}

	const last = routes[routes.length - 1];
	const choices: Choice<RouteAction>[] = [
		{ label: 'Add another route', value: 'add' },
		...(routes.length > 0
			? [{ label: 'Remove last route', value: 'remove-last' as const, hint: `${last!.hostname} → ${last!.service}` }]
			: []),
		{ label: 'Finish & start tunnel', value: 'finish' },
		{ label: 'Cancel', value: 'cancel' }
	];
	return await select('Routes', choices);
}

async function addSaved(tk: TunnelKit): Promise<void> {
	const remotes = tk.store.getRemotes();
	const locals = tk.store.getLocals();
	const choices: Choice<string>[] = [
		...remotes.map((r) => ({
			label: r.name,
			value: `remote:${r.id}`,
			hint: `remote${tk.remote.isActive(r.id) ? ' · ● running' : ''}`
		})),
		...locals.map((l) => ({
			label: l.name,
			value: `local:${l.id}`,
			hint: `local${tk.local.isActive(l.id) ? ' · ● running' : ''}`
		})),
		{ label: 'Cancel', value: 'cancel' }
	];
	const pick = await select('Run a saved tunnel', choices);
	if (pick === 'cancel') return;

	const sep = pick.indexOf(':');
	const kind = pick.slice(0, sep);
	const id = pick.slice(sep + 1);
	if (kind === 'remote') {
		const entry = remotes.find((r) => r.id === id);
		if (entry) await startRemote(tk, { id: entry.id, token: entry.token, name: entry.name });
	} else {
		const entry = locals.find((l) => l.id === id);
		if (entry) await startLocalSaved(tk, entry.name, entry);
	}
}

export async function forgetSavedFlow(tk: TunnelKit): Promise<void> {
	clearScreen();
	const store = tk.store;

	const remotes = store.getRemotes();
	const locals = store.getLocals();
	const hasAuth = tk.local.checkAuth().authenticated;

	const choices: Choice<string>[] = [
		...remotes.map((r) => ({ label: r.name, value: `remote:${r.id}`, hint: 'remote' })),
		...locals.map((l) => {
			const hosts = l.ingress.map((i) => i.hostname).filter(Boolean).join(', ');
			return { label: l.name, value: `local:${l.id}`, hint: hosts ? `local · ${hosts}` : 'local' };
		}),
		...(hasAuth ? [{ label: 'Log out from Cloudflare', value: 'logout', hint: 'local' }] : []),
		{ label: 'Cancel', value: 'cancel' }
	];

	if (choices.length <= 1) {
		out(c.dim('  Nothing to forget or log out from.'));
		await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
		return;
	}

	let pick: string;
	try {
		pick = await select('Forget a saved tunnel', choices);
	} catch (error) {
		if (error instanceof CancelError) return;
		throw error;
	}
	if (pick === 'cancel') return;

	if (pick === 'logout') {
		let ok = false;
		try {
			ok = await confirm('Log out from Cloudflare? (Removes the stored origin certificate.)', { default: false });
		} catch { return; }
		if (!ok) return;
		const { success } = tk.local.logout();
		out(success ? c.green('✓ Logged out — certificate removed.') : c.yellow('  Nothing to remove.'));
		await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
		return;
	}

	const sep = pick.indexOf(':');
	const kind = pick.slice(0, sep) as 'remote' | 'local';
	const id = pick.slice(sep + 1);
	const entry = kind === 'remote' ? remotes.find((r) => r.id === id) : locals.find((l) => l.id === id);
	if (!entry) return;

	const message =
		kind === 'remote'
			? `Forget remote "${entry.name}"? (Cloudflare tunnel is dashboard-managed and untouched.)`
			: `Forget local "${entry.name}"? This DELETES the tunnel from Cloudflare (irreversible).`;
	let ok = false;
	try {
		ok = await confirm(message, { default: false });
	} catch {
		return;
	}
	if (!ok) return;

	if (kind === 'remote') {
		store.removeRemote(id);
		out(
			c.green(`✓ Forgot remote "${entry.name}".`) +
				`\n${c.dim(`  (Cloudflare tunnel is dashboard-managed and untouched.)`)}`
		);
	} else {
		if (!tk.local.checkAuth().authenticated) {
			out(c.yellow(`  Not authenticated with Cloudflare. Skipping Cloudflare deletion.`));
		} else {
			const spin = spinner(`Deleting "${entry.name}" from Cloudflare…`);
			try {
				await tk.local.delete(entry.name);
			} finally {
				spin.stop();
			}
		}
		store.removeLocal(id);
		out(c.green(`✓ Forgot local "${entry.name}" — removed from Cloudflare and the local store.`));
	}
	await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
}
