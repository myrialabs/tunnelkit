/**
 * TunnelKit
 *
 * High-level orchestration for the three Cloudflare Tunnel modes, each exposed
 * as its own namespace so it's always clear which mode an operation belongs to:
 *
 * - **`tk.quick`**  — random `*.trycloudflare.com` URL, no account needed.
 * - **`tk.remote`** — dashboard-managed tunnel run from a token; ingress is
 *                     synced from cloudflared's config push.
 * - **`tk.local`**  — locally-managed named tunnel (login → create → route DNS →
 *                     run from a generated config file). The only mode that
 *                     touches your Cloudflare account, so `login`, `list`,
 *                     `delete`, etc. all live under `tk.local`.
 *
 * The manager owns the cross-cutting concerns: the cloudflared binary, an
 * aggregate registry/`list()` across all modes, and events. By default it also
 * **persists** the remote and local tunnels you start (to `<dataDir>/config.json`),
 * so you can restore them later through `tk.store`. Set `dataDir` to change where
 * that lives, or pass `store: false` to disable it. Quick tunnels are ephemeral
 * and never saved.
 *
 * Emits:
 * - 'status-changed' (tunnels: ActiveTunnel[])      whenever a tunnel starts/stops
 * - 'ingress-update' ({ id, ingress })              when a remote tunnel's ingress syncs
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CloudflaredMissingError } from './tunnel.js';
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
import type { ActiveTunnel, IngressInfo, ProgressCallback } from './types.js';
import type { ManagerContext } from './modes/shared.js';
import { QuickTunnels, resolveQuickService } from './modes/quick.js';
import { RemoteTunnels } from './modes/remote.js';
import { LocalTunnels, type LocalTunnelConfig } from './modes/local.js';

// Re-exported so existing imports (`from 'tunnelkit'` / `./manager.js`) keep working.
export { resolveQuickService };
export type { LocalTunnelConfig };

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

	/** Quick tunnels — `tk.quick.start(...)`, `tk.quick.stop(...)`. */
	readonly quick: QuickTunnels;
	/** Remote (token-based) tunnels — `tk.remote.start(...)`, etc. */
	readonly remote: RemoteTunnels;
	/** Local (named) tunnels and all account operations — `tk.local.login(...)`, etc. */
	readonly local: LocalTunnels;

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

		const ctx: ManagerContext = {
			dataDir: this.dataDir,
			installDir: this.installDir,
			log: this.log,
			quickTimeoutMs: this.quickTimeoutMs,
			connectTimeoutMs: this.connectTimeoutMs,
			isTunnelKnown: this.isTunnelKnown,
			store: this._store,
			certPath: this.certPath,
			defaultCloudflaredCert: this.defaultCloudflaredCert,
			requireBinary: (onProgress) => this.requireBinary(onProgress),
			emitStatus: () => this.emitStatus(),
			emitIngress: (id, ingress) => void this.emit('ingress-update', { id, ingress }),
			ensureDataDir: () => this.ensureDataDir()
		};

		this.quick = new QuickTunnels(ctx);
		this.remote = new RemoteTunnels(ctx);
		this.local = new LocalTunnels(ctx);
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

	// --- Status / lifecycle ---

	/** Snapshot of every tunnel currently managed, across all three modes. */
	list(): ActiveTunnel[] {
		return [...this.quick.snapshot(), ...this.remote.snapshot(), ...this.local.snapshot()];
	}

	/** Stop every managed tunnel. */
	async stopAll(): Promise<void> {
		this.log.log('Stopping all tunnels...');
		await Promise.all([this.quick.stopAll(), this.remote.stopAll(), this.local.stopAll()]);
		this.log.log('All tunnels stopped');
	}
}
