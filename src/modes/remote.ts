/**
 * Remote tunnels — dashboard-managed, run from a token.
 *
 * A remote tunnel is created and configured in the Cloudflare Zero Trust
 * dashboard; tunnelkit just runs it from its token. Ingress (which hostnames
 * map to which services) is pushed by Cloudflare at runtime and surfaced via
 * the `ingress-update` event. Reach this through `tk.remote` on a
 * {@link TunnelKit}.
 */

import { CloudflaredTunnel } from '../tunnel.js';
import type { ActiveTunnel, IngressInfo, ProgressCallback } from '../types.js';
import { waitForStart, ConnectionTracker, type ManagerContext } from './shared.js';

interface RemoteInstance {
	tunnel: CloudflaredTunnel;
	startedAt: Date;
	id: string;
	label: string;
	ingress: IngressInfo[];
	connections: ConnectionTracker;
}

export class RemoteTunnels {
	private readonly tunnels = new Map<string, RemoteInstance>();

	constructor(private readonly ctx: ManagerContext) {}

	async start(
		opts: { id: string; token: string; label?: string; signal?: AbortSignal },
		onProgress?: ProgressCallback
	): Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }> {
		const label = opts.label ?? opts.id;
		onProgress?.('checking-binary');
		const binaryPath = this.ctx.requireBinary(onProgress);
		const timings: Record<string, number> = {};

		const running = this.tunnels.get(opts.id);
		if (running) {
			return { ingress: running.ingress, timings };
		}

		onProgress?.('starting-tunnel', { label });
		const startTime = Date.now();

		const tunnel = CloudflaredTunnel.withToken(opts.token, binaryPath);
		const instance: RemoteInstance = {
			tunnel,
			id: opts.id,
			label,
			startedAt: new Date(),
			ingress: [],
			connections: new ConnectionTracker()
		};

		tunnel.on('config', (data) => {
			if (data.config?.ingress && Array.isArray(data.config.ingress)) {
				instance.ingress = data.config.ingress.map((rule: { hostname?: string; service: string }) => ({
					hostname: rule.hostname,
					service: rule.service
				}));
				this.ctx.log.log(`[remote:${label}] config synced, ${instance.ingress.length} ingress rules`);
				this.ctx.emitIngress(opts.id, instance.ingress);
			}
		});
		tunnel.on('connected', (info) => {
			instance.connections.apply(info, 'up');
			this.ctx.emitConnection(opts.id, info, 'up');
		});
		tunnel.on('disconnected', (info) => {
			instance.connections.apply(info, 'down');
			this.ctx.emitConnection(opts.id, info, 'down');
		});
		tunnel.on('error', (error) => this.ctx.log.error(`[remote:${label}] error:`, error));
		tunnel.on('exit', (code) => {
			this.ctx.log.log(`[remote:${label}] exit code ${code}`);
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
		this.tunnels.set(opts.id, instance);
		this.ctx.store?.upsertRemote(opts.id, label, opts.token);

		this.ctx.log.log(`Remote tunnel started: ${label}`);
		onProgress?.('connected', { timings });
		this.ctx.emitStatus();

		return { ingress: instance.ingress, timings };
	}

	async stop(id: string): Promise<void> {
		const instance = this.tunnels.get(id);
		if (!instance) return;

		try {
			instance.tunnel.stop();
		} catch (err) {
			this.ctx.log.warn(`Failed to stop remote tunnel ${instance.label}:`, err);
		}
		this.tunnels.delete(id);
		this.ctx.log.log(`Remote tunnel stopped: ${instance.label}`);
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
		for (const instance of this.tunnels.values()) {
			const firstHostname = instance.ingress.find((r) => r.hostname)?.hostname;
			tunnels.push({
				id: instance.id,
				type: 'remote',
				publicUrl: firstHostname ? `https://${firstHostname}` : '',
				startedAt: instance.startedAt.toISOString(),
				label: instance.label,
				ingress: instance.ingress,
				connections: instance.connections.list()
			});
		}
		return tunnels;
	}

	/** Stop every remote tunnel (used by `TunnelKit.stopAll`). */
	async stopAll(): Promise<void> {
		await Promise.all([...this.tunnels.keys()].map((id) => this.stop(id)));
	}
}
