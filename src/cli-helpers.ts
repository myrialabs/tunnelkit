/**
 * Shared helpers for the tunnelkit CLI.
 *
 * Used by both the command layer (`cli-commands.ts`) and the interactive-flow
 * layer (`cli-flows.ts`). Keeps infrastructure (kit / store factories, binary
 * bootstrap, start helpers, validators) out of those files.
 */

import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { TunnelKit, resolveQuickService } from './tunnelkit.js';
import { TunnelStore } from './store.js';
import type { Logger } from './logger.js';
import { firstValue, type ParsedArgs } from './cli-args.js';
import {
	c,
	out,
	errLine,
	spinner,
	runCancelable,
	runProgress,
	printScreen,
	progressScreen,
	type Breadcrumb,
	type ProgressScreen
} from './cli-ui.js';

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

export async function ensureBinary(tk: TunnelKit, opts: { breadcrumb?: Breadcrumb; progress?: ProgressScreen } = {}): Promise<void> {
	if (tk.bin.status().installed) return;
	if (opts.progress) {
		opts.progress.start('cloudflared not found — downloading…');
		const path = await tk.bin.install();
		opts.progress.succeed(`cloudflared installed → ${path}`);
		return;
	}
	const spin = spinner('cloudflared not found — downloading…', { breadcrumb: opts.breadcrumb });
	try {
		const path = await tk.bin.install();
		spin.stop(c.dim(`  cloudflared installed → ${path}`));
	} catch (error) {
		spin.stop();
		throw error;
	}
}

/** Run `cloudflared tunnel login`, surfacing the auth URL; cleans up its signal handler. */
export async function performLogin(tk: TunnelKit, opts: { breadcrumb?: Breadcrumb; progress?: ProgressScreen } = {}): Promise<void> {
	const onSig = (): void => {
		tk.local.cancelLogin();
		process.exit(1);
	};
	process.once('SIGINT', onSig);
	const progress = opts.progress ?? (opts.breadcrumb ? progressScreen({ breadcrumb: opts.breadcrumb }) : undefined);
	try {
		await new Promise<void>((resolve, reject) => {
			tk.local.login({
				onUrl: (url) => {
					if (progress) {
						progress.info('Authorize this device in your browser:');
						progress.info(`  ${c.url(url)}`);
						progress.start('Waiting for approval…');
						return;
					}
					printScreen({
						breadcrumb: opts.breadcrumb,
						body: [
							'  Authorize this device in your browser:',
							'',
							`    ${c.url(url)}`,
							'',
							c.dim('  Waiting for approval…')
						]
					});
				},
				onComplete: () => resolve(),
				onError: (message) => reject(new Error(message))
			});
		});
		if (progress) {
			progress.succeed('Logged in. Origin certificate saved.');
			return;
		}
		printScreen({
			breadcrumb: opts.breadcrumb,
			body: [`  ${c.accent('✓ Logged in. Origin certificate saved.')}`]
		});
	} finally {
		progress?.stop();
		process.removeListener('SIGINT', onSig);
	}
}

export function requireLocalAuth(tk: TunnelKit): void {
	if (!tk.local.checkAuth().authenticated) {
		throw new Error('Not authenticated with Cloudflare. Run `tunnelkit local login` first.');
	}
}

export async function startQuick(
	tk: TunnelKit,
	service: string,
	autoStopMinutes: number | undefined,
	opts: { breadcrumb?: Breadcrumb } = {}
): Promise<void> {
	const progress = opts.breadcrumb ? progressScreen({ breadcrumb: opts.breadcrumb }) : undefined;
	try {
		await ensureBinary(tk, { breadcrumb: opts.breadcrumb, progress });
		const started = progress
			? await runProgress(progress, `Starting quick tunnel for ${service}…`, (signal) =>
				tk.quick.start({ service, autoStopMinutes, signal })
			)
			: await runCancelable(`Starting quick tunnel for ${service}…`, (signal) =>
				tk.quick.start({ service, autoStopMinutes, signal })
			);
		progress?.succeed(`quick · ${started.publicUrl}`);
		if (!progress) out(`${c.accent('✓')} ${c.accent('quick')} ${c.dim('·')} ${c.url(started.publicUrl)}`);
	} finally {
		progress?.stop();
	}
}

export async function startRemote(
	tk: TunnelKit,
	opts: { id: string; token: string; name?: string; silent?: boolean; breadcrumb?: Breadcrumb }
): Promise<void> {
	const { breadcrumb, silent, ...startOpts } = opts;
	const progress = breadcrumb ? progressScreen({ breadcrumb }) : undefined;
	try {
		await ensureBinary(tk, { breadcrumb, progress });
		if (progress) {
			await runProgress(progress, 'Starting remote tunnel…', (signal) => tk.remote.start({ ...startOpts, signal }));
			progress.succeed(`remote · ${opts.name ?? opts.id}`);
		} else {
			await runCancelable('Starting remote tunnel…', (signal) => tk.remote.start({ ...startOpts, signal }));
			if (!silent) out(`${c.accent('✓')} ${c.accent('remote')} ${c.dim('·')} ${c.bold(opts.name ?? opts.id)}`);
		}
	} finally {
		progress?.stop();
	}
}

export async function startLocalNew(
	tk: TunnelKit,
	name: string,
	routes: { hostname: string; service: string }[],
	opts: { silent?: boolean; breadcrumb?: Breadcrumb } = {}
): Promise<void> {
	const progress = opts.breadcrumb ? progressScreen({ breadcrumb: opts.breadcrumb }) : undefined;
	try {
		await ensureBinary(tk, { breadcrumb: opts.breadcrumb, progress });
		requireLocalAuth(tk);

		let created;
		if (progress) {
			progress.start(`Creating tunnel "${name}"…`);
			created = await tk.local.create(name);
			progress.succeed(`tunnel id ${created.tunnelId}`);
		} else {
			const createSpin = spinner(`Creating tunnel "${name}"…`);
			try {
				created = await tk.local.create(name);
			} catch (error) {
				createSpin.stop();
				throw error;
			}
			createSpin.stop(c.dim(`  tunnel id ${created.tunnelId}`));
		}

		for (const route of routes) {
			if (progress) {
				progress.start(`Routing ${route.hostname}…`);
				await tk.local.routeDns(name, route.hostname);
				progress.succeed(`${route.hostname} routed`);
			} else {
				const dnsSpin = spinner(`Routing ${route.hostname}…`);
				try {
					await tk.local.routeDns(name, route.hostname);
				} catch (error) {
					dnsSpin.stop();
					throw error;
				}
				dnsSpin.stop(c.dim(`  ${route.hostname} routed`));
			}
		}

		const start = (signal: AbortSignal) =>
			tk.local.start(
				{ id: name, name, tunnelId: created.tunnelId, credentialsFile: created.credentialsFile, ingress: routes },
				undefined,
				{ signal }
			);
		if (progress) {
			await runProgress(progress, 'Starting local tunnel…', start);
			progress.succeed(`local · ${name}`);
		} else {
			await runCancelable('Starting local tunnel…', start);
			if (!opts.silent) out(`${c.accent('✓')} ${c.accent('local')} ${c.dim('·')} ${c.bold(name)}`);
		}
	} finally {
		progress?.stop();
	}
}

export async function startLocalSaved(
	tk: TunnelKit,
	name: string,
	previous: { tunnelId: string; credentialsFile: string; ingress: { hostname?: string; service: string }[] },
	opts: { breadcrumb?: Breadcrumb } = {}
): Promise<void> {
	const progress = opts.breadcrumb ? progressScreen({ breadcrumb: opts.breadcrumb }) : undefined;
	try {
		await ensureBinary(tk, { breadcrumb: opts.breadcrumb, progress });
		requireLocalAuth(tk);
		const start = (signal: AbortSignal) =>
			tk.local.start(
				{ id: name, name, tunnelId: previous.tunnelId, credentialsFile: previous.credentialsFile, ingress: previous.ingress },
				undefined,
				{ signal }
			);
		if (progress) {
			await runProgress(progress, `Starting saved tunnel "${name}"…`, start);
			progress.succeed(`local · ${name}`);
		} else {
			await runCancelable(`Starting saved tunnel "${name}"…`, start);
			out(`${c.accent('✓')} ${c.accent('local')} ${c.dim('·')} ${c.bold(name)}`);
		}
	} finally {
		progress?.stop();
	}
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

// --- Version update check ---

function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na > nb) return 1;
		if (na < nb) return -1;
	}
	return 0;
}

async function fetchLatestNpmVersion(): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		const req = get(
			'https://registry.npmjs.org/@myrialabs/tunnelkit/latest',
			{ headers: { Accept: 'application/json' } },
			(res) => {
				let data = '';
				res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						resolve(typeof json.version === 'string' ? json.version : null);
					} catch {
						resolve(null);
					}
				});
			}
		);
		req.setTimeout(5000, () => { req.destroy(); resolve(null); });
		req.on('error', () => resolve(null));
	});
}

/**
 * Check the npm registry for a newer version of @myrialabs/tunnelkit.
 * Returns the latest version string if newer than `currentVersion`,
 * `null` if already up-to-date, or `false` if the check failed.
 * The interactive panel treats `false` as silent; the explicit
 * `update` command uses it to surface a distinct error message.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null | false> {
	try {
		const latest = await fetchLatestNpmVersion();
		if (!latest) return false;
		return compareVersions(latest, currentVersion) > 0 ? latest : null;
	} catch {
		return false;
	}
}

/**
 * Best-effort detection of which package manager installed @myrialabs/tunnelkit,
 * based on the npm_config_user_agent env var set by npm/bun/yarn/pnpm.
 */
export function detectPackageManager(): string {
	const ua = process.env.npm_config_user_agent ?? '';
	if (ua.includes('bun')) return 'bun';
	if (ua.includes('pnpm')) return 'pnpm';
	if (ua.includes('yarn')) return 'yarn';
	return 'npm';
}
