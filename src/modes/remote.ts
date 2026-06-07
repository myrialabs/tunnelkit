/**
 * Remote tunnels — dashboard-managed, run from a token.
 *
 * A remote tunnel is created and configured in the Cloudflare Zero Trust
 * dashboard; tunnelkit just runs it from its token. Ingress (which hostnames
 * map to which services) is pushed by Cloudflare at runtime and surfaced via
 * the `ingress-update` event. Reach this through `tk.remote` on a
 * {@link TunnelKit}.
 */

import { CloudflaredTunnel } from '../cloudflared-tunnel.js';
import type { ActiveTunnel, IngressInfo, ProgressCallback } from '../types.js';
import { waitForStart, ConnectionTracker, type ManagerContext } from './context.js';

interface RemoteTunnelHandle {
	tunnel: CloudflaredTunnel;
	startedAt: Date;
	id: string;
	name: string;
	ingress: IngressInfo[];
	connections: ConnectionTracker;
}

export class RemoteMode {
	private readonly tunnels = new Map<string, RemoteTunnelHandle>();

	constructor(private readonly ctx: ManagerContext) {}

	async start(
		opts: { id: string; token: string; name?: string; signal?: AbortSignal },
		onProgress?: ProgressCallback
	): Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }> {
		const name = opts.name ?? opts.id;
		onProgress?.('checking-binary');
		const binaryPath = this.ctx.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const running = this.tunnels.get(opts.id);
		if (running) {
			return { ingress: running.ingress, timings };
		}

		onProgress?.('starting-tunnel', { name });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.withToken(opts.token, binaryPath);
		const handle: RemoteTunnelHandle = {
			tunnel,
			id: opts.id,
			name,
			startedAt: new Date(),
			ingress: [],
			connections: new ConnectionTracker()
		};

		tunnel.on('config', (data) => {
			if (data.config?.ingress && Array.isArray(data.config.ingress)) {
				handle.ingress = data.config.ingress.map((rule: { hostname?: string; service: string }) => ({
					hostname: rule.hostname,
					service: rule.service
				}));
				this.ctx.log.log(`[remote:${name}] config synced, ${handle.ingress.length} ingress rules`);
				this.ctx.emitIngress(opts.id, handle.ingress);
			}
		});
		tunnel.on('connected', (info) => {
			handle.connections.apply(info, 'up');
			this.ctx.emitConnection(opts.id, info, 'up');
		});
		tunnel.on('disconnected', (info) => {
			handle.connections.apply(info, 'down');
			this.ctx.emitConnection(opts.id, info, 'down');
		});
		tunnel.on('error', (error) => this.ctx.log.error(`[remote:${name}] error:`, error));
		tunnel.on('exit', (code) => {
			this.ctx.log.log(`[remote:${name}] exit code ${code}`);
			this.tunnels.delete(opts.id);
			this.ctx.emitStatus();
		});

		onProgress?.('generating-url');

		await waitForStart<void>(tunnel, {
			timeoutMs: this.ctx.connectTimeoutMs,
			timeoutMessage: `Remote tunnel connection timeout (${this.ctx.connectTimeoutMs}ms). Check the token.`,
			failMessage: 'Remote tunnel failed to start. Verify the token.',
			signal: opts.signal,
			attach: (succeed) => tunnel.once('connected', () => succeed())
		});

		timings.tunnelStart = Date.now() - startTime;
		this.tunnels.set(opts.id, handle);
		this.ctx.store.upsertRemote(opts.id, name, opts.token);

		this.ctx.log.log(`Remote tunnel started: ${name}`);
		onProgress?.('connected', { timings });
		this.ctx.emitStatus();

		return { ingress: handle.ingress, timings };
	}

	async stop(id: string): Promise<void> {
		const handle = this.tunnels.get(id);
		if (!handle) return;

		try {
			handle.tunnel.stop();
		} catch (err) {
			this.ctx.log.warn(`Failed to stop remote tunnel ${handle.name}:`, err);
		}
		this.tunnels.delete(id);
		this.ctx.log.log(`Remote tunnel stopped: ${handle.name}`);
		this.ctx.emitStatus();
	}

	/** The most recent ingress rules pushed by Cloudflare for a running tunnel. */
	ingress(id: string): IngressInfo[] {
		return this.tunnels.get(id)?.ingress ?? [];
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
				type: 'remote',
				publicUrl: firstHostname ? `https://${firstHostname}` : '',
				startedAt: handle.startedAt.toISOString(),
				name: handle.name,
				ingress: handle.ingress,
				connections: handle.connections.list()
			});
		}
		return tunnels;
	}

	/** Stop every remote tunnel (used by `TunnelKit.stopAll`). */
	async stopAll(): Promise<void> {
		await Promise.all([...this.tunnels.keys()].map((id) => this.stop(id)));
	}
}
