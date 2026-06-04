/**
 * TunnelKit
 *
 * High-level orchestration for the three Cloudflare Tunnel modes:
 *
 * - **Quick**   — random `*.trycloudflare.com` URL, no account needed.
 * - **Remote**  — dashboard-managed tunnel run from a token; ingress is synced
 *                 from cloudflared's config push.
 * - **Local**   — locally-managed named tunnel (login → create → route DNS →
 *                 run from a generated config file).
 *
 * The manager owns process lifecycle, start timeouts, quick-tunnel auto-stop,
 * and an in-memory registry of active tunnels. By default it also **persists**
 * the remote and local tunnels you start (to `<dataDir>/config.json`), so you
 * can restore them later through `tk.store`. Set `dataDir` to change where that
 * lives, or pass `store: false` to disable it. Quick tunnels are ephemeral and
 * never saved.
 *
 * Emits:
 * - 'status-changed' (tunnels: ActiveTunnel[])      whenever a tunnel starts/stops
 * - 'ingress-update' ({ id, ingress })              when a remote tunnel's ingress syncs
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
	CloudflaredTunnel,
	CloudflaredMissingError,
	type LoginHandle,
	type LoginCallbacks,
	type TunnelListEntry
} from './tunnel.js';
import {
	resolveCloudflaredBinary,
	defaultInstallDir,
	isBinaryInstalled,
	installBinary,
	getBinaryStatus,
	type BinaryStatus
} from './binary.js';
import { resolveLogger, type Logger } from './logger.js';
import { TunnelStore } from './store.js';
import type { ActiveTunnel, IngressInfo, ProgressCallback, TunnelType } from './types.js';

export interface TunnelKitOptions {
	/** Directory for cert.pem, tunnel credentials, and generated configs. Default: `~/.tunnelkit`. */
	dataDir?: string;
	/** Directory holding the managed cloudflared binary. Default: `~/.tunnelkit/bin`. */
	installDir?: string;
	/** Optional logger; silent when omitted. */
	logger?: Logger;
	/** Quick-tunnel URL timeout in ms. Default: `30000`. */
	quickTimeoutMs?: number;
	/** Remote/local connection timeout in ms. Default: `60000`. */
	connectTimeoutMs?: number;
	/**
	 * Predicate used during name-conflict recovery: return `true` if the given
	 * tunnelId is one your app already tracks, so the manager won't treat it as
	 * an orphan and delete it. Default: always `false`.
	 */
	isTunnelKnown?: (tunnelId: string) => boolean;
	/**
	 * Whether to persist the remote/local tunnels you start, so they can be
	 * restored later (read them back via `tk.store`). Saved under `dataDir` — to
	 * change where, set `dataDir`.
	 *
	 * - **omitted / `true`** (default): auto-save to `<dataDir>/config.json`.
	 * - **`false`**: disable persistence entirely (stateless).
	 * - **a `TunnelStore`** (advanced): use your own instance instead.
	 */
	store?: boolean | TunnelStore;
}

export interface LocalTunnelConfig {
	id: string;
	name: string;
	tunnelId: string;
	credentialsFile: string;
	ingress: IngressInfo[];
}

interface BaseInstance {
	tunnel: CloudflaredTunnel;
	startedAt: Date;
	type: TunnelType;
}

interface QuickInstance extends BaseInstance {
	type: 'quick';
	publicUrl: string;
	service: string;
	autoStopMinutes: number;
	autoStopTimer?: ReturnType<typeof setTimeout>;
}

interface RemoteInstance extends BaseInstance {
	type: 'remote';
	id: string;
	label: string;
	ingress: IngressInfo[];
}

interface LocalInstance extends BaseInstance {
	type: 'local';
	id: string;
	name: string;
	ingress: IngressInfo[];
}

function isTunnelNameConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /tunnel with name already exists/i.test(message);
}

/**
 * Resolve a quick-tunnel target into a service URL. A bare port number
 * (`3000` or `"3000"`) is shorthand for `http://localhost:3000`; anything else
 * is treated as a full service URL and passed through unchanged.
 */
export function resolveQuickService(service: string | number): string {
	const raw = typeof service === 'number' ? String(service) : service.trim();
	if (/^\d+$/.test(raw)) {
		const port = Number(raw);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`Invalid port "${raw}". Expected a number between 1 and 65535, or a full service URL.`);
		}
		return `http://localhost:${port}`;
	}
	if (!raw) throw new Error('A quick tunnel requires a port or service URL.');
	return raw;
}

/** Strongly-typed event map for {@link TunnelKit}. */
export interface TunnelKitEvents {
	'status-changed': [tunnels: ActiveTunnel[]];
	'ingress-update': [data: { id: string; ingress: IngressInfo[] }];
}

// Declaration merging: type the inherited EventEmitter methods.
export interface TunnelKit {
	on<K extends keyof TunnelKitEvents>(event: K, listener: (...args: TunnelKitEvents[K]) => void): this;
	once<K extends keyof TunnelKitEvents>(event: K, listener: (...args: TunnelKitEvents[K]) => void): this;
	off<K extends keyof TunnelKitEvents>(event: K, listener: (...args: TunnelKitEvents[K]) => void): this;
	addListener<K extends keyof TunnelKitEvents>(event: K, listener: (...args: TunnelKitEvents[K]) => void): this;
	removeListener<K extends keyof TunnelKitEvents>(event: K, listener: (...args: TunnelKitEvents[K]) => void): this;
	emit<K extends keyof TunnelKitEvents>(event: K, ...args: TunnelKitEvents[K]): boolean;
}

export class TunnelKit extends EventEmitter {
	private readonly dataDir: string;
	private readonly installDir: string;
	private readonly log: Required<Logger>;
	private readonly quickTimeoutMs: number;
	private readonly connectTimeoutMs: number;
	private readonly isTunnelKnown: (tunnelId: string) => boolean;
	private readonly _store: TunnelStore | null;

	private readonly certPath: string;
	private readonly defaultCloudflaredCert = join(homedir(), '.cloudflared', 'cert.pem');

	private quickTunnels = new Map<string, QuickInstance>();
	private remoteTunnels = new Map<string, RemoteInstance>();
	private localTunnels = new Map<string, LocalInstance>();
	private loginHandle: LoginHandle | null = null;

	constructor(options: TunnelKitOptions = {}) {
		super();
		this.dataDir = options.dataDir ?? join(homedir(), '.tunnelkit');
		this.installDir = options.installDir ?? defaultInstallDir();
		this.log = resolveLogger(options.logger);
		this.quickTimeoutMs = options.quickTimeoutMs ?? 30000;
		this.connectTimeoutMs = options.connectTimeoutMs ?? 60000;
		this.isTunnelKnown = options.isTunnelKnown ?? (() => false);
		this._store = options.store === false
			? null
			: options.store instanceof TunnelStore
				? options.store
				: new TunnelStore({ dataDir: this.dataDir, logger: options.logger });
		this.certPath = join(this.dataDir, 'cert.pem');
	}

	/**
	 * The persistence store backing auto-save, or `null` when persistence is
	 * disabled (`store: false`). Read saved tunnels from it (e.g. to restore on
	 * startup): `tk.store?.getRemotes()`, `tk.store?.getLocals()`.
	 */
	get store(): TunnelStore | null {
		return this._store;
	}

	// --- Binary ---

	/** Whether a managed cloudflared binary is installed in `installDir`. */
	isBinaryInstalled(): boolean {
		return isBinaryInstalled(this.installDir);
	}

	/** Download cloudflared into `installDir`. Never called automatically. */
	async installBinary(version = 'latest'): Promise<string> {
		return installBinary({ installDir: this.installDir, version, logger: this.log });
	}

	/** Resolved cloudflared status: `{ installed, version, path }`. */
	getBinaryStatus(): BinaryStatus {
		return getBinaryStatus(this.installDir);
	}

	/** Resolve a usable binary path or throw {@link CloudflaredMissingError}. */
	private requireBinary(onProgress?: ProgressCallback): string {
		const resolved = resolveCloudflaredBinary(this.installDir);
		if (!resolved) {
			this.log.warn('cloudflared binary not available; call installBinary() or install it system-wide');
			throw new CloudflaredMissingError();
		}
		onProgress?.('binary-ready', { path: resolved });
		return resolved;
	}

	private emitStatus(): void {
		this.emit('status-changed', this.list());
	}

	private ensureDataDir(): void {
		if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
	}

	/**
	 * Await a tunnel reaching its "started" state. Resolves with the value passed
	 * to `succeed` (e.g. the public URL), or rejects on timeout, process error,
	 * or a non-zero early exit — stopping the process in every failure path.
	 */
	private waitForStart<T>(
		tunnel: CloudflaredTunnel,
		opts: { timeoutMs: number; timeoutMessage: string; failMessage: string; attach: (succeed: (value: T) => void) => void }
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;

			const finish = (action: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				action();
			};

			const timer = setTimeout(() => finish(() => {
				tunnel.stop();
				reject(new Error(opts.timeoutMessage));
			}), opts.timeoutMs);

			opts.attach((value) => finish(() => resolve(value)));
			tunnel.once('error', (error) => finish(() => {
				tunnel.stop();
				reject(error);
			}));
			tunnel.once('exit', (code) => {
				if (code !== 0 && code !== null) finish(() => reject(new Error(opts.failMessage)));
			});
		});
	}

	// --- Quick tunnel ---

	async startQuick(
		opts: { service: string | number; autoStopMinutes?: number },
		onProgress?: ProgressCallback
	): Promise<{ id: string; service: string; publicUrl: string; timings: Record<string, number> }> {
		const service = resolveQuickService(opts.service);
		const autoStopMinutes = opts.autoStopMinutes ?? 0;
		onProgress?.('checking-binary');
		const binaryPath = this.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const existing = this.quickTunnels.get(service);
		if (existing) {
			return { id: `quick:${service}`, service, publicUrl: existing.publicUrl, timings };
		}

		onProgress?.('starting-tunnel', { service });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.quick(service, binaryPath);
		tunnel.on('error', (error) => this.log.error(`[quick:${service}] error:`, error));
		tunnel.on('exit', (code) => {
			this.log.log(`[quick:${service}] exit code ${code}`);
			this.quickTunnels.delete(service);
			this.emitStatus();
		});

		onProgress?.('generating-url');

		const publicUrl = await this.waitForStart<string>(tunnel, {
			timeoutMs: this.quickTimeoutMs,
			timeoutMessage: `Tunnel connection timeout (${this.quickTimeoutMs}ms). Is ${service} reachable?`,
			failMessage: `Tunnel failed to start for ${service}.`,
			// The first non-API trycloudflare URL is the public hostname.
			attach: (succeed) => tunnel.on('url', (url) => {
				if (!url.includes('api.trycloudflare.com')) succeed(url);
			})
		});

		timings.tunnelStart = Date.now() - startTime;

		let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
		if (autoStopMinutes > 0) {
			autoStopTimer = setTimeout(() => {
				this.log.log(`Auto-stopping quick tunnel for ${service}`);
				void this.stopQuick(service);
			}, autoStopMinutes * 60 * 1000);
		}

		this.quickTunnels.set(service, {
			tunnel,
			publicUrl,
			service,
			type: 'quick',
			startedAt: new Date(),
			autoStopMinutes,
			autoStopTimer
		});

		this.log.log(`Quick tunnel started for ${service}: ${publicUrl}`);
		onProgress?.('connected', { publicUrl, timings });
		this.emitStatus();

		return { id: `quick:${service}`, service, publicUrl, timings };
	}

	async stopQuick(service: string | number): Promise<void> {
		const key = resolveQuickService(
			typeof service === 'string' && service.startsWith('quick:') ? service.slice('quick:'.length) : service
		);
		const instance = this.quickTunnels.get(key);
		if (!instance) return;

		if (instance.autoStopTimer) clearTimeout(instance.autoStopTimer);
		try {
			instance.tunnel.stop();
		} catch (err) {
			this.log.warn(`Failed to stop quick tunnel for ${key}:`, err);
		}
		this.quickTunnels.delete(key);
		this.log.log(`Quick tunnel stopped for ${key}`);
		this.emitStatus();
	}

	// --- Remote tunnel (token-based) ---

	async startRemote(
		opts: { id: string; token: string; label?: string },
		onProgress?: ProgressCallback
	): Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }> {
		const label = opts.label ?? opts.id;
		onProgress?.('checking-binary');
		const binaryPath = this.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const running = this.remoteTunnels.get(opts.id);
		if (running) {
			return { ingress: running.ingress, timings };
		}

		onProgress?.('starting-tunnel', { label });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.withToken(opts.token, binaryPath);
		const instance: RemoteInstance = {
			tunnel,
			type: 'remote',
			id: opts.id,
			label,
			startedAt: new Date(),
			ingress: []
		};

		tunnel.on('config', (data) => {
			if (data.config?.ingress && Array.isArray(data.config.ingress)) {
				instance.ingress = data.config.ingress.map((rule: { hostname?: string; service: string }) => ({
					hostname: rule.hostname,
					service: rule.service
				}));
				this.log.log(`[remote:${label}] config synced, ${instance.ingress.length} ingress rules`);
				this.emit('ingress-update', { id: opts.id, ingress: instance.ingress });
			}
		});
		tunnel.on('error', (error) => this.log.error(`[remote:${label}] error:`, error));
		tunnel.on('exit', (code) => {
			this.log.log(`[remote:${label}] exit code ${code}`);
			this.remoteTunnels.delete(opts.id);
			this.emitStatus();
		});

		onProgress?.('generating-url');

		await this.waitForStart<void>(tunnel, {
			timeoutMs: this.connectTimeoutMs,
			timeoutMessage: `Remote tunnel connection timeout (${this.connectTimeoutMs}ms). Check the token.`,
			failMessage: 'Remote tunnel failed to start. Verify the token.',
			attach: (succeed) => tunnel.once('connected', () => succeed())
		});

		timings.tunnelStart = Date.now() - startTime;
		this.remoteTunnels.set(opts.id, instance);
		this._store?.upsertRemote(opts.id, label, opts.token);

		this.log.log(`Remote tunnel started: ${label}`);
		onProgress?.('connected', { timings });
		this.emitStatus();

		return { ingress: instance.ingress, timings };
	}

	async stopRemote(id: string): Promise<void> {
		const instance = this.remoteTunnels.get(id);
		if (!instance) return;

		try {
			instance.tunnel.stop();
		} catch (err) {
			this.log.warn(`Failed to stop remote tunnel ${instance.label}:`, err);
		}
		this.remoteTunnels.delete(id);
		this.log.log(`Remote tunnel stopped: ${instance.label}`);
		this.emitStatus();
	}

	getRemoteIngress(id: string): IngressInfo[] {
		return this.remoteTunnels.get(id)?.ingress ?? [];
	}

	isRemoteActive(id: string): boolean {
		return this.remoteTunnels.has(id);
	}

	// --- Local tunnel (locally-managed) ---

	/** Path to the origin certificate this manager uses. */
	getCertPath(): string {
		return this.certPath;
	}

	/** Whether a cloudflared origin cert is present (migrating from `~/.cloudflared` if needed). */
	checkAuth(): { authenticated: boolean; certPath: string } {
		if (!existsSync(this.certPath) && existsSync(this.defaultCloudflaredCert)) {
			this.moveCertToDataDir();
		}
		return { authenticated: existsSync(this.certPath), certPath: this.certPath };
	}

	/**
	 * Run `cloudflared tunnel login`. The auth URL is delivered via `onUrl`;
	 * on success the origin cert is moved into `dataDir`.
	 */
	login(callbacks: LoginCallbacks): void {
		const binaryPath = this.requireBinary();

		if (this.loginHandle) {
			callbacks.onError('Login process already running');
			return;
		}

		this.log.log('Starting cloudflared login...');

		this.loginHandle = CloudflaredTunnel.login(
			{
				onUrl: (url) => {
					this.log.log(`[login] auth URL: ${url}`);
					callbacks.onUrl(url);
				},
				onComplete: () => {
					this.loginHandle = null;
					this.moveCertToDataDir();
					this.log.log('cloudflared login successful');
					callbacks.onComplete();
				},
				onError: (message) => {
					this.loginHandle = null;
					this.log.error(`cloudflared login failed: ${message}`);
					callbacks.onError(message);
				}
			},
			{ binaryPath }
		);
	}

	cancelLogin(): void {
		if (this.loginHandle) {
			this.log.log('cloudflared login cancelled');
			this.loginHandle.cancel();
			this.loginHandle = null;
		}
	}

	/** Remove the origin cert (i.e. log out). */
	logout(): { success: boolean } {
		try {
			if (existsSync(this.certPath)) {
				unlinkSync(this.certPath);
				this.log.log('cloudflared cert.pem removed (logged out)');
			}
			return { success: true };
		} catch (error) {
			this.log.error('Failed to remove cert.pem:', error);
			return { success: false };
		}
	}

	private moveCertToDataDir(): void {
		if (existsSync(this.defaultCloudflaredCert)) {
			this.ensureDataDir();
			renameSync(this.defaultCloudflaredCert, this.certPath);
			this.log.log(`Cert moved: ${this.defaultCloudflaredCert} -> ${this.certPath}`);
		}
	}

	/** Create a named tunnel, organizing credentials under `dataDir/<tunnelId>/`. */
	async createTunnel(name: string): Promise<{ tunnelId: string; credentialsFile: string }> {
		const binaryPath = this.requireBinary();
		try {
			return await this.runCreateTunnel(name, binaryPath);
		} catch (error) {
			if (!isTunnelNameConflict(error)) throw error;
			// Name collides on Cloudflare: auto-recover only a true orphan, then retry once.
			await this.resolveTunnelNameConflict(name, binaryPath);
			return await this.runCreateTunnel(name, binaryPath);
		}
	}

	private async runCreateTunnel(name: string, binaryPath: string): Promise<{ tunnelId: string; credentialsFile: string }> {
		this.ensureDataDir();

		const tempCredentials = join(this.dataDir, `${name}.json`);
		const result = await CloudflaredTunnel.createTunnel(name, {
			credentialsFile: tempCredentials,
			origincert: this.certPath,
			binaryPath
		});

		const tunnelDir = join(this.dataDir, result.tunnelId);
		if (!existsSync(tunnelDir)) mkdirSync(tunnelDir, { recursive: true });
		const finalCredentials = join(tunnelDir, 'credentials.json');
		renameSync(tempCredentials, finalCredentials);

		this.log.log(`Local tunnel created: ${name} (${result.tunnelId})`);
		return { tunnelId: result.tunnelId, credentialsFile: finalCredentials };
	}

	/**
	 * Resolve a "tunnel with name already exists" conflict. A tunnel that exists
	 * on Cloudflare but isn't tracked locally and has no active connections is an
	 * orphan (usually a half-failed create) and is safe to delete before retry.
	 * Anything else throws a clear, actionable message.
	 */
	private async resolveTunnelNameConflict(name: string, binaryPath: string): Promise<void> {
		const conflict = `A Cloudflare tunnel named "${name}" already exists on your account. Choose a different name, or remove it from the Cloudflare dashboard.`;

		let existing;
		try {
			existing = await CloudflaredTunnel.listTunnels({ origincert: this.certPath, binaryPath });
		} catch (listError) {
			this.log.warn('Could not list tunnels to resolve name conflict:', listError);
			throw new Error(conflict);
		}

		const match = existing.find((t) => t.name === name);
		if (!match) throw new Error(conflict);

		if (this.isTunnelKnown(match.id)) {
			throw new Error(`A tunnel named "${name}" already exists. Choose a different name, or delete the existing tunnel first.`);
		}
		if (match.connections.length > 0) {
			throw new Error(`A Cloudflare tunnel named "${name}" already exists and has active connections. Choose a different name, or remove it from the Cloudflare dashboard.`);
		}

		this.log.warn(`Orphaned tunnel "${name}" (${match.id}) found on Cloudflare; deleting before recreate`);
		await CloudflaredTunnel.deleteTunnel(match.id, { force: true, origincert: this.certPath, binaryPath });
		this.cleanupTunnelFiles(match.id);
	}

	async deleteTunnel(tunnelId: string, credentialsFile?: string): Promise<void> {
		const binaryPath = this.requireBinary();
		await CloudflaredTunnel.deleteTunnel(tunnelId, { credentialsFile, origincert: this.certPath, binaryPath });
		this.log.log(`Local tunnel deleted: ${tunnelId}`);
	}

	/** Remove the on-disk config/credentials directory for a tunnel. */
	cleanupTunnelFiles(tunnelId: string): void {
		const configDir = join(this.dataDir, tunnelId);
		if (existsSync(configDir)) {
			rmSync(configDir, { recursive: true });
			this.log.log(`Tunnel config directory removed: ${configDir}`);
		}
	}

	async routeDns(tunnelName: string, hostname: string): Promise<{ alreadyExists: boolean }> {
		const binaryPath = this.requireBinary();
		const result = await CloudflaredTunnel.routeDns(tunnelName, hostname, {
			overwriteDns: true,
			origincert: this.certPath,
			binaryPath
		});
		this.log.log(`DNS route ${result.alreadyExists ? 'updated' : 'added'}: ${hostname} -> ${tunnelName}`);
		return result;
	}

	/** List every named tunnel on the authenticated Cloudflare account. */
	async listTunnels(): Promise<TunnelListEntry[]> {
		const binaryPath = this.requireBinary();
		return CloudflaredTunnel.listTunnels({ origincert: this.certPath, binaryPath });
	}

	/** Write a cloudflared config.yml for a local tunnel and return its path. */
	writeLocalConfig(config: Pick<LocalTunnelConfig, 'tunnelId' | 'credentialsFile' | 'ingress'>): string {
		const configDir = join(this.dataDir, config.tunnelId);
		if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

		const configPath = join(configDir, 'config.yml');
		const ingressRules = [
			...config.ingress.map((r) => `  - hostname: ${r.hostname}\n    service: ${r.service}`),
			'  - service: http_status:404'
		];
		const yml = [`tunnel: ${config.tunnelId}`, `credentials-file: ${config.credentialsFile}`, 'ingress:', ...ingressRules].join('\n');

		writeFileSync(configPath, yml, 'utf-8');
		this.log.log(`Config file written: ${configPath}`);
		return configPath;
	}

	async startLocal(
		config: LocalTunnelConfig,
		onProgress?: ProgressCallback
	): Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }> {
		onProgress?.('checking-binary');
		const binaryPath = this.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const running = this.localTunnels.get(config.id);
		if (running) {
			return { ingress: running.ingress, timings };
		}

		if (config.ingress.length === 0) {
			throw new Error('Cannot start a local tunnel without ingress rules. Add at least one hostname mapping.');
		}

		const configPath = this.writeLocalConfig(config);

		onProgress?.('starting-tunnel', { name: config.name });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.withConfig(configPath, binaryPath);
		tunnel.on('error', (error) => this.log.error(`[local:${config.name}] error:`, error));
		tunnel.on('exit', (code) => {
			this.log.log(`[local:${config.name}] exit code ${code}`);
			this.localTunnels.delete(config.id);
			this.emitStatus();
		});

		onProgress?.('generating-url');

		await this.waitForStart<void>(tunnel, {
			timeoutMs: this.connectTimeoutMs,
			timeoutMessage: `Local tunnel connection timeout (${this.connectTimeoutMs}ms). Check config and credentials.`,
			failMessage: `Local tunnel "${config.name}" failed to start.`,
			attach: (succeed) => tunnel.once('connected', () => succeed())
		});

		timings.tunnelStart = Date.now() - startTime;

		this.localTunnels.set(config.id, {
			tunnel,
			type: 'local',
			id: config.id,
			name: config.name,
			startedAt: new Date(),
			ingress: config.ingress.map((r) => ({ hostname: r.hostname, service: r.service }))
		});
		this._store?.upsertLocal({
			id: config.id,
			name: config.name,
			tunnelId: config.tunnelId,
			credentialsFile: config.credentialsFile,
			ingress: config.ingress.map((r) => ({ hostname: r.hostname, service: r.service }))
		});

		this.log.log(`Local tunnel started: ${config.name}`);
		onProgress?.('connected', { timings });
		this.emitStatus();

		return { ingress: config.ingress, timings };
	}

	async stopLocal(id: string): Promise<void> {
		const instance = this.localTunnels.get(id);
		if (!instance) return;

		try {
			instance.tunnel.stop();
		} catch (err) {
			this.log.warn(`Failed to stop local tunnel ${instance.name}:`, err);
		}
		this.localTunnels.delete(id);
		this.log.log(`Local tunnel stopped: ${instance.name}`);
		this.emitStatus();
	}

	isLocalActive(id: string): boolean {
		return this.localTunnels.has(id);
	}

	// --- Status / lifecycle ---

	/** Snapshot of every tunnel currently managed. */
	list(): ActiveTunnel[] {
		const tunnels: ActiveTunnel[] = [];

		for (const [service, instance] of this.quickTunnels) {
			tunnels.push({
				id: `quick:${service}`,
				type: 'quick',
				service,
				publicUrl: instance.publicUrl,
				startedAt: instance.startedAt.toISOString(),
				autoStopMinutes: instance.autoStopMinutes
			});
		}

		for (const instance of [...this.remoteTunnels.values(), ...this.localTunnels.values()]) {
			const firstHostname = instance.ingress.find((r) => r.hostname)?.hostname;
			tunnels.push({
				id: instance.id,
				type: instance.type,
				publicUrl: firstHostname ? `https://${firstHostname}` : '',
				startedAt: instance.startedAt.toISOString(),
				label: instance.type === 'remote' ? instance.label : instance.name,
				ingress: instance.ingress
			});
		}

		return tunnels;
	}

	/** Stop every managed tunnel. */
	async stopAll(): Promise<void> {
		this.log.log('Stopping all tunnels...');
		const ops: Promise<void>[] = [];
		for (const service of this.quickTunnels.keys()) ops.push(this.stopQuick(service));
		for (const id of this.remoteTunnels.keys()) ops.push(this.stopRemote(id));
		for (const id of this.localTunnels.keys()) ops.push(this.stopLocal(id));
		await Promise.all(ops);
		this.log.log('All tunnels stopped');
	}
}
