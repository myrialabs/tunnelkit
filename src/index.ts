/**
 * tunnelkit — a zero-dependency, TypeScript-native toolkit for running
 * Cloudflare Tunnels (Quick, Remote, and Local) from Node or Bun.
 */

// High-level orchestration — start here.
export { TunnelKit } from './manager.js';
export type { TunnelKitOptions, TunnelKitEvents, LocalTunnelConfig } from './manager.js';

// Optional JSON-file persistence for tunnel configuration.
export { TunnelStore } from './store.js';
export type { TunnelStoreOptions, RemoteTunnelEntry, LocalTunnelEntry } from './store.js';

// Low-level process wrapper and one-shot commands.
export { CloudflaredTunnel, CloudflaredMissingError } from './tunnel.js';
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
} from './tunnel.js';

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
export type { TunnelType, IngressInfo, ActiveTunnel, ProgressStage, ProgressCallback } from './types.js';
