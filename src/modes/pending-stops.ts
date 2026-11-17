/**
 * Stops still in flight, per tunnel key.
 *
 * Stopping a tunnel ends a cloudflared process, which drains its connections
 * before it exits — seconds, not instantly. Starting the same tunnel again in
 * that window ran two connectors for one tunnel, and the old process's late
 * `exit` removed the new tunnel from the list. A start for a key first waits
 * for that key's stop to finish.
 */
export class PendingStops<K> {
	private readonly pending = new Map<K, Promise<void>>();

	/** Remember `stopped` for `key` until it settles; returns it. */
	track(key: K, stopped: Promise<void>): Promise<void> {
		const settled = stopped.finally(() => {
			if (this.pending.get(key) === settled) this.pending.delete(key);
		});
		this.pending.set(key, settled);
		return settled;
	}

	/** Resolves once no stop for `key` is in flight. */
	async wait(key: K): Promise<void> {
		await this.pending.get(key);
	}
}
