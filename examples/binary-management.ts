/**
 * Case: manage the cloudflared binary explicitly.
 *
 * Check whether it's available and which version, install it (latest or a
 * pinned version), and find where it resolved from. Useful for a "System Tools"
 * settings screen.
 *
 * Run with:  bun run examples/binary-management.ts
 */

import { TunnelKit, defaultInstallDir, getBinaryStatus } from '../src/index.js';

const tk = new TunnelKit({ logger: console });

console.log('Default install dir:', defaultInstallDir());

// Free function form (no manager needed):
console.log('Status (function):', getBinaryStatus());

// Manager form (respects the manager's installDir):
let status = tk.getBinaryStatus();
console.log('Status (manager):', status);

if (!status.installed) {
	console.log('Installing latest cloudflared...');
	await tk.installBinary();
	// To pin a release instead: await tk.installBinary('2024.12.2');
	status = tk.getBinaryStatus();
}

console.log(`\ncloudflared ${status.version ?? '(unknown version)'} at ${status.path}`);
