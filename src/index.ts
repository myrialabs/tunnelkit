/**
 * tunnelkit — run Cloudflare Tunnels (Quick, Remote, and Local) from Node or
 * Bun. A typed API and CLI over the `cloudflared` binary, with zero dependencies.
 */

// High-level orchestration — start here.
export { TunnelKit, CLOUDFLARE_TUNNELS_DASHBOARD_URL } from './tunnelkit.js';
export type { TunnelKitOptions, TunnelKitEvents } from './tunnelkit.js';
export { BinaryManager } from './binary-manager.js';

// JSON-file persistence for tunnel configuration (used by the CLI by default).
export { TunnelStore } from './store.js';
export type { TunnelStoreOptions } from './store.js';

// Low-level process wrapper and one-shot commands.
export { CloudflaredTunnel, CloudflaredMissingError } from './cloudflared-tunnel.js';
export type {
	CloudflaredTunnelEvents,
	ConnectionInfo,
	LoginHandle,
	LoginCallbacks,
	LoginOptions,
	CreateTunnelOptions,
	CreateTunnelResult,
	DeleteTunnelOptions,
	DeleteTunnelResult,
	RouteDnsOptions,
	RouteDnsResult,
	ListTunnelsOptions,
	TunnelListEntry
} from './cloudflared-tunnel.js';

// Binary management.
export {
	installBinary,
	isBinaryInstalled,
	resolveCloudflaredBinary,
	getBinaryPath,
	getBinaryStatus,
	getBinaryVersion,
	defaultInstallDir
} from './binary.js';
export type { InstallBinaryOptions, BinaryStatus } from './binary.js';

// Utilities and shared types.
export { which } from './which.js';
export { noopLogger } from './logger.js';
export type { Logger } from './logger.js';
export type {
	TunnelType,
	IngressInfo,
	ActiveTunnel,
	ProgressStage,
	ProgressCallback,
	RemoteTunnelConfig,
	LocalTunnelConfig
} from './types.js';
