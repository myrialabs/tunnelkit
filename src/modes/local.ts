/**
 * Local tunnels — locally-managed named tunnels.
 *
 * This is the only mode that talks to your Cloudflare account directly: you
 * authenticate once (`login`), then create named tunnels, route DNS, and run
 * them from a generated config file. Quick needs no account and Remote uses a
 * token, so everything account-related lives here. Reach this through
 * `tk.local` on a {@link TunnelKit}.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import {
	CloudflaredTunnel,
	type LoginHandle,
	type LoginCallbacks,
	type TunnelListEntry
} from '../cloudflared-tunnel.js';
import type { ActiveTunnel, IngressInfo, LocalTunnelConfig, ProgressCallback } from '../types.js';
import { waitForStart, ConnectionTracker, type ManagerContext } from './context.js';

interface LocalTunnelHandle {
	tunnel: CloudflaredTunnel;
	startedAt: Date;
	id: string;
	name: string;
	ingress: IngressInfo[];
	connections: ConnectionTracker;
}

function isTunnelNameConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /tunnel with name already exists/i.test(message);
}

export class LocalMode {
	private readonly tunnels = new Map<string, LocalTunnelHandle>();
	private loginHandle: LoginHandle | null = null;

	constructor(private readonly ctx: ManagerContext) {}

	// --- Authentication ---

	/** Path to the origin certificate this manager uses. */
	certPath(): string {
		return this.ctx.certPath;
	}

	/** Whether a cloudflared origin cert is present (migrating from `~/.cloudflared` if needed). */
	checkAuth(): { authenticated: boolean; certPath: string } {
		if (!existsSync(this.ctx.certPath) && existsSync(this.ctx.defaultCloudflaredCert)) {
			this.moveCertToDataDir();
		}
		return { authenticated: existsSync(this.ctx.certPath), certPath: this.ctx.certPath };
	}

	/**
	 * Run `cloudflared tunnel login`. The auth URL is delivered via `onUrl`;
	 * on success the origin cert is moved into `dataDir`.
	 */
	login(callbacks: LoginCallbacks): void {
		const binaryPath = this.ctx.requireBinary();

		if (this.loginHandle) {
			callbacks.onError('Login process already running');
			return;
		}

		this.ctx.log.log('Starting cloudflared login...');

		this.loginHandle = CloudflaredTunnel.login(
			{
				onUrl: (url) => {
					this.ctx.log.log(`[login] auth URL: ${url}`);
					callbacks.onUrl(url);
				},
				onComplete: () => {
					this.loginHandle = null;
					this.moveCertToDataDir();
					this.ctx.log.log('cloudflared login successful');
					callbacks.onComplete();
				},
				onError: (message) => {
					this.loginHandle = null;
					this.ctx.log.error(`cloudflared login failed: ${message}`);
					callbacks.onError(message);
				}
			},
			{ binaryPath }
		);
	}

	cancelLogin(): void {
		if (this.loginHandle) {
			this.ctx.log.log('cloudflared login cancelled');
			this.loginHandle.cancel();
			this.loginHandle = null;
		}
	}

	/** Remove the origin cert (i.e. log out). */
	logout(): { success: boolean } {
		try {
			if (existsSync(this.ctx.certPath)) {
				unlinkSync(this.ctx.certPath);
				this.ctx.log.log('cloudflared cert.pem removed (logged out)');
			}
			return { success: true };
		} catch (error) {
			this.ctx.log.error('Failed to remove cert.pem:', error);
			return { success: false };
		}
	}

	private moveCertToDataDir(): void {
		if (existsSync(this.ctx.defaultCloudflaredCert)) {
			this.ctx.ensureDataDir();
			renameSync(this.ctx.defaultCloudflaredCert, this.ctx.certPath);
			this.ctx.log.log(`Cert moved: ${this.ctx.defaultCloudflaredCert} -> ${this.ctx.certPath}`);
		}
	}

	// --- Named tunnels on the account ---

	/** Create a named tunnel, organizing credentials under `dataDir/<tunnelId>/`. */
	async create(name: string): Promise<{ tunnelId: string; credentialsFile: string }> {
		const binaryPath = this.ctx.requireBinary();
		try {
			return await this.runCreate(name, binaryPath);
		} catch (error) {
			if (!isTunnelNameConflict(error)) throw error;
			// Name collides on Cloudflare: auto-recover only a true orphan, then retry once.
			await this.resolveNameConflict(name, binaryPath);
			return await this.runCreate(name, binaryPath);
		}
	}

	private async runCreate(name: string, binaryPath: string): Promise<{ tunnelId: string; credentialsFile: string }> {
		this.ctx.ensureDataDir();

		const tempCredentials = join(this.ctx.dataDir, `${name}.json`);
		const result = await CloudflaredTunnel.createTunnel(name, {
			credentialsFile: tempCredentials,
			origincert: this.ctx.certPath,
			binaryPath
		});

		const tunnelDir = join(this.ctx.dataDir, result.tunnelId);
		if (!existsSync(tunnelDir)) mkdirSync(tunnelDir, { recursive: true });
		const finalCredentials = join(tunnelDir, 'credentials.json');
		renameSync(tempCredentials, finalCredentials);

		this.ctx.log.log(`Local tunnel created: ${name} (${result.tunnelId})`);
		return { tunnelId: result.tunnelId, credentialsFile: finalCredentials };
	}

	/**
	 * Resolve a "tunnel with name already exists" conflict. A tunnel that exists
	 * on Cloudflare but isn't tracked locally and has no active connections is an
	 * orphan (usually a half-failed create) and is safe to delete before retry.
	 * Anything else throws a clear, actionable message.
	 */
	private async resolveNameConflict(name: string, binaryPath: string): Promise<void> {
		const conflict = `A Cloudflare tunnel named "${name}" already exists on your account. Choose a different name, or remove it from the Cloudflare dashboard.`;

		let existing;
		try {
			existing = await CloudflaredTunnel.listTunnels({ origincert: this.ctx.certPath, binaryPath });
		} catch (listError) {
			this.ctx.log.warn('Could not list tunnels to resolve name conflict:', listError);
			throw new Error(conflict);
		}

		const match = existing.find((t) => t.name === name);
		if (!match) throw new Error(conflict);

		if (this.ctx.isTunnelKnown(match.id)) {
			throw new Error(`A tunnel named "${name}" already exists. Choose a different name, or delete the existing tunnel first.`);
		}
		if (match.connections.length > 0) {
			throw new Error(`A Cloudflare tunnel named "${name}" already exists and has active connections. Choose a different name, or remove it from the Cloudflare dashboard.`);
		}

		this.ctx.log.warn(`Orphaned tunnel "${name}" (${match.id}) found on Cloudflare; deleting before recreate`);
		await CloudflaredTunnel.deleteTunnel(match.id, { force: true, origincert: this.ctx.certPath, binaryPath });
		this.cleanupFiles(match.id);
	}

	async delete(tunnelId: string, credentialsFile?: string): Promise<void> {
		const binaryPath = this.ctx.requireBinary();
		await CloudflaredTunnel.deleteTunnel(tunnelId, { credentialsFile, origincert: this.ctx.certPath, binaryPath });
		this.ctx.log.log(`Local tunnel deleted: ${tunnelId}`);
	}

	/** Remove the on-disk config/credentials directory for a tunnel. */
	cleanupFiles(tunnelId: string): void {
		const configDir = join(this.ctx.dataDir, tunnelId);
		if (existsSync(configDir)) {
			rmSync(configDir, { recursive: true });
			this.ctx.log.log(`Tunnel config directory removed: ${configDir}`);
		}
	}

	async routeDns(tunnelName: string, hostname: string): Promise<{ alreadyExists: boolean }> {
		const binaryPath = this.ctx.requireBinary();
		const result = await CloudflaredTunnel.routeDns(tunnelName, hostname, {
			overwriteDns: true,
			origincert: this.ctx.certPath,
			binaryPath
		});
		this.ctx.log.log(`DNS route ${result.alreadyExists ? 'updated' : 'added'}: ${hostname} -> ${tunnelName}`);
		return result;
	}

	/**
	 * Find a saved config by `id` or `hostname`, or create one: runs `create`,
	 * `routeDns`, saves the result to the store, and returns the config. On
	 * subsequent runs the saved record is returned immediately without touching
	 * Cloudflare again.
	 *
	 * ```ts
	 * const config = await tk.local.prepare({ id: 'storefront', hostname: 'app.example.com', service: 'http://localhost:3000' });
	 * await tk.local.start(config);
	 * ```
	 */
	async prepare(opts: { id: string; hostname: string; service: string }): Promise<LocalTunnelConfig> {
		const existing = this.ctx.store.getLocals().find(
			(l) => l.id === opts.id || l.ingress.some((r) => r.hostname === opts.hostname)
		);
		if (existing) return existing;

		const created = await this.create(opts.id);
		await this.routeDns(opts.id, opts.hostname);
		const config: LocalTunnelConfig = {
			id: opts.id,
			name: opts.id,
			tunnelId: created.tunnelId,
			credentialsFile: created.credentialsFile,
			ingress: [{ hostname: opts.hostname, service: opts.service }]
		};
		this.ctx.store.upsertLocal(config);
		return config;
	}

	/** List every named tunnel on the authenticated Cloudflare account. */
	async list(): Promise<TunnelListEntry[]> {
		const binaryPath = this.ctx.requireBinary();
		return CloudflaredTunnel.listTunnels({ origincert: this.ctx.certPath, binaryPath });
	}

	// --- Running a local tunnel ---

	/** Write a cloudflared config.yml for a local tunnel and return its path. */
	writeConfig(config: Pick<LocalTunnelConfig, 'tunnelId' | 'credentialsFile' | 'ingress'>): string {
		const configDir = join(this.ctx.dataDir, config.tunnelId);
		if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

		const configPath = join(configDir, 'config.yml');
		const ingressRules = [
			...config.ingress.map((r) => `  - hostname: ${r.hostname}\n    service: ${r.service}`),
			'  - service: http_status:404'
		];
		const yml = [`tunnel: ${config.tunnelId}`, `credentials-file: ${config.credentialsFile}`, 'ingress:', ...ingressRules].join('\n');

		writeFileSync(configPath, yml, 'utf-8');
		this.ctx.log.log(`Config file written: ${configPath}`);
		return configPath;
	}

	async start(
		config: LocalTunnelConfig,
		onProgress?: ProgressCallback,
		opts?: { signal?: AbortSignal }
	): Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }> {
		onProgress?.('checking-binary');
		const binaryPath = this.ctx.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const running = this.tunnels.get(config.id);
		if (running) {
			return { ingress: running.ingress, timings };
		}

		if (config.ingress.length === 0) {
			throw new Error('Cannot start a local tunnel without ingress rules. Add at least one hostname mapping.');
		}

		const configPath = this.writeConfig(config);

		onProgress?.('starting-tunnel', { name: config.name });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.withConfig(configPath, binaryPath);
		const connections = new ConnectionTracker();
		tunnel.on('connected', (info) => {
			connections.apply(info, 'up');
			this.ctx.emitConnection(config.id, info, 'up');
		});
		tunnel.on('disconnected', (info) => {
			connections.apply(info, 'down');
			this.ctx.emitConnection(config.id, info, 'down');
		});
		tunnel.on('error', (error) => this.ctx.log.error(`[local:${config.name}] error:`, error));
		tunnel.on('exit', (code) => {
			this.ctx.log.log(`[local:${config.name}] exit code ${code}`);
			this.tunnels.delete(config.id);
			this.ctx.emitStatus();
		});

		onProgress?.('generating-url');

		await waitForStart<void>(tunnel, {
			timeoutMs: this.ctx.connectTimeoutMs,
			timeoutMessage: `Local tunnel connection timeout (${this.ctx.connectTimeoutMs}ms). Check config and credentials.`,
			failMessage: `Local tunnel "${config.name}" failed to start.`,
			signal: opts?.signal,
			attach: (succeed) => tunnel.once('connected', () => succeed())
		});

		timings.tunnelStart = Date.now() - startTime;

		this.tunnels.set(config.id, {
			tunnel,
			id: config.id,
			name: config.name,
			startedAt: new Date(),
			ingress: config.ingress.map((r) => ({ hostname: r.hostname, service: r.service })),
			connections
		});
		this.ctx.store.upsertLocal({
			id: config.id,
			name: config.name,
			tunnelId: config.tunnelId,
			credentialsFile: config.credentialsFile,
			ingress: config.ingress.map((r) => ({ hostname: r.hostname, service: r.service }))
		});

		this.ctx.log.log(`Local tunnel started: ${config.name}`);
		onProgress?.('connected', { timings });
		this.ctx.emitStatus();

		return { ingress: config.ingress, timings };
	}

	async stop(id: string): Promise<void> {
		const handle = this.tunnels.get(id);
		if (!handle) return;

		try {
			handle.tunnel.stop();
		} catch (err) {
			this.ctx.log.warn(`Failed to stop local tunnel ${handle.name}:`, err);
		}
		this.tunnels.delete(id);
		this.ctx.log.log(`Local tunnel stopped: ${handle.name}`);
		this.ctx.emitStatus();
	}

	isActive(id: string): boolean {
		return this.tunnels.has(id);
	}

	/** Snapshot of this mode's tunnels for the manager's aggregate `list()`. */
	snapshot(): ActiveTunnel[] {
		const tunnels: ActiveTunnel[] = [];
		for (const handle of this.tunnels.values()) {
			const firstHostname = handle.ingress.find((r) => r.hostname)?.hostname;
			tunnels.push({
				id: handle.id,
				type: 'local',
				publicUrl: firstHostname ? `https://${firstHostname}` : '',
				startedAt: handle.startedAt.toISOString(),
				name: handle.name,
				ingress: handle.ingress,
				connections: handle.connections.list()
			});
		}
		return tunnels;
	}

	/** Stop every local tunnel (used by `TunnelKit.stopAll`). */
	async stopAll(): Promise<void> {
		await Promise.all([...this.tunnels.keys()].map((id) => this.stop(id)));
	}
}
