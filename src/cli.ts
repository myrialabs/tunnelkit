#!/usr/bin/env node

/**
 * tunnelkit CLI
 *
 * A thin, batteries-included command line over {@link TunnelKit}, so the library
 * can also be used directly from a terminal (`npm i -g tunnelkit` / `bun add -g
 * tunnelkit`). Commands are grouped by the mode they belong to, so it's always
 * clear which mode an operation is for:
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
 * Authentication (`local login`), listing, and deleting all live under `local`
 * because only named tunnels touch your Cloudflare account: quick needs nothing
 * and remote runs from a token.
 *
 * This is the one place in the package that talks to the terminal directly —
 * the library core stays silent and logs only through the optional `Logger`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { TunnelKit, resolveQuickService } from './manager.js';
import { TunnelStore } from './store.js';
import { CloudflaredMissingError } from './tunnel.js';
import type { Logger } from './logger.js';
import { parseCliArgs, firstValue, type ParsedArgs } from './cli-args.js';

// --- Output helpers (color-aware, TTY-aware) ---

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
	cyan: paint('36'),
	green: paint('32'),
	red: paint('31'),
	yellow: paint('33'),
	dim: paint('2'),
	bold: paint('1')
};

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const errLine = (line = ''): void => void process.stderr.write(`${line}\n`);

const formatArg = (value: unknown): string => (typeof value === 'string' ? value : inspect(value, { depth: 3 }));

/** A `Logger` that routes the library's diagnostics to stderr (for `--verbose`). */
const verboseLogger: Logger = {
	log: (...args) => errLine(c.dim(`  ${args.map(formatArg).join(' ')}`)),
	warn: (...args) => errLine(c.yellow(`  ${args.map(formatArg).join(' ')}`)),
	error: (...args) => errLine(c.red(`  ${args.map(formatArg).join(' ')}`))
};

// --- A minimal single-line spinner (no-op when not attached to a TTY) ---

function spinner(message: string): { stop: (final?: string) => void } {
	if (!process.stdout.isTTY) {
		out(message);
		return { stop: (final) => final && out(final) };
	}
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	let i = 0;
	const timer = setInterval(() => {
		process.stdout.write(`\r\x1b[K${frames[i]} ${message}`);
		i = (i + 1) % frames.length;
	}, 80);
	return {
		stop: (final) => {
			clearInterval(timer);
			process.stdout.write('\r\x1b[K');
			if (final) out(final);
		}
	};
}

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

/** Resolve cloudflared, downloading it on demand if nothing is available. */
async function ensureBinary(tk: TunnelKit): Promise<void> {
	if (tk.getBinaryStatus().installed) return;
	const spin = spinner('cloudflared not found — downloading…');
	try {
		const path = await tk.installBinary();
		spin.stop(c.dim(`  cloudflared installed → ${path}`));
	} catch (error) {
		spin.stop();
		throw error;
	}
}

/** Keep a foreground tunnel running until the user interrupts it. */
function runUntilInterrupted(tk: TunnelKit): void {
	out(c.dim('\nPress Ctrl+C to stop.'));
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		out(c.dim('\nStopping…'));
		await tk.stopAll();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
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

async function cmdQuick(parsed: ParsedArgs): Promise<void> {
	const service = parsed.positionals[0];
	if (!service) {
		throw new Error('quick requires a port or URL, e.g. `tunnelkit quick 3000` or `tunnelkit quick http://localhost:3000`');
	}
	resolveQuickService(service); // validate up front, before any binary download

	const autoStopStr = firstValue(parsed, 'auto-stop');
	const autoStopMinutes = autoStopStr !== undefined ? Number(autoStopStr) : undefined;
	if (autoStopStr !== undefined && (!Number.isFinite(autoStopMinutes) || (autoStopMinutes as number) < 0)) {
		throw new Error('--auto-stop must be a non-negative number of minutes (0 disables it)');
	}

	const tk = makeKit(parsed);
	await ensureBinary(tk);

	const spin = spinner(`Starting quick tunnel for ${service}…`);
	let started;
	try {
		started = await tk.quick.start({ service, autoStopMinutes });
	} catch (error) {
		spin.stop();
		throw error;
	}
	spin.stop();

	out(`\n  ${c.green('●')} ${c.bold(started.publicUrl)}`);
	out(c.dim(`    → proxying ${started.service}`));
	if (autoStopMinutes && autoStopMinutes > 0) out(c.dim(`    auto-stops in ${autoStopMinutes} min`));
	runUntilInterrupted(tk);
}

async function cmdRemote(parsed: ParsedArgs): Promise<void> {
	const name = parsed.positionals[0];
	const tk = makeKit(parsed);
	const store = tk.store; // null under --no-save

	// Token precedence: --token / CF_TUNNEL_TOKEN, else a saved entry by name.
	const explicitToken = firstValue(parsed, 'token') ?? process.env.CF_TUNNEL_TOKEN;
	const saved = !explicitToken && name && store
		? store.getRemotes().find((r) => r.label === name || r.id === name)
		: undefined;
	const token = explicitToken ?? saved?.token;
	if (!token) {
		throw new Error(
			name
				? `No saved tunnel named "${name}". Provide a token with --token <token> (or set CF_TUNNEL_TOKEN).`
				: 'remote requires a token via --token <token> or the CF_TUNNEL_TOKEN env var (or a saved name).'
		);
	}

	const explicitName = firstValue(parsed, 'label') ?? name;
	const label = firstValue(parsed, 'label') ?? saved?.label ?? name;
	// Key the saved entry by a stable, meaningful id so distinct labels don't collide.
	const id = firstValue(parsed, 'id') ?? saved?.id ?? explicitName ?? 'cli-remote';

	tk.on('ingress-update', ({ ingress }) => {
		for (const rule of ingress) {
			if (rule.hostname) out(c.dim(`    ${rule.hostname} → ${rule.service}`));
		}
	});
	await ensureBinary(tk);

	const spin = spinner('Starting remote tunnel…');
	const { ingress } = await tk.remote.start({ id, token, label }); // TunnelKit persists it
	spin.stop();

	// A freshly-supplied token under a usable name can be reused next time.
	if (store && explicitToken && explicitName) {
		out(c.dim(`  saved as "${explicitName}" — reuse with \`tunnelkit remote run ${explicitName}\``));
	}
	out(`\n  ${c.green('●')} ${c.bold(label ?? id)} ${c.dim('connected')}`);
	for (const rule of ingress) {
		if (rule.hostname) out(c.dim(`    ${rule.hostname} → ${rule.service}`));
	}
	if (ingress.length === 0) out(c.dim('    ingress will appear here once Cloudflare pushes the config'));
	runUntilInterrupted(tk);
}

async function cmdLocal(parsed: ParsedArgs): Promise<void> {
	const name = parsed.positionals[0];
	if (!name) throw new Error('local run requires a tunnel name, e.g. `tunnelkit local run my-app --route app.example.com=http://localhost:3000`');

	const routes = gatherRoutes(parsed);

	const tk = makeKit(parsed);
	const store = tk.store; // null under --no-save
	await ensureBinary(tk);

	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}

	// No routes given: re-run a previously saved tunnel of the same name.
	if (routes.length === 0) {
		const previous = store?.getLocals().find((l) => l.name === name);
		if (!previous || previous.ingress.length === 0) {
			throw new Error('local run requires at least one --route hostname=service (or --hostname/--service), or a previously saved tunnel of the same name');
		}
		const startSpin = spinner(`Starting saved tunnel "${name}"…`);
		await tk.local.start({ id: name, name, tunnelId: previous.tunnelId, credentialsFile: previous.credentialsFile, ingress: previous.ingress });
		startSpin.stop();

		out(`\n  ${c.green('●')} ${c.bold(name)} ${c.dim('connected')}`);
		for (const route of previous.ingress) out(c.dim(`    https://${route.hostname} → ${route.service}`));
		runUntilInterrupted(tk);
		return;
	}

	const createSpin = spinner(`Creating tunnel "${name}"…`);
	const { tunnelId, credentialsFile } = await tk.local.create(name);
	createSpin.stop(c.dim(`  tunnel id ${tunnelId}`));

	for (const route of routes) {
		const dnsSpin = spinner(`Routing ${route.hostname}…`);
		await tk.local.routeDns(name, route.hostname);
		dnsSpin.stop(c.dim(`  ${route.hostname} routed`));
	}

	const startSpin = spinner('Starting local tunnel…');
	await tk.local.start({ id: name, name, tunnelId, credentialsFile, ingress: routes }); // TunnelKit persists it
	startSpin.stop();

	out(`\n  ${c.green('●')} ${c.bold(name)} ${c.dim('connected')}`);
	for (const route of routes) out(c.dim(`    https://${route.hostname} → ${route.service}`));
	if (store) out(c.dim(`    saved — rerun with \`tunnelkit local run ${name}\``));
	runUntilInterrupted(tk);
}

async function cmdLogin(parsed: ParsedArgs): Promise<void> {
	const tk = makeKit(parsed);
	await ensureBinary(tk);

	if (tk.local.checkAuth().authenticated) {
		out(c.green('✓ Already authenticated with Cloudflare.'));
		return;
	}

	process.on('SIGINT', () => {
		tk.local.cancelLogin();
		process.exit(1);
	});

	await new Promise<void>((resolve, reject) => {
		tk.local.login({
			onUrl: (url) => {
				out('\n  Authorize this device in your browser:\n');
				out(`    ${c.cyan(url)}\n`);
				out(c.dim('  Waiting for approval…'));
			},
			onComplete: () => {
				out(c.green('\n✓ Logged in. Origin certificate saved.'));
				resolve();
			},
			onError: (message) => reject(new Error(message))
		});
	});
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

	const tk = makeKit(parsed);
	await ensureBinary(tk);
	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}

	const spin = spinner(`Deleting "${target}"…`);
	await tk.local.delete(target);
	spin.stop(c.green(`✓ Deleted ${target}.`));

	// Keep the saved store consistent: drop any local entry for this tunnel.
	const store = tk.store;
	const saved = store?.getLocals().find((l) => l.name === target || l.id === target);
	if (store && saved) store.removeLocal(saved.id);
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

	if (remotes.length > 0) {
		out(c.bold('REMOTE'));
		for (const r of remotes) out(`  ${r.label}  ${c.dim(r.id)}`);
	}
	if (locals.length > 0) {
		if (remotes.length > 0) out('');
		out(c.bold('LOCAL'));
		for (const l of locals) {
			const hosts = l.ingress.map((i) => i.hostname).filter(Boolean).join(', ');
			out(`  ${l.name}  ${c.dim(l.tunnelId)}${hosts ? `  ${c.dim(`→ ${hosts}`)}` : ''}`);
		}
	}
	out(c.dim(`\n  reuse with \`tunnelkit remote run <name>\` / \`tunnelkit local run <name>\`, remove with \`tunnelkit forget <name>\``));
}

function cmdForget(parsed: ParsedArgs): void {
	const target = parsed.positionals[0];
	if (!target) throw new Error('forget requires a saved name, e.g. `tunnelkit forget prod`');

	const store = makeStore(parsed);
	if (!store) throw new Error('Cannot forget a saved tunnel while --no-save is set.');

	const remote = store.getRemotes().find((r) => r.label === target || r.id === target);
	if (remote) {
		store.removeRemote(remote.id);
		out(c.green(`✓ Forgot remote "${target}". (The Cloudflare tunnel itself is untouched.)`));
		return;
	}
	const local = store.getLocals().find((l) => l.name === target || l.id === target);
	if (local) {
		store.removeLocal(local.id);
		out(c.green(`✓ Forgot local "${target}". (Run \`tunnelkit local delete ${target}\` to also remove it from Cloudflare.)`));
		return;
	}
	out(c.yellow(`No saved tunnel named "${target}".`));
}

async function cmdInstall(parsed: ParsedArgs): Promise<void> {
	const version = parsed.positionals[0] ?? 'latest';
	const tk = makeKit(parsed);
	const spin = spinner(`Downloading cloudflared (${version})…`);
	try {
		const path = await tk.installBinary(version);
		spin.stop(c.green(`✓ cloudflared installed → ${path}`));
	} catch (error) {
		spin.stop();
		throw error;
	}
}

function cmdStatus(parsed: ParsedArgs): void {
	const tk = makeKit(parsed);
	const status = tk.getBinaryStatus();
	if (!status.installed) {
		out(c.yellow('cloudflared: not installed'));
		out(c.dim('  run `tunnelkit install` to download it'));
		return;
	}
	out(`${c.green('cloudflared:')} ${status.version ?? 'unknown version'}`);
	out(c.dim(`  ${status.path}`));
}

function showHelp(version: string): void {
	out(`
${c.cyan('tunnelkit')} ${c.dim(`v${version}`)} — Cloudflare Tunnels from your terminal

${c.bold('USAGE')}
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
  forget <name>                Remove a saved tunnel (leaves Cloudflare untouched)
  install [version]            Download the cloudflared binary (default: latest)
  status                       Show the cloudflared binary status
  version                      Print the tunnelkit version
  help                         Show this help

${c.bold('OPTIONS')}
  --auto-stop <minutes>        quick: minutes until auto-stop (default 0 — never)
  --token <token>              remote run: tunnel token (or set CF_TUNNEL_TOKEN)
  --label <label>              remote run: friendly name (used to save & reuse the token)
  --id <id>                    remote run: stable id for the tunnel (default cli-remote)
  --route <hostname=service>   local run: ingress rule (repeatable)
  --hostname <host>            local run: single ingress hostname (pair with --service)
  --service <url>              local run: single ingress service URL
  --no-save                    don't read or write the saved-config store for this run
  --data-dir <dir>             override the data dir (default ~/.tunnelkit)
  --install-dir <dir>          override the binary dir (default ~/.tunnelkit/bin)
  --verbose                    print library diagnostics to stderr
  -h, --help                   show help
  -v, --version                show version

${c.bold('EXAMPLES')}
  tunnelkit quick 3000
  tunnelkit quick http://localhost:8080 --auto-stop 30
  tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --label prod
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
	status: cmdStatus
};

/** Mode namespaces: `tunnelkit <namespace> <verb> …`. */
const NAMESPACES: Record<string, Record<string, Handler>> = {
	remote: { run: cmdRemote },
	local: { login: cmdLogin, logout: cmdLogout, run: cmdLocal, list: cmdList, delete: cmdDelete }
};

function parseRest(argv: string[]): ParsedArgs {
	return parseCliArgs(argv, {
		booleans: ['verbose', 'help', 'force', 'no-save'],
		aliases: { h: 'help', v: 'version' }
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

	if (!command || command === 'help' || command === '-h' || command === '--help') {
		showHelp(version);
		return;
	}
	if (command === 'version' || command === '-v' || command === '--version') {
		out(`v${version}`);
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
	if (error instanceof CloudflaredMissingError) {
		errLine(c.red('cloudflared is not available.'));
		errLine(c.dim('Run `tunnelkit install` to download it, or install it system-wide.'));
	} else {
		errLine(c.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
	}
	process.exit(1);
});
