/**
 * Cloudflared Binary Manager
 *
 * Resolves and (optionally) downloads the `cloudflared` binary.
 *
 * Resolution order:
 *   1. A managed install under `installDir` (default `~/.tunnelkit/bin`).
 *   2. Any `cloudflared` already on `$PATH` (brew/apt/winget), so users who
 *      have it installed system-wide don't have to download again.
 *
 * `installBinary()` downloads the platform/arch-appropriate build from GitHub
 * releases. It is never called automatically — callers decide when to install.
 */

import { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform, arch } from 'os';
import { execFileSync } from 'child_process';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';
import { which } from './which.js';
import { resolveLogger, type Logger } from './logger.js';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/';

/** Platform-specific download filenames. */
const LINUX_FILES: Record<string, string> = {
	arm64: 'cloudflared-linux-arm64',
	arm: 'cloudflared-linux-arm',
	x64: 'cloudflared-linux-amd64',
	ia32: 'cloudflared-linux-386'
};

const MACOS_FILES: Record<string, string> = {
	arm64: 'cloudflared-darwin-arm64.tgz',
	x64: 'cloudflared-darwin-amd64.tgz'
};

const WINDOWS_FILES: Record<string, string> = {
	x64: 'cloudflared-windows-amd64.exe',
	ia32: 'cloudflared-windows-386.exe'
};

/** Default directory holding the managed binary: `~/.tunnelkit/bin`. */
export function defaultInstallDir(): string {
	return join(homedir(), '.tunnelkit', 'bin');
}

/** Path where the managed `cloudflared` binary lives within `installDir`. */
export function getBinaryPath(installDir: string = defaultInstallDir()): string {
	const name = platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
	return join(installDir, name);
}

/** Whether a managed binary exists in `installDir`. */
export function isBinaryInstalled(installDir: string = defaultInstallDir()): boolean {
	return existsSync(getBinaryPath(installDir));
}

/**
 * Resolve an executable `cloudflared`. Prefers the managed install in
 * `installDir`; falls back to any `cloudflared` on `$PATH`. Returns `null`
 * when nothing is found.
 */
export function resolveCloudflaredBinary(installDir: string = defaultInstallDir()): string | null {
	const managed = getBinaryPath(installDir);
	if (existsSync(managed)) return managed;
	return which('cloudflared');
}

/** Download a file via HTTPS, following redirects. */
function download(url: string, to: string, redirect = 0): Promise<string> {
	if (redirect > 10) {
		return Promise.reject(new Error('Too many redirects'));
	}

	const dir = dirname(to);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	return new Promise((resolve, reject) => {
		const httpGetter = url.startsWith('https') ? httpsGet : httpGet;

		const request = httpGetter(url, (res) => {
			const redirectCodes = [301, 302, 303, 307, 308];
			if (res.statusCode && redirectCodes.includes(res.statusCode) && res.headers.location) {
				request.destroy();
				resolve(download(res.headers.location, to, redirect + 1));
				return;
			}

			if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
				const file = createWriteStream(to);
				file.on('finish', () => file.close(() => resolve(to)));
				file.on('error', (err: Error) => {
					try {
						unlinkSync(to);
					} catch {
						/* ignore */
					}
					reject(err);
				});
				res.pipe(file);
			} else {
				request.destroy();
				reject(new Error(`HTTP ${res.statusCode} downloading cloudflared`));
			}
		});

		request.on('error', (err: Error) => reject(err));
		request.end();
	});
}

/** Get the download URL for the current platform/arch. */
function getDownloadUrl(version = 'latest'): string {
	const base = version === 'latest' ? `${RELEASE_BASE}latest/download/` : `${RELEASE_BASE}download/${version}/`;

	const os = platform();
	const a = arch();

	if (os === 'linux') {
		const file = LINUX_FILES[a];
		if (!file) throw new Error(`Unsupported Linux architecture: ${a}`);
		return base + file;
	}

	if (os === 'darwin') {
		const file = MACOS_FILES[a];
		if (!file) throw new Error(`Unsupported macOS architecture: ${a}`);
		return base + file;
	}

	if (os === 'win32') {
		const file = WINDOWS_FILES[a];
		if (!file) throw new Error(`Unsupported Windows architecture: ${a}`);
		return base + file;
	}

	throw new Error(`Unsupported platform: ${os}`);
}

export interface InstallBinaryOptions {
	/** Directory to install into. Default: `~/.tunnelkit/bin`. */
	installDir?: string;
	/** Release tag to install (e.g. `2024.1.0`), or `latest`. Default: `latest`. */
	version?: string;
	/** Optional logger for download diagnostics. */
	logger?: Logger;
}

/** Download and install `cloudflared` for the current platform. */
export async function installBinary(options: InstallBinaryOptions = {}): Promise<string> {
	const installDir = options.installDir ?? defaultInstallDir();
	const version = options.version ?? 'latest';
	const log = resolveLogger(options.logger);

	const binPath = getBinaryPath(installDir);
	const url = getDownloadUrl(version);
	const os = platform();

	log.log(`Downloading cloudflared from ${url}`);

	if (os === 'darwin') {
		// macOS ships a .tgz: download, extract, rename.
		const tgzPath = `${binPath}.tgz`;
		await download(url, tgzPath);
		execFileSync('tar', ['-xzf', tgzPath], { cwd: dirname(binPath), stdio: 'pipe' });
		unlinkSync(tgzPath);
		// tar extracts as "cloudflared" in the same directory.
		const extractedPath = join(dirname(binPath), 'cloudflared');
		if (extractedPath !== binPath && existsSync(extractedPath)) {
			renameSync(extractedPath, binPath);
		}
	} else if (os === 'linux') {
		await download(url, binPath);
		chmodSync(binPath, '755');
	} else if (os === 'win32') {
		await download(url, binPath);
	}

	if (!existsSync(binPath)) {
		throw new Error('Binary was not created after installation');
	}

	log.log(`cloudflared installed at: ${binPath}`);
	return binPath;
}

/** Resolved status of the cloudflared binary. */
export interface BinaryStatus {
	installed: boolean;
	/** Parsed version string (e.g. `2024.12.2`), or `null` if it couldn't be read. */
	version: string | null;
	/** Resolved binary path, or `null` when not found. */
	path: string | null;
}

/** Read the version of a cloudflared binary by running `--version`. */
export function getBinaryVersion(binaryPath: string): string | null {
	try {
		const out = execFileSync(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
		// e.g. "cloudflared version 2024.12.2 (built 2024-...)"
		const match = out.match(/version\s+(\S+)/i);
		return match ? match[1] : out.trim().split(/\s+/)[0] || null;
	} catch {
		return null;
	}
}

/** Whether cloudflared is available, with its version and resolved path. */
export function getBinaryStatus(installDir: string = defaultInstallDir()): BinaryStatus {
	const path = resolveCloudflaredBinary(installDir);
	if (!path) return { installed: false, version: null, path: null };
	return { installed: true, version: getBinaryVersion(path), path };
}
