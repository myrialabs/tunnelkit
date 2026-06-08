import { CloudflaredMissingError } from './cloudflared-tunnel.js';
import {
	resolveCloudflaredBinary,
	isBinaryInstalled,
	installBinary,
	getBinaryStatus,
	type BinaryStatus
} from './binary.js';
import type { Logger } from './logger.js';

/**
 * Binary management for a TunnelKit instance. Exposed as `tk.bin`.
 *
 * ```ts
 * await tk.bin.ensure();              // resolve, downloading on first use
 * tk.bin.status();                    // { installed, version, path }
 * await tk.bin.install('2024.12.2'); // pin a specific version
 * ```
 */
export class BinaryManager {
	constructor(
		private readonly installDir: string,
		private readonly log: Required<Logger>
	) {}

	/** Whether a managed cloudflared binary exists in `installDir`. */
	isInstalled(): boolean {
		return isBinaryInstalled(this.installDir);
	}

	/**
	 * Resolve a usable cloudflared binary, downloading on first use when none is
	 * found on PATH or in `installDir`. Returns the path; throws
	 * {@link CloudflaredMissingError} if the install attempt fails.
	 */
	async ensure(): Promise<string> {
		const resolved = resolveCloudflaredBinary(this.installDir);
		if (resolved) return resolved;
		this.log.log('cloudflared not found — downloading…');
		await this.install();
		const after = resolveCloudflaredBinary(this.installDir);
		if (!after) throw new CloudflaredMissingError();
		return after;
	}

	/** Download cloudflared into `installDir`. Omit `version` for latest. */
	async install(version = 'latest'): Promise<string> {
		return installBinary({ installDir: this.installDir, version, logger: this.log });
	}

	/** Resolved cloudflared status: `{ installed, version, path }`. */
	status(): BinaryStatus {
		return getBinaryStatus(this.installDir);
	}
}
