# Events & persistence

A `TunnelKit` instance is a typed `EventEmitter`, and it saves the tunnels you
start by default. Together these two things are what let an application
built on tunnelkit stay in sync with reality and survive a restart without
re-deriving its own tunnel state.

## Events

`TunnelKit` fires three events (full payload shapes in the
[API reference](../reference/api.md#events)):

- **`status-changed`** — fires whenever a tunnel starts, stops, or its
  connection count changes. Carries the full `tk.list()` snapshot, so
  listening to this alone is enough to build a live "what's running and how
  healthy" view.
- **`connection`** — fires as a single edge connection to Cloudflare comes up
  or goes down, with per-edge detail (ip, datacenter). Use this when
  `status-changed`'s aggregate view isn't granular enough.
- **`ingress-update`** — fires when a **Remote** tunnel's ingress rules sync
  from the Cloudflare dashboard (see [Tunnel modes](./tunnel-modes.md)).

```ts
tk.on('status-changed', (tunnels) => {
	console.log('Active:', tunnels.map((t) => t.id));
});

tk.on('connection', ({ id, info, status }) => {
	console.log(`[${id}] edge ${status}: ${info.location} (${info.ip})`);
});
```

Each `ActiveTunnel` in a `status-changed` payload carries its own live
`connections`, so you rarely need to correlate the two events — `connection`
exists for the cases where you specifically want per-edge detail as it
happens (e.g. a debug log), not as the primary way to track "is it up."

The low-level `CloudflaredTunnel` (used internally by every mode) emits its
own, lower-level events — `url`, `connected`, `disconnected`, `config`,
`error`, `exit`, `stdout`, `stderr` — described in
[Advanced usage](../guides/advanced-usage.md#low-level-cloudflaredtunnel).

## Persistence

Remote and local tunnels you start are saved automatically to
`<dataDir>/config.json` (default `~/.tunnelkit/config.json`, written `0600`).
**Quick tunnels are never saved** — they're ephemeral by design.

```ts
new TunnelKit(); // auto-save (default)
new TunnelKit({ store: false }); // disable persistence entirely
new TunnelKit({ store: myTunnelStore }); // bring your own TunnelStore instance
```

Read saved tunnels back through `tk.store`, or restore everything that was
running before a restart in one call:

```ts
const { remotes, locals } = await tk.restoreAll();
```

`TunnelStore` has no dependency on `TunnelKit` — it's a standalone JSON-file
persistence layer you can also use directly (e.g. to build your own "saved
tunnels" UI), which is exactly what the `tunnelkit saved`/`forget` CLI
commands do. See [`TunnelStore`](../reference/api.md#tunnelstore) for the
full method table.

## Where to next

- [Tunnel modes](./tunnel-modes.md) — what gets saved and when, per mode.
- [Binary management](../operations/binary-management.md) — the other piece
  of state tunnelkit manages for you.
- [API reference](../reference/api.md) — exhaustive event payloads and
  `TunnelStore` methods.
