/**
 * Cross-runtime `which`.
 *
 * Resolves an executable by scanning `$PATH`, without depending on any
 * runtime-specific API (works identically on Node and Bun). On Windows it
 * honors `PATHEXT` so `cloudflared` resolves to `cloudflared.exe`.
 */

import { existsSync, statSync } from 'fs';
import { join, delimiter } from 'path';

function isExecutableFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function which(binary: string): string | null {
	const isWindows = process.platform === 'win32';
	const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);

	const exts = isWindows
		? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
		: [''];

	for (const dir of dirs) {
		// Bare name first (covers an extensionless binary that's already on PATH).
		const bare = join(dir, binary);
		if (existsSync(bare) && isExecutableFile(bare)) return bare;

		if (isWindows) {
			for (const ext of exts) {
				const candidate = join(dir, binary + ext);
				if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
			}
		}
	}

	return null;
}
