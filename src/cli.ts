#!/usr/bin/env node

/**
 * tunnelkit CLI
 *
 * A thin, batteries-included command line over {@link TunnelKit}, so the library
 * can also be used directly from a terminal (`npm i -g tunnelkit` / `bun add -g
 * tunnelkit`). Commands are grouped by the mode they belong to, so it's always
 * clear which mode an operation is for:
 *
 *   tunnelkit                            Interactive menu (when run in a terminal)
 *
 *   tunnelkit quick <port|url>           Quick TryCloudflare tunnel (no account)
 *
 *   tunnelkit remote run [name]          Token-based (dashboard-managed) tunnel
 *
 *   tunnelkit local login | logout       Cloudflare authentication
 *   tunnelkit local run <name> --route … Named tunnel (create → route → run)
 *   tunnelkit local list                 List named tunnels on the account
 *   tunnelkit local delete <name|id>     Delete a named tunnel
 *
 *   tunnelkit saved | forget <name>      Inspect / remove locally-saved tunnels
 *   tunnelkit install [version]          Download the cloudflared binary
 *   tunnelkit status                     Show binary status
 *   tunnelkit version | help
 *
 * Run with no command in a terminal to open an interactive menu that walks
 * through each mode; pass arguments to skip straight to a command. Missing
 * required arguments are prompted for when attached to a TTY, and running
 * tunnels show a live status dashboard (Ctrl+C / `q` to stop).
 *
 * Authentication (`local login`), listing, and deleting all live under `local`
 * because only named tunnels touch your Cloudflare account: quick needs nothing
 * and remote runs from a token.
 *
 * Terminal I/O lives in `cli-ui.ts`; this file is the command/dispatch layer.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { TunnelKit, resolveQuickService, CLOUDFLARE_TUNNELS_DASHBOARD_URL } from './tunnelkit.js';
import { TunnelStore } from './store.js';
import { CloudflaredMissingError } from './cloudflared-tunnel.js';
import type { Logger } from './logger.js';
import { parseCliArgs, firstValue, type ParsedArgs } from './cli-args.js';
import {
	c,
	out,
	errLine,
	spinner,
	prompt,
	confirm,
	select,
	runSession,
	runCancelable,
	clearScreen,
	CancelError,
	type Choice
} from './cli-ui.js';
import { extractTunnelToken } from './tunnel-token.js';

const formatArg = (value: unknown): string => (typeof value === 'string' ? value : inspect(value, { depth: 3 }));

/** A `Logger` that routes the library's diagnostics to stderr (for `--verbose`). */
const verboseLogger: Logger = {
	log: (...args) => errLine(c.dim(`  ${args.map(formatArg).join(' ')}`)),
	warn: (...args) => errLine(c.yellow(`  ${args.map(formatArg).join(' ')}`)),
	error: (...args) => errLine(c.red(`  ${args.map(formatArg).join(' ')}`))
};

// --- Version (read from the shipped package.json) ---

function readVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

// --- Shared helpers ---

function makeKit(parsed: ParsedArgs): TunnelKit {
	return new TunnelKit({
		logger: parsed.flags.has('verbose') ? verboseLogger : undefined,
		dataDir: firstValue(parsed, 'data-dir'),
		installDir: firstValue(parsed, 'install-dir'),
		// TunnelKit auto-saves remote/local tunnels by default; `--no-save` disables it.
		store: !parsed.flags.has('no-save')
	});
}

/**
 * A standalone store for the config-management commands (`saved`, `forget`).
 * Returns `null` under `--no-save`. Run commands read/write through `tk.store`
 * instead, since `TunnelKit` owns persistence.
 */
function makeStore(parsed: ParsedArgs): TunnelStore | null {
	if (parsed.flags.has('no-save')) return null;
	return new TunnelStore({
		dataDir: firstValue(parsed, 'data-dir'),
		logger: parsed.flags.has('verbose') ? verboseLogger : undefined
	});
}

const isInteractive = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

/** Resolve cloudflared, downloading it on demand if nothing is available. */
async function ensureBinary(tk: TunnelKit): Promise<void> {
	if (tk.bin.status().installed) return;
	const spin = spinner('cloudflared not found — downloading…');
	try {
		const path = await tk.bin.install();
		spin.stop(c.dim(`  cloudflared installed → ${path}`));
	} catch (error) {
		spin.stop();
		throw error;
	}
}

/**
 * Hand the terminal to the persistent multi-tunnel session panel. From there the
 * user can start more tunnels (`n`), stop the highlighted one (`x`), or quit. The
 * "add a tunnel" flow runs against this same `tk`, so every tunnel is managed
 * together. Without a TTY this prints a static summary and idles on signals.
 */
function enterSession(tk: TunnelKit): void {
	runSession(tk, {
		addTunnel: () => addTunnelFlow(tk),
		forgetSaved: () => forgetSavedFlow(tk)
	});
}

// --- Start helpers (shared by one-shot commands and the in-session add flow) ---

async function startQuick(tk: TunnelKit, service: string, autoStopMinutes: number | undefined): Promise<void> {
	await ensureBinary(tk);
	const started = await runCancelable(`Starting quick tunnel for ${service}…`, (signal) =>
		tk.quick.start({ service, autoStopMinutes, signal })
	);
	out(`${c.green('✓')} ${c.accent('quick')} ${c.dim('·')} ${c.url(started.publicUrl)}`);
}

async function startRemote(tk: TunnelKit, opts: { id: string; token: string; name?: string; silent?: boolean }): Promise<void> {
	await ensureBinary(tk);
	await runCancelable('Starting remote tunnel…', (signal) => tk.remote.start({ ...opts, signal })); // TunnelKit persists it
	// `silent: true` is set by the in-session add flow — the panel renders the
	// new tunnel on resume, and the `✓ remote · name` line would otherwise flash
	// for a frame before the panel clears the screen.
	if (!opts.silent) out(`${c.green('✓')} ${c.accent('remote')} ${c.dim('·')} ${c.bold(opts.name ?? opts.id)}`);
}

function requireLocalAuth(tk: TunnelKit): void {
	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}
}

async function startLocalNew(
	tk: TunnelKit,
	name: string,
	routes: { hostname: string; service: string }[],
	opts: { silent?: boolean } = {}
): Promise<void> {
	await ensureBinary(tk);
	requireLocalAuth(tk);

	const createSpin = spinner(`Creating tunnel "${name}"…`);
	let created;
	try {
		created = await tk.local.create(name);
	} catch (error) {
		createSpin.stop();
		throw error;
	}
	createSpin.stop(c.dim(`  tunnel id ${created.tunnelId}`));

	for (const route of routes) {
		const dnsSpin = spinner(`Routing ${route.hostname}…`);
		try {
			await tk.local.routeDns(name, route.hostname);
		} catch (error) {
			dnsSpin.stop();
			throw error;
		}
		dnsSpin.stop(c.dim(`  ${route.hostname} routed`));
	}

	await runCancelable('Starting local tunnel…', (signal) =>
		tk.local.start({ id: name, name, tunnelId: created.tunnelId, credentialsFile: created.credentialsFile, ingress: routes }, undefined, { signal })
	); // TunnelKit persists it
	if (!opts.silent) out(`${c.green('✓')} ${c.accent('local')} ${c.dim('·')} ${c.bold(name)}`);
}

async function startLocalSaved(
	tk: TunnelKit,
	name: string,
	previous: { tunnelId: string; credentialsFile: string; ingress: { hostname?: string; service: string }[] }
): Promise<void> {
	await ensureBinary(tk);
	requireLocalAuth(tk);
	await runCancelable(`Starting saved tunnel "${name}"…`, (signal) =>
		tk.local.start({ id: name, name, tunnelId: previous.tunnelId, credentialsFile: previous.credentialsFile, ingress: previous.ingress }, undefined, { signal })
	);
	out(`${c.green('✓')} ${c.accent('local')} ${c.dim('·')} ${c.bold(name)}`);
}

/** Run `cloudflared tunnel login`, surfacing the auth URL; cleans up its signal handler. */
async function performLogin(tk: TunnelKit): Promise<void> {
	const onSig = (): void => {
		tk.local.cancelLogin();
		process.exit(1);
	};
	process.once('SIGINT', onSig);
	try {
		await new Promise<void>((resolve, reject) => {
			tk.local.login({
				onUrl: (url) => {
					out('\n  Authorize this device in your browser:\n');
					out(`    ${c.url(url)}\n`);
					out(c.dim('  Waiting for approval…'));
				},
				onComplete: () => resolve(),
				onError: (message) => reject(new Error(message))
			});
		});
		out(c.green('\n✓ Logged in. Origin certificate saved.'));
	} finally {
		process.removeListener('SIGINT', onSig);
	}
}

// --- Input validation (shared by flags + prompts) ---

function validateQuickService(value: string): string | undefined {
	try {
		resolveQuickService(value);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function validateMinutes(value: string): string | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? undefined : 'Enter a non-negative number of minutes (0 disables it).';
}

/** Split a `hostname=service` route token; throws on a malformed entry. */
function parseRoute(token: string): { hostname: string; service: string } {
	const eq = token.indexOf('=');
	if (eq <= 0 || eq === token.length - 1) {
		throw new Error(`Invalid --route "${token}". Expected "hostname=service", e.g. app.example.com=http://localhost:3000`);
	}
	return { hostname: token.slice(0, eq).trim(), service: token.slice(eq + 1).trim() };
}

function gatherRoutes(parsed: ParsedArgs): { hostname: string; service: string }[] {
	const routes = (parsed.values.route ?? []).map(parseRoute);
	const hostname = firstValue(parsed, 'hostname');
	const service = firstValue(parsed, 'service');
	if (hostname && service) routes.push({ hostname, service });
	return routes;
}

// --- Commands ---

function parseAutoStop(parsed: ParsedArgs): number | undefined {
	const autoStopStr = firstValue(parsed, 'auto-stop');
	if (autoStopStr === undefined) return undefined;
	const minutes = Number(autoStopStr);
	if (!Number.isFinite(minutes) || minutes < 0) {
		throw new Error('--auto-stop must be a non-negative number of minutes (0 disables it)');
	}
	return minutes;
}

async function cmdQuick(parsed: ParsedArgs): Promise<void> {
	let service = parsed.positionals[0];
	if (!service) {
		if (!isInteractive()) {
			throw new Error('quick requires a port or URL, e.g. `tunnelkit quick 3000` or `tunnelkit quick http://localhost:3000`');
		}
		service = await prompt('Local port or URL to expose', { default: '3000', required: true, validate: validateQuickService });
	}
	const resolved = resolveQuickService(service); // validate up front, before any binary download
	const autoStopMinutes = parseAutoStop(parsed);

	const tk = makeKit(parsed);
	await startQuick(tk, resolved, autoStopMinutes);
	if (autoStopMinutes && autoStopMinutes > 0) out(c.dim(`  auto-stops in ${autoStopMinutes} min`));
	enterSession(tk);
}

async function cmdRemote(parsed: ParsedArgs): Promise<void> {
	const name = parsed.positionals[0];
	const tk = makeKit(parsed);
	const store = tk.store; // null under --no-save

	// Token precedence: --token / CF_TUNNEL_TOKEN, else a saved entry by name.
	let explicitToken = firstValue(parsed, 'token') ?? process.env.CF_TUNNEL_TOKEN;
	const saved = !explicitToken && name && store
		? store.getRemotes().find((r) => r.name === name || r.id === name)
		: undefined;

	// No token and no saved match: prompt for one when interactive. The token
	// is shown unmasked (no `secret: true`) so the user can confirm they pasted
	// the right thing; `extractTunnelToken` strips the surrounding
	// `cloudflared service install …` / `--token …` if they paste the command.
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
	// Key the saved entry by a stable, meaningful id so distinct names don't collide.
	const id = firstValue(parsed, 'id') ?? saved?.id ?? explicitName ?? 'cli-remote';

	await startRemote(tk, { id, token, name: tunnelName });

	// A freshly-supplied token under a usable name can be reused next time.
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

	// No routes given: re-run a previously saved tunnel of the same name.
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
		out(c.green('✓ Already authenticated with Cloudflare.'));
		return;
	}
	await performLogin(tk);
}

function cmdLogout(parsed: ParsedArgs): void {
	const tk = makeKit(parsed);
	const { success } = tk.local.logout();
	out(success ? c.green('✓ Logged out (certificate removed).') : c.yellow('Nothing to remove.'));
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

	// Confirm destructive deletes in a terminal; `--yes` and non-TTY skip the prompt.
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
	spin.stop(c.green(`✓ Deleted ${target}.`));

	// Keep the saved store consistent: drop any local entry for this tunnel.
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

	// Local tunnels also remove the Cloudflare-side record (irreversible);
	// remote tokens are dashboard-managed, so forgetting one just drops the
	// local copy of the token.
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
			c.green(`✓ Forgot remote "${target}".`) +
				`\n${c.dim(`  (Cloudflare tunnel is dashboard-managed and untouched.)`)}`
		);
	} else {
		// Local tunnel: delete from Cloudflare first, then drop the local entry.
		// If the Cloudflare call fails, the local entry is preserved so the
		// user can retry without losing the saved config.
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
		out(c.green(`✓ Forgot local "${target}" — removed from Cloudflare and the local store.`));
	}
}

async function cmdInstall(parsed: ParsedArgs): Promise<void> {
	const version = parsed.positionals[0] ?? 'latest';
	const tk = makeKit(parsed);
	const spin = spinner(`Downloading cloudflared ${version}…`);
	try {
		const path = await tk.bin.install(version);
		spin.stop(`${c.green('✓')} Installed to ${c.dim(path)}`);
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
	out(`  ${c.dim('binary')}   ${c.green('cloudflared')} ${status.version ?? 'unknown version'}`);
	out(`  ${c.dim('path')}     ${c.dim(status.path ?? '')}`);
}

/** Print a shortcut link to the Cloudflare dashboard's Tunnels page. */
function cmdDashboard(): void {
	out('\n  Cloudflare Tunnels dashboard:\n');
	out(`    ${c.url(CLOUDFLARE_TUNNELS_DASHBOARD_URL)}\n`);
	out(c.dim('  Opens the signed-in account’s Tunnels page (manage remote & named tunnels).\n'));
}

// --- In-session "add a tunnel" flow ---
//
// Reached from the session panel via `n`. The panel is suspended (cooked mode)
// while these prompt, then resumes. Each starts a tunnel on the SAME `tk`, so it
// joins the others in the panel rather than replacing them.

async function addTunnelFlow(tk: TunnelKit): Promise<void> {
	// Loop so Esc is "step back", not "exit": cancelling a sub-step (port, token,
	// routes…) returns here to the mode menu; cancelling the menu returns to the
	// panel. Only `q` in the panel actually quits.
	for (;;) {
		// Start each pass on a clean screen; within a pass the prompts/menus keep
		// their `✓` summaries so the form doesn't wipe itself on every submit.
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
			if (error instanceof CancelError) return; // Esc at the menu → back to the panel
			throw error;
		}
		if (mode === 'back') return;

		try {
			if (mode === 'quick') await addQuick(tk);
			else if (mode === 'remote') await addRemote(tk);
			else if (mode === 'local') await addLocal(tk);
			else if (mode === 'saved') await addSaved(tk);
			return; // a tunnel started → back to the panel showing it
		} catch (error) {
			// Esc inside a step backs up to this menu rather than leaving the flow.
			if (error instanceof CancelError) continue;
			// Surface the failure and let the user read it, then back to the menu.
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
	// Show the dashboard link so the user knows where to find the token.
	out(`\n  Get your tunnel token from the Cloudflare dashboard:\n`);
	out(`    ${c.url(CLOUDFLARE_TUNNELS_DASHBOARD_URL)}\n`);
	// Show the token unmasked so the user can verify a correct paste; the
	// extractor handles pasted `cloudflared service install …` / `--token …`
	// commands as well as a bare JWT.
	const token = extractTunnelToken(await prompt('Tunnel token', { required: true }));
	const name = (await prompt('Name (optional)', { default: '' })).trim();
	// Distinct id per unnamed tunnel so a second one doesn't collide with the first.
	const id = name || `remote-${Date.now()}`;
	// Silent because the session panel re-renders with the new tunnel on resume
	// — the `✓ remote · name` line would otherwise flash for a frame first.
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
	// menu so the user can add another, undo the last one, finish, or cancel. The
	// summary above the menu lists every route entered so far — without it the
	// user has to remember what they typed, and "Add another?" can pile up opaque
	// `✓` lines with no way to inspect them.
	const routes: { hostname: string; service: string }[] = [];
	let adding = true;
	while (adding) {
		// Clear on 2nd+ routes so each iteration starts fresh without stacking.
		if (routes.length > 0) clearScreen();
		const hostname = await prompt('Public hostname (e.g. app.example.com)', { required: true });
		// Normalize bare port numbers (e.g. "4009" → "http://localhost:4009") so
		// cloudflared receives a valid service URL in the generated config.
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

/**
 * Show the current route list and the "What next?" menu. Pure choices/formatting
 * live here so the loop in {@link addLocal} reads as a clear state machine.
 */
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

async function forgetSavedFlow(tk: TunnelKit): Promise<void> {
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

	// Local tunnels also remove the Cloudflare-side record (irreversible);
	// remote tokens are dashboard-managed, so forgetting one just drops the
	// local copy of the token.
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
		// Local tunnel: delete from Cloudflare first (irreversible), then drop
		// the local entry. If the Cloudflare call fails, abort before touching
		// the store so the user can retry without losing the saved config.
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

/** Bare `tunnelkit` in a terminal: open the session panel with nothing running yet. */
function interactiveHome(base: ParsedArgs): void {
	// No banner here: the panel runs on the alternate screen and renders its own
	// header, so anything printed beforehand would only flash on the normal screen.
	enterSession(makeKit(base));
}

function showHelp(version: string): void {
	out(`
${c.accent('tunnelkit')} ${c.dim(`v${version}`)} — Cloudflare Tunnels from your terminal

${c.bold('USAGE')}
  tunnelkit                    Open the interactive menu (in a terminal)
  tunnelkit <command> [options]

${c.bold('QUICK')} ${c.dim('— instant tunnel, no account')}
  quick <port|url>             Start a quick TryCloudflare tunnel (port → localhost:<port>)

${c.bold('REMOTE')} ${c.dim('— token / dashboard-managed')}
  remote run [name]            Run a token-based tunnel (--token, CF_TUNNEL_TOKEN, or a saved name)

${c.bold('LOCAL')} ${c.dim('— named tunnel (needs a Cloudflare account)')}
  local login                  Authenticate with Cloudflare
  local logout                 Remove the stored origin certificate
  local run <name>             Create + route + run a named tunnel
  local list                   List named tunnels on the account
  local delete <name|id>       Delete a named tunnel (from Cloudflare)

${c.bold('GENERAL')}
  saved                        List tunnels saved locally for reuse (remote + local)
  forget <name>                Remove a saved tunnel (local tunnels also delete from Cloudflare)
  dashboard                    Print a shortcut link to the Cloudflare Tunnels dashboard
  install [version]            Download the cloudflared binary (default: latest)
  status                       Show the cloudflared binary status
  version                      Print the tunnelkit version
  help                         Show this help

${c.bold('OPTIONS')}
  --auto-stop <minutes>        quick: minutes until auto-stop (default 0 — never)
  --token <token>              remote run: tunnel token (or set CF_TUNNEL_TOKEN)
  --name <name>                remote run: name used to save & reuse the token
  --id <id>                    remote run: stable id for the tunnel (default cli-remote)
  --route <hostname=service>   local run: ingress rule (repeatable)
  --hostname <host>            local run: single ingress hostname (pair with --service)
  --service <url>              local run: single ingress service URL
  --yes, -y                    skip confirmation prompts (e.g. local delete)
  --no-save                    don't read or write the saved-config store for this run
  --data-dir <dir>             override the data dir (default ~/.tunnelkit)
  --install-dir <dir>          override the binary dir (default ~/.tunnelkit/bin)
  --verbose                    print library diagnostics to stderr
  -h, --help                   show help
  -v, --version                show version

${c.bold('INTERACTIVE')}
  Run ${c.accent('tunnelkit')} with no command in a terminal for a live control panel.
  Run many tunnels at once and manage them together:
    ${c.bold('n')} new tunnel · ${c.bold('↑/↓')} select · ${c.bold('x')} stop selected · ${c.bold('c')} copy URL · ${c.bold('f')} forget saved · ${c.bold('q')} quit
  Starting a tunnel by command (e.g. ${c.accent('tunnelkit quick 3000')}) drops into the
  same panel, so you can add more from there.

${c.bold('EXAMPLES')}
  tunnelkit                                  # interactive control panel
  tunnelkit quick 3000
  tunnelkit quick http://localhost:8080 --auto-stop 30
  tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --name prod
  tunnelkit remote run prod                  # reuse the saved "prod" token
  tunnelkit local login
  tunnelkit local run my-app --route app.example.com=http://localhost:3000
  tunnelkit local run my-app                 # rerun the saved "my-app" tunnel
  tunnelkit install 2024.12.2

Docs: https://github.com/myrialabs/tunnelkit
`);
}

// --- Entry ---

type Handler = (parsed: ParsedArgs) => void | Promise<void>;

/** Flat top-level commands (no mode namespace). */
const COMMANDS: Record<string, Handler> = {
	quick: cmdQuick,
	saved: cmdSaved,
	forget: cmdForget,
	install: cmdInstall,
	status: cmdStatus,
	dashboard: cmdDashboard
};

/** Mode namespaces: `tunnelkit <namespace> <verb> …`. */
const NAMESPACES: Record<string, Record<string, Handler>> = {
	remote: { run: cmdRemote },
	local: { login: cmdLogin, logout: cmdLogout, run: cmdLocal, list: cmdList, delete: cmdDelete }
};

function parseRest(argv: string[]): ParsedArgs {
	return parseCliArgs(argv, {
		booleans: ['verbose', 'help', 'force', 'no-save', 'yes'],
		aliases: { h: 'help', v: 'version', y: 'yes' }
	});
}

function unknown(message: string): never {
	errLine(c.red(message));
	errLine(c.dim('Run `tunnelkit help` for usage.'));
	process.exit(1);
}

async function main(): Promise<void> {
	const version = readVersion();
	const argv = process.argv.slice(2);
	const command = argv[0];

	if (command === 'help' || command === '-h' || command === '--help') {
		showHelp(version);
		return;
	}
	if (command === 'version' || command === '-v' || command === '--version') {
		out(`v${version}`);
		return;
	}

	// No command (or only global flags): open the session panel in a terminal, else help.
	if (!command || command.startsWith('-')) {
		if (isInteractive()) {
			interactiveHome(parseRest(argv));
			return;
		}
		showHelp(version);
		return;
	}

	// Mode namespace: dispatch on the sub-verb (e.g. `local run`, `remote run`).
	const namespace = NAMESPACES[command];
	if (namespace) {
		const verb = argv[1];
		const verbs = Object.keys(namespace).join(', ');
		if (!verb) unknown(`\`tunnelkit ${command}\` needs a subcommand: ${verbs}. e.g. \`tunnelkit ${command} run\`.`);
		const nested = namespace[verb];
		if (!nested) unknown(`Unknown ${command} subcommand: ${verb}. Expected one of: ${verbs}.`);
		await nested(parseRest(argv.slice(2)));
		return;
	}

	const handler = COMMANDS[command];
	if (!handler) unknown(`Unknown command: ${command}`);
	await handler(parseRest(argv.slice(1)));
}

main().catch((error) => {
	if (error instanceof CancelError) {
		process.exit(130);
	}
	if (error instanceof CloudflaredMissingError) {
		errLine(c.red('cloudflared is not available.'));
		errLine(c.dim('Run `tunnelkit install` to download it, or install it system-wide.'));
	} else {
		errLine(c.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
	}
	process.exit(1);
});
