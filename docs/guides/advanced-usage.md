# Advanced usage

Patterns beyond the happy path: what can go wrong, how tunnelkit recovers
automatically vs. when it surfaces a decision to you, and the low-level
escape hatch underneath every mode.

## `CloudflaredMissingError`

Thrown when no `cloudflared` binary can be resolved (see
[Binary management](../operations/binary-management.md)) — every `start()`
call across all three modes can throw this.

```ts
import { TunnelKit, CloudflaredMissingError } from '@myrialabs/tunnelkit';

try {
	await tk.quick.start({ service: 3000 });
} catch (error) {
	if (error instanceof CloudflaredMissingError) {
		await tk.bin.ensure(); // download it, then retry
	} else {
		throw error;
	}
}
```

The CLI catches this at the top level and prints a hint to run
`tunnelkit install`; library code should either call `tk.bin.ensure()` before
starting tunnels (avoiding the error entirely) or handle it explicitly if the
binary is expected to already be present.

## Orphan tunnel recovery (Local mode)

`tk.local.create(name)` can hit a "tunnel with name already exists" error from
Cloudflare. tunnelkit distinguishes three cases before deciding what to do:

1. **You already track it** (`isTunnelKnown(tunnelId)` returns `true`, which
   by default checks `store.getLocals()`) — thrown as a clear "choose a
   different name" error. This is a real conflict, not recoverable
   automatically.
2. **It has active connections** — also thrown as an error. A tunnel actively
   serving traffic is never auto-deleted.
3. **Neither** — it's an orphan, almost always left over from a half-failed
   previous `create` call. tunnelkit deletes it and retries the create once,
   transparently.

Override the default "known" check with `isTunnelKnown` in
`TunnelKitOptions` if your app tracks named tunnels somewhere other than the
built-in store (e.g. your own database):

```ts
const tk = new TunnelKit({
	isTunnelKnown: (tunnelId) => myDb.hasTunnel(tunnelId)
});
```

## Aborting a start with `AbortSignal`

Every mode's `start()` accepts an optional `signal` alongside its other
options. Aborting stops the in-progress `cloudflared` process and rejects the
`start()` call — useful for a "cancel" button on a long-running connect, or a
caller-side timeout shorter than the built-in `quickTimeoutMs`/
`connectTimeoutMs`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

await tk.quick.start({ service: 3000, signal: controller.signal });
```

## Low-level `CloudflaredTunnel`

Every mode is built on `CloudflaredTunnel`, a typed `EventEmitter` around a
raw `cloudflared` child process. Drop down to it directly when you need
process-level control `TunnelKit` doesn't expose — reading raw
`stdout`/`stderr`, a custom output parser via `addHandler`, or driving
`cloudflared` in a way none of the three modes models:

```ts
import { CloudflaredTunnel } from '@myrialabs/tunnelkit';

const tunnel = CloudflaredTunnel.quick('http://localhost:3000');
tunnel.on('url', (url) => console.log('Public URL:', url));
tunnel.on('connected', (info) => console.log('Edge up:', info.location));
tunnel.on('stderr', (data) => console.error(data));

// Later:
await tunnel.stop(); // resolves once cloudflared has exited
```

The same class also exposes the one-shot account commands every mode calls
internally — `CloudflaredTunnel.login`, `createTunnel`, `deleteTunnel`,
`routeDns`, `listTunnels` — for building custom flows around named tunnels
without going through `tk.local`. Full method and event signatures are in the
[API reference](../reference/api.md#cloudflaredtunnel).

Most application code should prefer `TunnelKit` — it's the layer that adds
persistence, aggregate `list()`/`stopAll()`, orphan recovery, and the typed
high-level events. Reach for `CloudflaredTunnel` only when you specifically
need to bypass that.

## Where to next

- [Binary management](../operations/binary-management.md) — resolving and
  installing `cloudflared`.
- [Tunnel modes](../essential/tunnel-modes.md) — the three high-level modes
  built on `CloudflaredTunnel`.
- [API reference](../reference/api.md) — exhaustive signatures for everything
  on this page.
