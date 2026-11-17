# Tunnel modes

tunnelkit runs all three kinds of Cloudflare Tunnel, each behind its own
namespace on a `TunnelKit` instance (`tk.quick`, `tk.remote`, `tk.local`), and
its own CLI subcommand. This page explains what each mode is, when to reach
for it, and how the same shape (`start`/`stop`/`isActive`/`snapshot`) shows up
in all three.

| Mode | Needs a Cloudflare account? | Persisted by default? | Use it for |
| --- | --- | --- | --- |
| **Quick** | No | No — ephemeral | Demos, webhooks, one-off previews |
| **Remote** | Yes, but config lives in the dashboard | Yes | Tunnels you configure once in Cloudflare Zero Trust and just *run* from a token |
| **Local** | Yes, and tunnelkit manages it | Yes | Fully self-managed named tunnels — create, route DNS, run — driven from your code or CLI |

Cross-cutting concerns — the binary, the aggregate `tk.list()`/`tk.stopAll()`,
and the persistence store — stay on `tk` itself rather than any one mode. See
the [API reference](../reference/api.md) for the exhaustive method/option
tables; this page is the conceptual tour.

## Quick — `tk.quick`

A random `*.trycloudflare.com` URL pointing at a local service. No account,
the simplest possible path from "something running on localhost" to a public
URL.

```ts
const { publicUrl } = await tk.quick.start({
	service: 8080,
	autoStopMinutes: 30 // optional — 0 (default) means run until stopped
});
```

```sh
tunnelkit quick 8080 --auto-stop 30
```

`service` accepts a bare port (shorthand for `http://localhost:<port>`) or a
full service URL. Quick tunnels are never saved to the store — restart your
process and they're gone, by design.

## Remote — `tk.remote`

A tunnel whose ingress (which hostnames map to which local services) is
configured in the **Cloudflare Zero Trust dashboard**, not in your code.
tunnelkit just runs `cloudflared` with the token and mirrors whatever config
Cloudflare pushes at runtime.

```ts
const { ingress } = await tk.remote.start({
	id: 'my-app',
	token: process.env.CF_TUNNEL_TOKEN!
});

tk.on('ingress-update', ({ id, ingress }) => {
	// Fires whenever Cloudflare pushes a new config to the running tunnel.
});
```

```sh
tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --name prod  # first time
tunnelkit remote run prod                                     # reuse the saved token
```

Reach for Remote when the ingress rules already live in (or should live in)
the Cloudflare dashboard, and your app only needs to keep the tunnel alive.

## Local — `tk.local`

Fully self-managed named tunnels: authenticate once, then create a tunnel,
route one or more hostnames to it, and run it — the same lifecycle
`cloudflared tunnel create`/`route dns`/`run` would drive manually, wrapped in
one typed flow. **This is the only mode that touches your Cloudflare
account** (creates/deletes tunnels, adds DNS records), so authentication and
account listing live under `tk.local` too.

```ts
await tk.local.login({ onUrl, onComplete, onError }); // once
await tk.local.create('acme-prod');
await tk.local.routeDns('acme-prod', 'app.example.com');
await tk.local.start({ id, name, tunnelId, credentialsFile, ingress });
```

Or let `prepare()` do create + routeDns + save in one call, reusing the saved
config on every subsequent run:

```ts
const config = await tk.local.prepare({
	id: 'storefront',
	hostname: 'app.example.com',
	service: 'http://localhost:3000'
});
await tk.local.start(config);
```

```sh
tunnelkit local login
tunnelkit local run my-app --route app.example.com=http://localhost:3000
tunnelkit local run my-app  # reruns the saved tunnel and routes
```

If a tunnel with the same name already exists on Cloudflare but isn't tracked
locally and has no active connections, `create` treats it as an orphan
(usually from a half-failed previous create), removes it, and retries once —
see [Advanced usage](../guides/advanced-usage.md) for the full recovery rules
and what happens when it *isn't* a safe orphan.

## The shared shape

Every mode exposes the same core surface, so switching between them (or
building UI that treats them uniformly) doesn't mean relearning a pattern:

- `start(opts, onProgress?)` — idempotent per identity (`service` for Quick,
  `id` for Remote/Local); calling it again while already running returns the
  existing result instead of starting a second process.
- `stop(id)` — stop one.
- `isActive(id)` — whether it's currently running.
- `snapshot()` — this mode's contribution to `tk.list()`.
- `stopAll()` — stop every tunnel in this mode (used by `tk.stopAll()`).

`tk.list()` merges all three modes' snapshots into one `ActiveTunnel[]`, and
`tk.stop(id)` routes to whichever mode owns that id — so most application code
never needs to know which mode a given tunnel belongs to at all.

## Where to next

- [Events & persistence](./events-and-persistence.md) — observing state and
  surviving restarts.
- [API reference](../reference/api.md) — full option and method tables for
  each mode.
- [Examples](../../examples/README.md) — one runnable file per mode.
