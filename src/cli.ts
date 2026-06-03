#!/usr/bin/env node

/**
 * tunnelkit CLI
 *
 * A thin, batteries-included command line over {@link TunnelKit}, so the library
 * can also be used directly from a terminal (`npm i -g tunnelkit` / `bun add -g
 * tunnelkit`). It covers every tunnel mode the library exposes:
 *
 *   tunnelkit quick <port>            Quick TryCloudflare tunnel
 *   tunnelkit remote --token <token>  Token-based (dashboard-managed) tunnel
 *   tunnelkit local <name> --route …  Named tunnel (login → create → route → run)
 *   tunnelkit login | logout          Cloudflare authentication
 *   tunnelkit list                    List named tunnels on the account
 *   tunnelkit delete <name>           Delete a named tunnel
 *   tunnelkit install [version]       Download the cloudflared binary
 *   tunnelkit status                  Show binary status
 *   tunnelkit version | help
 *
 * This is the one place in the package that talks to the terminal directly —
 * the library core stays silent and logs only through the optional `Logger`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { TunnelKit } from './manager.js';
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
		installDir: firstValue(parsed, 'install-dir')
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
	const portStr = parsed.positionals[0] ?? firstValue(parsed, 'port');
	const port = Number(portStr);
	if (!portStr || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('quick requires a port, e.g. `tunnelkit quick 3000`');
	}

	const autoStopStr = firstValue(parsed, 'auto-stop');
	const autoStopMinutes = autoStopStr !== undefined ? Number(autoStopStr) : undefined;
	if (autoStopStr !== undefined && (!Number.isFinite(autoStopMinutes) || (autoStopMinutes as number) < 0)) {
		throw new Error('--auto-stop must be a non-negative number of minutes (0 disables it)');
	}

	const tk = makeKit(parsed);
	await ensureBinary(tk);

	const spin = spinner(`Starting quick tunnel for http://localhost:${port}…`);
	const { publicUrl } = await tk.startQuick({ port, url: firstValue(parsed, 'url'), autoStopMinutes });
	spin.stop();

	out(`\n  ${c.green('●')} ${c.bold(publicUrl)}`);
	out(c.dim(`    → proxying ${firstValue(parsed, 'url') ?? `http://localhost:${port}`}`));
	if (autoStopMinutes && autoStopMinutes > 0) out(c.dim(`    auto-stops in ${autoStopMinutes} min`));
	runUntilInterrupted(tk);
}

async function cmdRemote(parsed: ParsedArgs): Promise<void> {
	const token = firstValue(parsed, 'token') ?? process.env.CF_TUNNEL_TOKEN;
	if (!token) {
		throw new Error('remote requires a token via --token <token> or the CF_TUNNEL_TOKEN env var');
	}
	const id = firstValue(parsed, 'id') ?? 'cli-remote';
	const label = firstValue(parsed, 'label');

	const tk = makeKit(parsed);
	tk.on('ingress-update', ({ ingress }) => {
		for (const rule of ingress) {
			if (rule.hostname) out(c.dim(`    ${rule.hostname} → ${rule.service}`));
		}
	});
	await ensureBinary(tk);

	const spin = spinner('Starting remote tunnel…');
	const { ingress } = await tk.startRemote({ id, token, label });
	spin.stop();

	out(`\n  ${c.green('●')} ${c.bold(label ?? id)} ${c.dim('connected')}`);
	for (const rule of ingress) {
		if (rule.hostname) out(c.dim(`    ${rule.hostname} → ${rule.service}`));
	}
	if (ingress.length === 0) out(c.dim('    ingress will appear here once Cloudflare pushes the config'));
	runUntilInterrupted(tk);
}

async function cmdLocal(parsed: ParsedArgs): Promise<void> {
	const name = parsed.positionals[0];
	if (!name) throw new Error('local requires a tunnel name, e.g. `tunnelkit local my-app --route app.example.com=http://localhost:3000`');

	const routes = gatherRoutes(parsed);
	if (routes.length === 0) {
		throw new Error('local requires at least one --route hostname=service (or --hostname/--service)');
	}

	const tk = makeKit(parsed);
	await ensureBinary(tk);

	if (!tk.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit login` first.');
	}

	const createSpin = spinner(`Creating tunnel "${name}"…`);
	const { tunnelId, credentialsFile } = await tk.createTunnel(name);
	createSpin.stop(c.dim(`  tunnel id ${tunnelId}`));

	for (const route of routes) {
		const dnsSpin = spinner(`Routing ${route.hostname}…`);
		await tk.routeDns(name, route.hostname);
		dnsSpin.stop(c.dim(`  ${route.hostname} routed`));
	}

	const startSpin = spinner('Starting local tunnel…');
	await tk.startLocal({ id: name, name, tunnelId, credentialsFile, ingress: routes });
	startSpin.stop();

	out(`\n  ${c.green('●')} ${c.bold(name)} ${c.dim('connected')}`);
	for (const route of routes) out(c.dim(`    https://${route.hostname} → ${route.service}`));
	runUntilInterrupted(tk);
}

async function cmdLogin(parsed: ParsedArgs): Promise<void> {
	const tk = makeKit(parsed);
	await ensureBinary(tk);

	if (tk.checkAuth().authenticated) {
		out(c.green('✓ Already authenticated with Cloudflare.'));
		return;
	}

	process.on('SIGINT', () => {
		tk.cancelLogin();
		process.exit(1);
	});

	await new Promise<void>((resolve, reject) => {
		tk.login({
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
	const { success } = tk.logout();
	out(success ? c.green('✓ Logged out (certificate removed).') : c.yellow('Nothing to remove.'));
}

async function cmdList(parsed: ParsedArgs): Promise<void> {
	const tk = makeKit(parsed);
	await ensureBinary(tk);

	if (!tk.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit login` first.');
	}

	const tunnels = await tk.listTunnels();
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
	if (!target) throw new Error('delete requires a tunnel name or id, e.g. `tunnelkit delete my-app`');

	const tk = makeKit(parsed);
	await ensureBinary(tk);
	if (!tk.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit login` first.');
	}

	const spin = spinner(`Deleting "${target}"…`);
	await tk.deleteTunnel(target);
	spin.stop(c.green(`✓ Deleted ${target}.`));
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

${c.bold('COMMANDS')}
  quick <port>                 Start a quick TryCloudflare tunnel to localhost:<port>
  remote                       Run a token-based tunnel (--token or CF_TUNNEL_TOKEN)
  local <name>                 Create + route + run a named tunnel (requires login)
  login                        Authenticate with Cloudflare (for named tunnels)
  logout                       Remove the stored origin certificate
  list                         List named tunnels on the account
  delete <name|id>             Delete a named tunnel
  install [version]            Download the cloudflared binary (default: latest)
  status                       Show the cloudflared binary status
  version                      Print the tunnelkit version
  help                         Show this help

${c.bold('OPTIONS')}
  --url <url>                  quick: target URL (default http://localhost:<port>)
  --auto-stop <minutes>        quick: minutes until auto-stop (0 disables; default 60)
  --token <token>              remote: tunnel token (or set CF_TUNNEL_TOKEN)
  --id <id>                    remote: stable id for the tunnel (default cli-remote)
  --label <label>             remote: friendly label
  --route <hostname=service>   local: ingress rule (repeatable)
  --hostname <host>            local: single ingress hostname (pair with --service)
  --service <url>              local: single ingress service URL
  --data-dir <dir>             override the data dir (default ~/.tunnelkit)
  --install-dir <dir>          override the binary dir (default ~/.tunnelkit/bin)
  --verbose                    print library diagnostics to stderr
  -h, --help                   show help
  -v, --version                show version

${c.bold('EXAMPLES')}
  tunnelkit quick 3000
  tunnelkit quick 8080 --auto-stop 30
  tunnelkit remote --token "$CF_TUNNEL_TOKEN"
  tunnelkit login
  tunnelkit local my-app --route app.example.com=http://localhost:3000
  tunnelkit install 2024.12.2

Docs: https://github.com/myrialabs/tunnelkit
`);
}

// --- Entry ---

const COMMANDS: Record<string, (parsed: ParsedArgs) => void | Promise<void>> = {
	quick: cmdQuick,
	remote: cmdRemote,
	local: cmdLocal,
	login: cmdLogin,
	logout: cmdLogout,
	list: cmdList,
	delete: cmdDelete,
	install: cmdInstall,
	status: cmdStatus
};

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

	const handler = COMMANDS[command];
	if (!handler) {
		errLine(c.red(`Unknown command: ${command}`));
		errLine(c.dim('Run `tunnelkit help` for usage.'));
		process.exit(1);
	}

	const parsed = parseCliArgs(argv.slice(1), {
		booleans: ['verbose', 'help', 'force'],
		aliases: { h: 'help', v: 'version' }
	});
	await handler(parsed);
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
