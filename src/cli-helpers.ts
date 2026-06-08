/**
 * Shared helpers for the tunnelkit CLI.
 *
 * Used by both the command layer (`cli-commands.ts`) and the interactive-flow
 * layer (`cli-flows.ts`). Keeps infrastructure (kit / store factories, binary
 * bootstrap, start helpers, validators) out of those files.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { TunnelKit, resolveQuickService } from './tunnelkit.js';
import { TunnelStore } from './store.js';
import type { Logger } from './logger.js';
import { firstValue, type ParsedArgs } from './cli-args.js';
import { c, out, errLine, spinner, runCancelable } from './cli-ui.js';

const formatArg = (value: unknown): string => (typeof value === 'string' ? value : inspect(value, { depth: 3 }));

/** A `Logger` that routes the library's diagnostics to stderr (for `--verbose`). */
export const verboseLogger: Logger = {
	log: (...args) => errLine(c.dim(`  ${args.map(formatArg).join(' ')}`)),
	warn: (...args) => errLine(c.yellow(`  ${args.map(formatArg).join(' ')}`)),
	error: (...args) => errLine(c.red(`  ${args.map(formatArg).join(' ')}`))
};

export function readVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

export function makeKit(parsed: ParsedArgs): TunnelKit {
	return new TunnelKit({
		logger: parsed.flags.has('verbose') ? verboseLogger : undefined,
		dataDir: firstValue(parsed, 'data-dir'),
		installDir: firstValue(parsed, 'install-dir'),
		store: !parsed.flags.has('no-save')
	});
}

/**
 * A standalone store for the config-management commands (`saved`, `forget`).
 * Returns `null` under `--no-save`. Run commands read/write through `tk.store`
 * instead, since `TunnelKit` owns persistence.
 */
export function makeStore(parsed: ParsedArgs): TunnelStore | null {
	if (parsed.flags.has('no-save')) return null;
	return new TunnelStore({
		dataDir: firstValue(parsed, 'data-dir'),
		logger: parsed.flags.has('verbose') ? verboseLogger : undefined
	});
}

export const isInteractive = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

export async function ensureBinary(tk: TunnelKit): Promise<void> {
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

/** Run `cloudflared tunnel login`, surfacing the auth URL; cleans up its signal handler. */
export async function performLogin(tk: TunnelKit): Promise<void> {
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

export function requireLocalAuth(tk: TunnelKit): void {
	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}
}

export async function startQuick(tk: TunnelKit, service: string, autoStopMinutes: number | undefined): Promise<void> {
	await ensureBinary(tk);
	const started = await runCancelable(`Starting quick tunnel for ${service}…`, (signal) =>
		tk.quick.start({ service, autoStopMinutes, signal })
	);
	out(`${c.green('✓')} ${c.accent('quick')} ${c.dim('·')} ${c.url(started.publicUrl)}`);
}

export async function startRemote(tk: TunnelKit, opts: { id: string; token: string; name?: string; silent?: boolean }): Promise<void> {
	await ensureBinary(tk);
	await runCancelable('Starting remote tunnel…', (signal) => tk.remote.start({ ...opts, signal }));
	if (!opts.silent) out(`${c.green('✓')} ${c.accent('remote')} ${c.dim('·')} ${c.bold(opts.name ?? opts.id)}`);
}

export async function startLocalNew(
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
	);
	if (!opts.silent) out(`${c.green('✓')} ${c.accent('local')} ${c.dim('·')} ${c.bold(name)}`);
}

export async function startLocalSaved(
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

// --- Input validation ---

export function validateQuickService(value: string): string | undefined {
	try {
		resolveQuickService(value);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function validateMinutes(value: string): string | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? undefined : 'Enter a non-negative number of minutes (0 disables it).';
}

export function parseRoute(token: string): { hostname: string; service: string } {
	const eq = token.indexOf('=');
	if (eq <= 0 || eq === token.length - 1) {
		throw new Error(`Invalid --route "${token}". Expected "hostname=service", e.g. app.example.com=http://localhost:3000`);
	}
	return { hostname: token.slice(0, eq).trim(), service: token.slice(eq + 1).trim() };
}

export function gatherRoutes(parsed: ParsedArgs): { hostname: string; service: string }[] {
	const routes = (parsed.values.route ?? []).map(parseRoute);
	const hostname = firstValue(parsed, 'hostname');
	const service = firstValue(parsed, 'service');
	if (hostname && service) routes.push({ hostname, service });
	return routes;
}

export function parseAutoStop(parsed: ParsedArgs): number | undefined {
	const autoStopStr = firstValue(parsed, 'auto-stop');
	if (autoStopStr === undefined) return undefined;
	const minutes = Number(autoStopStr);
	if (!Number.isFinite(minutes) || minutes < 0) {
		throw new Error('--auto-stop must be a non-negative number of minutes (0 disables it)');
	}
	return minutes;
}
