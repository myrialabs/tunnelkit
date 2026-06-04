/**
 * TunnelStore — JSON-file persistence for tunnel configuration.
 *
 * This is the persistence layer the `tunnelkit` CLI uses by default, so saved
 * tunnels can be reused by name. It persists remote tokens, local tunnel records
 * (id, name, tunnelId, credentials, ingress rules), and an authorized DNS zone
 * to a single JSON file (`<dataDir>/config.json`, written `0600`).
 *
 * `TunnelKit` itself stays stateless about *which* tunnels you have configured,
 * and `TunnelStore` has no dependency on it — so when embedding the library you
 * can compose the two yourself, or bring your own storage (a database, env vars,
 * etc.).
 */

import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveLogger, type Logger } from './logger.js';
import type { IngressInfo } from './types.js';

export interface RemoteTunnelEntry {
	id: string;
	label: string;
	token: string;
}

export interface LocalTunnelEntry {
	id: string;
	name: string;
	tunnelId: string;
	credentialsFile: string;
	ingress: IngressInfo[];
}

interface StoreFile {
	remotes: RemoteTunnelEntry[];
	locals: LocalTunnelEntry[];
	authorizedZone?: string;
}

export interface TunnelStoreOptions {
	/** Directory holding `config.json`. Default: `~/.tunnelkit`. */
	dataDir?: string;
	/** Optional logger; silent when omitted. */
	logger?: Logger;
}

export class TunnelStore {
	private readonly file: string;
	private readonly dir: string;
	private readonly log: Required<Logger>;

	constructor(options: TunnelStoreOptions = {}) {
		this.dir = options.dataDir ?? join(homedir(), '.tunnelkit');
		this.file = join(this.dir, 'config.json');
		this.log = resolveLogger(options.logger);
	}

	/** Absolute path to the backing JSON file. */
	get path(): string {
		return this.file;
	}

	private read(): StoreFile {
		try {
			if (!existsSync(this.file)) return { remotes: [], locals: [] };
			const data = JSON.parse(readFileSync(this.file, 'utf-8'));
			return {
				remotes: Array.isArray(data.remotes) ? data.remotes : [],
				locals: Array.isArray(data.locals) ? data.locals : [],
				authorizedZone: data.authorizedZone
			};
		} catch (error) {
			this.log.error('Failed to read tunnel store:', error);
			return { remotes: [], locals: [] };
		}
	}

	private write(data: StoreFile): void {
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
		// The store can hold tunnel tokens — keep it readable only by the owner.
		// `mode` on writeFileSync only applies when the file is first created, so
		// chmod explicitly to also tighten a pre-existing file.
		writeFileSync(this.file, JSON.stringify(data, null, '\t'), { encoding: 'utf-8', mode: 0o600 });
		try {
			chmodSync(this.file, 0o600);
		} catch {
			// Best-effort: some filesystems/platforms (e.g. Windows) don't support it.
		}
	}

	// --- Remote tunnels ---

	getRemotes(): RemoteTunnelEntry[] {
		return this.read().remotes;
	}

	getRemote(id: string): RemoteTunnelEntry | null {
		return this.read().remotes.find((r) => r.id === id) ?? null;
	}

	addRemote(label: string, token: string): RemoteTunnelEntry {
		const data = this.read();
		const entry: RemoteTunnelEntry = { id: randomUUID(), label, token };
		data.remotes.push(entry);
		this.write(data);
		this.log.log(`Remote tunnel config added: ${label}`);
		return entry;
	}

	/** Insert or update a remote entry keyed by a caller-supplied `id` (used by auto-save). */
	upsertRemote(id: string, label: string, token: string): RemoteTunnelEntry {
		const data = this.read();
		const existing = data.remotes.find((r) => r.id === id);
		const entry: RemoteTunnelEntry = { id, label, token };
		if (existing) Object.assign(existing, entry);
		else data.remotes.push(entry);
		this.write(data);
		this.log.log(`Remote tunnel config saved: ${label}`);
		return existing ?? entry;
	}

	removeRemote(id: string): boolean {
		const data = this.read();
		const before = data.remotes.length;
		data.remotes = data.remotes.filter((r) => r.id !== id);
		if (data.remotes.length === before) return false;
		this.write(data);
		this.log.log(`Remote tunnel config removed: ${id}`);
		return true;
	}

	// --- Local tunnels ---

	getLocals(): LocalTunnelEntry[] {
		return this.read().locals;
	}

	getLocal(id: string): LocalTunnelEntry | null {
		return this.read().locals.find((l) => l.id === id) ?? null;
	}

	addLocal(name: string, tunnelId: string, credentialsFile: string): LocalTunnelEntry {
		const data = this.read();
		const entry: LocalTunnelEntry = { id: randomUUID(), name, tunnelId, credentialsFile, ingress: [] };
		data.locals.push(entry);
		this.write(data);
		this.log.log(`Local tunnel config added: ${name} (${tunnelId})`);
		return entry;
	}

	/** Insert or replace a local entry keyed by `entry.id` (used by auto-save). */
	upsertLocal(entry: LocalTunnelEntry): LocalTunnelEntry {
		const data = this.read();
		const index = data.locals.findIndex((l) => l.id === entry.id);
		if (index >= 0) data.locals[index] = entry;
		else data.locals.push(entry);
		this.write(data);
		this.log.log(`Local tunnel config saved: ${entry.name} (${entry.tunnelId})`);
		return entry;
	}

	removeLocal(id: string): boolean {
		const data = this.read();
		const before = data.locals.length;
		data.locals = data.locals.filter((l) => l.id !== id);
		if (data.locals.length === before) return false;
		this.write(data);
		this.log.log(`Local tunnel config removed: ${id}`);
		return true;
	}

	/** Add or update an ingress rule (matched by hostname). Returns the updated entry. */
	addLocalIngress(id: string, hostname: string, service: string): LocalTunnelEntry | null {
		const data = this.read();
		const config = data.locals.find((l) => l.id === id);
		if (!config) return null;

		const existing = config.ingress.findIndex((r) => r.hostname === hostname);
		if (existing >= 0) {
			config.ingress[existing].service = service;
		} else {
			config.ingress.push({ hostname, service });
		}
		this.write(data);
		this.log.log(`Ingress rule set for ${config.name}: ${hostname} -> ${service}`);
		return config;
	}

	removeLocalIngress(id: string, hostname: string): LocalTunnelEntry | null {
		const data = this.read();
		const config = data.locals.find((l) => l.id === id);
		if (!config) return null;

		config.ingress = config.ingress.filter((r) => r.hostname !== hostname);
		this.write(data);
		this.log.log(`Ingress rule removed for ${config.name}: ${hostname}`);
		return config;
	}

	// --- Authorized zone ---

	getZone(): string | null {
		return this.read().authorizedZone ?? null;
	}

	setZone(zone: string): void {
		const data = this.read();
		data.authorizedZone = zone;
		this.write(data);
		this.log.log(`Authorized zone set: ${zone}`);
	}

	clearZone(): void {
		const data = this.read();
		delete data.authorizedZone;
		this.write(data);
		this.log.log('Authorized zone cleared');
	}
}
