# tunnelkit

Run **Cloudflare Tunnels** from Node or Bun — a clean, event-driven, fully-typed API and CLI over all three tunnel modes, with **zero dependencies**.

It wraps the `cloudflared` binary, manages it for you, and lets you expose a local service to the internet in a few lines.

```ts
import { TunnelKit } from 'tunnelkit';

const tk = new TunnelKit();
if (!tk.isBinaryInstalled()) await tk.installBinary();

const { publicUrl } = await tk.startQuick({ service: 3000 }); // a bare port → http://localhost:3000
console.log(publicUrl); // https://random-words.trycloudflare.com
```

…or straight from your terminal, no code required:

```sh
npm i -g tunnelkit      # or: bun add -g tunnelkit
tunnelkit quick 3000    # → https://random-words.trycloudflare.com
```

## Why tunnelkit

- **All three tunnel modes**, first-class: Quick, Remote (token), and Local (named).
- **Fully typed**, including events. `TunnelKit` and `CloudflaredTunnel` are typed `EventEmitter`s.
- **Manages the binary** — download `cloudflared` on demand, or reuse one already on `PATH`.
- **Persistence on by default** — the API *and* CLI save the remote/local tunnels you start, so you can restore them by name; point it anywhere with a custom `TunnelStore`, or pass `store: false` to opt out.
- **Ships a CLI** — the same capabilities from your terminal via `tunnelkit <command>`.
- **Zero npm dependencies** — pure Node built-ins. Runs identically on **Node 18+** and **Bun**.

## Feature matrix

| Capability | API |
| --- | --- |
| Quick tunnel (TryCloudflare) | `startQuick` / `stopQuick` |
| Remote tunnel (token) | `startRemote` / `stopRemote` / `getRemoteIngress` |
| Local tunnel (named) | `login` / `createTunnel` / `routeDns` / `startLocal` / `stopLocal` / `deleteTunnel` |
| Account tunnel list | `listTunnels` |
| Auto-stop (quick) | `startQuick({ autoStopMinutes })` |
| Live status / ingress | `'status-changed'` / `'ingress-update'` events, `list()` |
| Binary install / status | `installBinary` / `isBinaryInstalled` / `getBinaryStatus` |
| Config persistence | `TunnelStore` (on by default, API & CLI) |
| Low-level process control | `CloudflaredTunnel` |
| Terminal usage | `tunnelkit` CLI ([docs](./docs/cli.md)) |

## Install

As a library:

```sh
bun add tunnelkit
# or: npm install tunnelkit
```

Or globally, for the CLI:

```sh
bun add -g tunnelkit
# or: npm i -g tunnelkit
```

You also need the `cloudflared` binary. tunnelkit can download it (`installBinary()` / `tunnelkit install`), or use one already on your `PATH` (brew/apt/winget).

## The three modes

### Quick tunnel

A random `*.trycloudflare.com` URL. No account, no config — great for demos and webhooks.

`service` is where traffic is proxied: a bare port is shorthand for `http://localhost:<port>`, or pass a full URL (`http://localhost:8080`, `https://192.168.1.5:8443`).

```ts
const { publicUrl } = await tk.startQuick({ service: 8080, autoStopMinutes: 30 });
await tk.stopQuick(8080); // by port, the full service URL, or the returned id
```

### Remote (token-based) tunnel

A tunnel created and configured in the Cloudflare dashboard, run locally from its token. Ingress is managed in the dashboard and pushed to cloudflared at runtime — surfaced via the `ingress-update` event and the resolved promise.

```ts
const { ingress } = await tk.startRemote({ id: 'my-app', token: process.env.CF_TUNNEL_TOKEN! });
tk.on('ingress-update', ({ id, ingress }) => console.log(id, ingress));
await tk.stopRemote('my-app');
```

### Local (named) tunnel

A named tunnel you create and control from your machine: authenticate once, create, route DNS, then run with ingress rules.

```ts
// 1. Authenticate (once) — surface the URL; the user approves in the browser.
await new Promise<void>((resolve, reject) => {
  tk.login({ onUrl: (url) => console.log('Authorize:', url), onComplete: resolve, onError: reject });
});

// 2. Create the Cloudflare tunnel (named "acme-prod") and route a hostname to it.
const { tunnelId, credentialsFile } = await tk.createTunnel('acme-prod');
await tk.routeDns('acme-prod', 'app.example.com');

// 3. Run it. The two identifiers are different things:
//    - `name` is the Cloudflare tunnel name (the one you created above).
//    - `id`   is *your* handle for this tunnel in TunnelKit's registry — you pass
//             it to stopLocal()/isLocalActive(), so make it whatever your app keys on.
await tk.startLocal({
  id: 'storefront',          // your app's identifier
  name: 'acme-prod',         // the Cloudflare tunnel name
  tunnelId,
  credentialsFile,
  ingress: [{ hostname: 'app.example.com', service: 'http://localhost:3000' }]
});

// later: await tk.stopLocal('storefront');
```

`createTunnel` includes orphan recovery: if a same-named tunnel exists on Cloudflare but isn't known locally and has no active connections, it's deleted and the create retried. Guard tunnels you track with the `isTunnelKnown` option.

## CLI

Installing globally puts a `tunnelkit` command on your `PATH` that drives the same three modes — no code required.

```sh
tunnelkit quick 3000                                  # quick tunnel (3000 → localhost:3000)
tunnelkit quick http://localhost:8080 --auto-stop 30  # full URL + auto-stop after 30 min
tunnelkit remote --token "$CF_TUNNEL_TOKEN" --label prod  # token-based tunnel, saved as "prod"
tunnelkit remote prod                                 # reuse the saved "prod" token
tunnelkit login                                       # authenticate (named tunnels)
tunnelkit local my-app --route app.example.com=http://localhost:3000
tunnelkit local my-app                                # rerun the saved "my-app" tunnel
tunnelkit list                                        # named tunnels on your account
tunnelkit install                                     # download cloudflared
tunnelkit status                                      # binary status
tunnelkit help
```

Run commands like `quick`, `remote`, and `local` stay in the foreground and shut the tunnel down cleanly on `Ctrl+C`. The binary is downloaded automatically on first use if it isn't already available. The CLI remembers named tunnels by default (under `~/.tunnelkit`) so you can reuse them; pass `--no-save` to opt out. See [`docs/cli.md`](./docs/cli.md) for every command and flag.

## Events

A `TunnelKit` instance (`tk` in these examples) is a typed `EventEmitter` with two high-level events:

```ts
tk.on('status-changed', (tunnels) => console.log('Active:', tunnels)); // any tunnel starts or stops
tk.on('ingress-update', ({ id, ingress }) => console.log(id, ingress)); // a remote tunnel's ingress syncs
```

Separately, the low-level [`CloudflaredTunnel`](#low-level-api) — which wraps a single `cloudflared` child process — is its own typed `EventEmitter`, emitting `url`, `connected`, `disconnected`, `config`, `error`, `exit`, `stdout`, and `stderr`. Reach for it only when you want to drive a process directly; `TunnelKit` is the usual entry point.

## Persistence

**`TunnelKit` saves the remote and local tunnels you start by default** — through both the API and the CLI — so you can restore them later. (Quick tunnels are ephemeral and never saved.) It's backed by `TunnelStore`: a small JSON store (`<dataDir>/config.json`, written `0600` since it can hold tokens) for remote tokens, local tunnel records, ingress rules, and an authorized zone.

It's a plain on/off switch — location follows `dataDir`:

```ts
new TunnelKit();                                  // auto-save under dataDir (default)
new TunnelKit({ dataDir: '~/.myapp/tunnels' });   // save somewhere else — just set dataDir
new TunnelKit({ store: false });                  // disable persistence entirely
```

Read saved tunnels back from `tk.store` — e.g. to restore everything on startup:

```ts
const tk = new TunnelKit();
for (const r of tk.store?.getRemotes() ?? []) await tk.startRemote(r);
```

For advanced cases (sharing one store across components, a custom logger) you can pass your own `TunnelStore` instance as `store`; and since `TunnelStore` has no dependency on `TunnelKit`, you can also use it standalone:

```ts
import { TunnelStore } from 'tunnelkit';

const store = new TunnelStore({ dataDir: '~/.myapp/tunnels' });
store.getRemotes();             // [{ id, label, token }]
store.addLocalIngress(id, 'app.example.com', 'http://localhost:3000');
```

## Binary management

Everything ultimately shells out to `cloudflared`. tunnelkit resolves it from the managed `installDir` (default `~/.tunnelkit/bin`), then from `PATH`. The library never downloads on its own — you call `installBinary()` when you want it. (The CLI does download automatically on first use, since it's interactive.)

```ts
tk.getBinaryStatus();           // { installed, version, path }
await tk.installBinary();       // download into installDir
await tk.installBinary('2024.12.2'); // pin a version
```

If no binary can be resolved, operations throw `CloudflaredMissingError`.

## Options

```ts
new TunnelKit({
  // Location — just two directories:
  dataDir,          // ALL persisted state: cert.pem, credentials, generated configs, saved tunnels (default: ~/.tunnelkit)
  installDir,       // ONLY the cloudflared binary — its own dir so a shared binary can live outside your data (default: ~/.tunnelkit/bin)

  // Persistence on/off (saved inside dataDir):
  store,            // true / omit = auto-save; false = disable; (advanced) a TunnelStore instance

  // Behaviour:
  logger,           // any { log, warn, error } — silent if omitted (try `console`)
  quickTimeoutMs,   // quick-tunnel URL timeout (default: 30000)
  connectTimeoutMs, // remote/local connection timeout (default: 60000)
  isTunnelKnown     // predicate guarding name-conflict orphan cleanup
});
```

There's just one place to set a location: **`dataDir`**. It holds everything tunnelkit persists — `cert.pem` (from `login()`, migrated from `~/.cloudflared` if found), per-tunnel `<tunnelId>/credentials.json` + `config.yml`, and the saved-tunnels store (`config.json`). To put it all somewhere else (as a host app might — e.g. `~/.myapp/tunnels`), set `dataDir` to that path; you don't construct anything. `installDir` is separate only so a shared `cloudflared` binary can live outside your app's data; `store` is a plain on/off switch.

## How is this different from `cloudflared`?

tunnelkit doesn't replace the `cloudflared` binary — it *drives* it, replacing the wrapper layer.

**vs. the `cloudflared` CLI:** you could shell out and parse logs yourself; tunnelkit removes that glue — typed API, URL/connection promises, timeouts, auto-stop, a multi-tunnel registry, and live events.

**vs. the [`cloudflared` npm package](https://www.npmjs.com/package/cloudflared):**

| | `cloudflared` npm | tunnelkit |
| --- | --- | --- |
| Quick tunnels | ✅ | ✅ |
| Token / config tunnels | pass flags yourself | first-class `startRemote` / `startLocal` |
| High-level manager (lifecycle, timeouts, auto-stop, registry) | ❌ | ✅ `TunnelKit` |
| login / create / delete / route-dns / list helpers | ❌ | ✅ |
| `config.yml` generation + orphan recovery | ❌ | ✅ |
| Built-in persistence | ❌ | ✅ `TunnelStore` (default-on) |
| Typed events end-to-end | partial | ✅ |
| Dependencies | has runtime deps | **zero** |
| Runtime | Node | Node 18+ **and** Bun |

In short: for **building an app that creates, runs, monitors, and persists tunnels across all three modes**, use tunnelkit. (Capabilities described reflect the projects as of writing.)

## Low-level API

For direct control over the child process, use `CloudflaredTunnel`:

```ts
import { CloudflaredTunnel } from 'tunnelkit';

const tunnel = CloudflaredTunnel.quick('http://localhost:3000');
tunnel.on('url', (url) => console.log(url));
tunnel.on('connected', (info) => console.log(info));
// tunnel.stop();
```

Static commands: `CloudflaredTunnel.login`, `.createTunnel`, `.deleteTunnel`, `.routeDns`, `.listTunnels`.

## Graceful shutdown

tunnelkit never installs process hooks for you. Stop tunnels on exit yourself:

```ts
const shutdown = async () => { await tk.stopAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

## Examples

A dozen runnable, case-by-case scenarios live in [`examples/`](./examples/README.md) — webhooks, multiple tunnels, multi-hostname routing, account cleanup, restore-on-startup, binary management, error handling, custom loggers, and more.

```sh
bun run examples/quick.ts 3000
```

## Documentation

- [CLI reference](./docs/cli.md) — every command, option, and example for the `tunnelkit` CLI.
- [API reference](./docs/api.md) — every export, option, method, and event.
- [Examples](./examples/README.md) — case-by-case runnable scenarios.

## License

MIT
