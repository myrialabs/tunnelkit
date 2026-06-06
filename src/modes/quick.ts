/**
 * Quick tunnels — random `*.trycloudflare.com` URL, no account needed.
 *
 * The simplest mode: point it at a local port or service URL and get a public
 * URL back. Quick tunnels are ephemeral and never persisted. Reach this through
 * `tk.quick` on a {@link TunnelKit}.
 */

import { CloudflaredTunnel } from '../tunnel.js';
import type { ActiveTunnel, ProgressCallback } from '../types.js';
import { waitForStart, ConnectionTracker, type ManagerContext } from './shared.js';

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

interface QuickInstance {
	tunnel: CloudflaredTunnel;
	startedAt: Date;
	publicUrl: string;
	service: string;
	autoStopMinutes: number;
	autoStopTimer?: ReturnType<typeof setTimeout>;
	connections: ConnectionTracker;
}

export class QuickTunnels {
	private readonly tunnels = new Map<string, QuickInstance>();

	constructor(private readonly ctx: ManagerContext) {}

	async start(
		opts: { service: string | number; autoStopMinutes?: number; signal?: AbortSignal },
		onProgress?: ProgressCallback
	): Promise<{ id: string; service: string; publicUrl: string; timings: Record<string, number> }> {
		const service = resolveQuickService(opts.service);
		const id = `quick:${service}`;
		const autoStopMinutes = opts.autoStopMinutes ?? 0;
		onProgress?.('checking-binary');
		const binaryPath = this.ctx.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const existing = this.tunnels.get(service);
		if (existing) {
			return { id, service, publicUrl: existing.publicUrl, timings };
		}

		onProgress?.('starting-tunnel', { service });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.quick(service, binaryPath);
		const connections = new ConnectionTracker();
		tunnel.on('connected', (info) => {
			connections.apply(info, 'up');
			this.ctx.emitConnection(id, info, 'up');
		});
		tunnel.on('disconnected', (info) => {
			connections.apply(info, 'down');
			this.ctx.emitConnection(id, info, 'down');
		});
		tunnel.on('error', (error) => this.ctx.log.error(`[quick:${service}] error:`, error));
		tunnel.on('exit', (code) => {
			this.ctx.log.log(`[quick:${service}] exit code ${code}`);
			this.tunnels.delete(service);
			this.ctx.emitStatus();
		});

		onProgress?.('generating-url');

		const publicUrl = await waitForStart<string>(tunnel, {
			timeoutMs: this.ctx.quickTimeoutMs,
			timeoutMessage: `Tunnel connection timeout (${this.ctx.quickTimeoutMs}ms). Is ${service} reachable?`,
			failMessage: `Tunnel failed to start for ${service}.`,
			signal: opts.signal,
			// The first non-API trycloudflare URL is the public hostname.
			attach: (succeed) => tunnel.on('url', (url) => {
				if (!url.includes('api.trycloudflare.com')) succeed(url);
			})
		});

		timings.tunnelStart = Date.now() - startTime;

		let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
		if (autoStopMinutes > 0) {
			autoStopTimer = setTimeout(() => {
				this.ctx.log.log(`Auto-stopping quick tunnel for ${service}`);
				void this.stop(service);
			}, autoStopMinutes * 60 * 1000);
		}

		this.tunnels.set(service, {
			tunnel,
			publicUrl,
			service,
			startedAt: new Date(),
			autoStopMinutes,
			autoStopTimer,
			connections
		});

		this.ctx.log.log(`Quick tunnel started for ${service}: ${publicUrl}`);
		onProgress?.('connected', { publicUrl, timings });
		this.ctx.emitStatus();

		return { id, service, publicUrl, timings };
	}

	async stop(service: string | number): Promise<void> {
		const key = resolveQuickService(
			typeof service === 'string' && service.startsWith('quick:') ? service.slice('quick:'.length) : service
		);
		const instance = this.tunnels.get(key);
		if (!instance) return;

		if (instance.autoStopTimer) clearTimeout(instance.autoStopTimer);
		try {
			instance.tunnel.stop();
		} catch (err) {
			this.ctx.log.warn(`Failed to stop quick tunnel for ${key}:`, err);
		}
		this.tunnels.delete(key);
		this.ctx.log.log(`Quick tunnel stopped for ${key}`);
		this.ctx.emitStatus();
	}

	/** Whether a quick tunnel is running for the given port/service. */
	isActive(service: string | number): boolean {
		return this.tunnels.has(resolveQuickService(service));
	}

	/** Snapshot of this mode's tunnels for the manager's aggregate `list()`. */
	snapshot(): ActiveTunnel[] {
		const tunnels: ActiveTunnel[] = [];
		for (const [service, instance] of this.tunnels) {
			tunnels.push({
				id: `quick:${service}`,
				type: 'quick',
				service,
				publicUrl: instance.publicUrl,
				startedAt: instance.startedAt.toISOString(),
				autoStopMinutes: instance.autoStopMinutes,
				connections: instance.connections.list()
			});
		}
		return tunnels;
	}

	/** Stop every quick tunnel (used by `TunnelKit.stopAll`). */
	async stopAll(): Promise<void> {
		await Promise.all([...this.tunnels.keys()].map((service) => this.stop(service)));
	}
}
