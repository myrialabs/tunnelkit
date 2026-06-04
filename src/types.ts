/** The three kinds of Cloudflare Tunnel tunnelkit can run. */
export type TunnelType = 'quick' | 'remote' | 'local';

/** A single ingress mapping (public hostname → local service). */
export interface IngressInfo {
	hostname?: string;
	service: string;
}

/** A tunnel currently being managed by a {@link TunnelKit}. */
export interface ActiveTunnel {
	/** Stable identifier: `quick:<service>` for quick tunnels, or the caller-supplied id. */
	id: string;
	type: TunnelType;
	/** Resolved local service for quick tunnels (e.g. `http://localhost:3000`); absent for remote/local (ingress-driven). */
	service?: string;
	/** Best-effort public URL (TryCloudflare URL, or `https://<first-hostname>`). */
	publicUrl: string;
	/** ISO timestamp of when the tunnel started. */
	startedAt: string;
	/** Minutes until auto-stop (quick tunnels only); absent or `0` means no auto-stop. */
	autoStopMinutes?: number;
	/** Friendly label/name for remote/local tunnels. */
	label?: string;
	/** Ingress rules for remote/local tunnels. */
	ingress?: IngressInfo[];
}

/** Progress stages emitted during a tunnel start, for UI feedback. */
export type ProgressStage =
	| 'checking-binary'
	| 'binary-ready'
	| 'starting-tunnel'
	| 'generating-url'
	| 'connected';

/** Progress callback passed to start methods. */
export type ProgressCallback = (stage: ProgressStage, data?: Record<string, unknown>) => void;
