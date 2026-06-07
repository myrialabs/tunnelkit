/**
 * Shared plumbing for the per-mode controllers.
 *
 * Each mode ({@link QuickMode}, {@link RemoteMode}, {@link LocalMode})
 * is a thin facade that owns its own registry but leans on a common
 * {@link ManagerContext} for everything cross-cutting: binary resolution,
 * persistence, event emission, and the data directory. `TunnelKit` builds the
 * context and wires the three facades together — see `tunnelkit.ts`.
 */

import type { CloudflaredTunnel, ConnectionInfo } from '../cloudflared-tunnel.js';
import type { Logger } from '../logger.js';
import type { TunnelStore } from '../store.js';
import type { IngressInfo, ProgressCallback } from '../types.js';

/** State and helpers the per-mode controllers need from the owning manager. */
export interface ManagerContext {
	/** Directory for cert.pem, tunnel credentials, and generated configs. */
	readonly dataDir: string;
	/** Directory holding the managed cloudflared binary. */
	readonly installDir: string;
	/** Resolved (never-undefined) logger. */
	readonly log: Required<Logger>;
	/** Quick-tunnel URL timeout in ms. */
	readonly quickTimeoutMs: number;
	/** Remote/local connection timeout in ms. */
	readonly connectTimeoutMs: number;
	/** Predicate used during name-conflict recovery (see TunnelKitOptions). */
	readonly isTunnelKnown: (tunnelId: string) => boolean;
	/** The persistence store backing auto-save, or `null` when disabled. */
	readonly store: TunnelStore | null;
	/** Path to the origin certificate this manager uses. */
	readonly certPath: string;
	/** cloudflared's default cert location, migrated into `dataDir` on first use. */
	readonly defaultCloudflaredCert: string;
	/** Resolve a usable binary path or throw {@link CloudflaredMissingError}. */
	requireBinary(onProgress?: ProgressCallback): string;
	/** Re-emit the aggregate `status-changed` event for the whole manager. */
	emitStatus(): void;
	/** Emit a remote `ingress-update` event. */
	emitIngress(id: string, ingress: IngressInfo[]): void;
	/** Emit a `connection` up/down event as edge connections come and go. */
	emitConnection(id: string, info: ConnectionInfo, status: 'up' | 'down'): void;
	/** Create `dataDir` if it does not yet exist. */
	ensureDataDir(): void;
}

/**
 * Tracks the live edge connections for a single tunnel, keyed by connection id.
 * cloudflared opens several HA connections once a tunnel goes live, so a
 * non-empty tracker means the tunnel is actually reachable over the edge. Each
 * mode keeps one per running tunnel and surfaces it in its `snapshot()`.
 */
export class ConnectionTracker {
	private readonly live = new Map<string, ConnectionInfo>();

	/** Record a connection coming up (`'up'`) or going down (`'down'`). */
	apply(info: ConnectionInfo, status: 'up' | 'down'): void {
		if (status === 'up') this.live.set(info.id, info);
		else this.live.delete(info.id);
	}

	/** The connections currently live, in insertion order. */
	list(): ConnectionInfo[] {
		return [...this.live.values()];
	}
}

export interface WaitForStartOptions<T> {
	timeoutMs: number;
	timeoutMessage: string;
	failMessage: string;
	attach: (succeed: (value: T) => void) => void;
	/** Abort the start early (stops the process and rejects with an `AbortError`). */
	signal?: AbortSignal;
}

/** Rejection reason when a start is aborted via its `AbortSignal`. */
export class AbortError extends Error {
	constructor() {
		super('Aborted');
		this.name = 'AbortError';
	}
}

/**
 * Await a tunnel reaching its "started" state. Resolves with the value passed
 * to `succeed` (e.g. the public URL), or rejects on timeout, process error, a
 * non-zero early exit, or an abort signal — stopping the process in every
 * failure path.
 */
export function waitForStart<T>(tunnel: CloudflaredTunnel, opts: WaitForStartOptions<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;

		const onAbort = (): void => finish(() => {
			tunnel.stop();
			reject(new AbortError());
		});

		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			action();
		};

		if (opts.signal?.aborted) {
			onAbort();
			return;
		}
		opts.signal?.addEventListener('abort', onAbort, { once: true });

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
