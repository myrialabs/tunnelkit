/**
 * In-session interactive flows for the tunnelkit CLI.
 *
 * Reached from the live session panel (`n` to add, `m` to manage). Each flow
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
 * the user can start more tunnels (`n`), manage saved ones (`m`), or quit.
 * The "add" and "manage" flows run against this same `tk`.
 */
export function enterSession(tk: TunnelKit): void {
	runSession(tk, {
		addTunnel: () => addTunnelFlow(tk),
		manageSaved: () => manageSavedFlow(tk)
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

	const routes = await editRoutesFlow([], `Routes for "${name}"`, {
		doneLabel: 'Start tunnel',
		requireRoute: true
	});
	if (!routes) throw new CancelError();

	await startLocalNew(tk, name, routes, { silent: true });
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

/**
 * Interactive route list editor. Returns the updated list or `null` on cancel.
 * Each existing route is a selectable item — selecting one opens a remove/back
 * submenu. `requireRoute` hides the "done" option until at least one route exists.
 */
async function editRoutesFlow(
	initial: { hostname: string; service: string }[],
	title: string,
	opts: { doneLabel?: string; requireRoute?: boolean } = {}
): Promise<{ hostname: string; service: string }[] | null> {
	let routes = [...initial];
	const doneLabel = opts.doneLabel ?? 'Save & done';

	for (;;) {
		clearScreen();

		const routeChoices: Choice<string>[] = routes.map((r, i) => ({
			label: r.hostname,
			value: `r:${i}`,
			hint: r.service
		}));
		const actionChoices: Choice<string>[] = [
			{ label: '+ Add a route', value: 'add' }
		];
		if (!opts.requireRoute || routes.length > 0) {
			actionChoices.push({ label: doneLabel, value: 'done' });
		}
		actionChoices.push({ label: 'Cancel', value: 'cancel' });

		let pick: string;
		try {
			pick = await select(title, [...routeChoices, ...actionChoices]);
		} catch (e) {
			if (e instanceof CancelError) return null;
			throw e;
		}

		if (pick === 'cancel') return null;
		if (pick === 'done') return routes;

		if (pick === 'add') {
			let hostname: string;
			let service: string;
			try {
				hostname = await prompt('Public hostname (e.g. app.example.com)', { required: true });
				service = resolveQuickService(
					await prompt('Local service URL', { default: 'http://localhost:3000', required: true })
				);
			} catch (e) {
				if (e instanceof CancelError) continue;
				throw e;
			}
			routes = [...routes, { hostname, service }];
			continue;
		}

		// Selected an existing route — offer remove or back
		const idx = parseInt(pick.slice(2));
		const route = routes[idx];
		try {
			const action = await select(`Route: ${route.hostname}`, [
				{ label: 'Remove this route', value: 'remove', hint: route.service },
				{ label: 'Back', value: 'back' }
			]);
			if (action === 'remove') {
				routes = routes.filter((_, i) => i !== idx);
			}
		} catch {
			// Esc → back to route list
		}
	}
}

/**
 * In-session "manage saved tunnels" flow — reached from the panel via `m`.
 * Shows all saved tunnels; selecting one opens a submenu to edit or forget it.
 * Also handles Cloudflare logout.
 */
export async function manageSavedFlow(tk: TunnelKit): Promise<void> {
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
		...(hasAuth ? [{ label: 'Log out from Cloudflare', value: 'logout' }] : []),
		{ label: 'Back', value: 'back' }
	];

	if (choices.length <= 1) {
		out(c.dim('  No saved tunnels.'));
		await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
		return;
	}

	let pick: string;
	try {
		pick = await select('Manage saved', choices);
	} catch (error) {
		if (error instanceof CancelError) return;
		throw error;
	}
	if (pick === 'back') return;

	if (pick === 'logout') {
		let ok = false;
		try {
			ok = await confirm('Log out from Cloudflare? (Removes the stored origin certificate.)', { default: false });
		} catch { return; }
		if (!ok) return;
		const { success } = tk.local.logout();
		out(success ? c.accent('✓ Logged out — certificate removed.') : c.yellow('  Nothing to remove.'));
		await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
		return;
	}

	const sep = pick.indexOf(':');
	const kind = pick.slice(0, sep) as 'remote' | 'local';
	const id = pick.slice(sep + 1);

	if (kind === 'remote') {
		const entry = remotes.find((r) => r.id === id);
		if (!entry) return;

		let action: string;
		try {
			action = await select(entry.name, [
				{ label: 'Edit token', value: 'edit' },
				{ label: 'Forget', value: 'forget', hint: 'removes from local store only' },
				{ label: 'Back', value: 'back' }
			]);
		} catch { return; }
		if (action === 'back') return;

		if (action === 'edit') {
			out(`\n  Get your tunnel token from the Cloudflare dashboard:\n`);
			out(`    ${c.url(CLOUDFLARE_TUNNELS_DASHBOARD_URL)}\n`);
			let token: string;
			try {
				token = extractTunnelToken(await prompt('New token', { required: true, secret: true }));
			} catch { return; }
			const nameRaw = await prompt('Name', { default: entry.name }).catch(() => entry.name);
			const name = nameRaw.trim() || entry.name;
			store.upsertRemote(entry.id, name, token);
			out(c.accent(`✓ Updated "${name}".`));
		} else if (action === 'forget') {
			let ok = false;
			try {
				ok = await confirm(
					`Forget remote "${entry.name}"? (Cloudflare tunnel is dashboard-managed and untouched.)`,
					{ default: false }
				);
			} catch { return; }
			if (!ok) return;
			store.removeRemote(id);
			out(
				c.accent(`✓ Forgot "${entry.name}".`) +
					`\n${c.dim('  (Cloudflare tunnel is dashboard-managed and untouched.)')}`
			);
		}
	} else {
		const entry = locals.find((l) => l.id === id);
		if (!entry) return;

		let action: string;
		try {
			action = await select(entry.name, [
				{ label: 'Edit routes', value: 'edit' },
				{ label: 'Forget', value: 'forget', hint: 'deletes from Cloudflare' },
				{ label: 'Back', value: 'back' }
			]);
		} catch { return; }
		if (action === 'back') return;

		if (action === 'edit') {
			const initial = entry.ingress
				.filter((r): r is { hostname: string; service: string } => !!r.hostname)
				.map((r) => ({ hostname: r.hostname, service: r.service }));
			const routes = await editRoutesFlow(initial, `Routes for "${entry.name}"`);
			if (routes === null) return;
			store.upsertLocal({ ...entry, ingress: routes });
			out(c.accent(`✓ Updated routes for "${entry.name}".`));
		} else if (action === 'forget') {
			let ok = false;
			try {
				ok = await confirm(
					`Forget local "${entry.name}"? This DELETES the tunnel from Cloudflare (irreversible).`,
					{ default: false }
				);
			} catch { return; }
			if (!ok) return;

			if (!hasAuth) {
				out(c.yellow('  Not authenticated with Cloudflare. Skipping Cloudflare deletion.'));
			} else {
				const spin = spinner(`Deleting "${entry.name}" from Cloudflare…`);
				try {
					await tk.local.delete(entry.name);
				} finally {
					spin.stop();
				}
			}
			store.removeLocal(id);
			out(c.accent(`✓ Forgot "${entry.name}" — removed from Cloudflare and the local store.`));
		}
	}

	await prompt('Press Enter to return', { default: '' }).catch(() => undefined);
}
