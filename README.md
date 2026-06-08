<p align="center">
  <img src="https://tunnelkit.myrialabs.dev/favicon.svg" alt="TunnelKit" width="72" height="72" />
</p>

<h1 align="center">TunnelKit</h1>

<p align="center">
  <strong>Cloudflare Tunnels for Node &amp; Bun.</strong><br />
  A typed, event-driven API and CLI over all three tunnel modes — with zero dependencies.
</p>

<p align="center">
  <a href="https://tunnelkit.myrialabs.dev">Website</a> ·
  <a href="https://www.npmjs.com/package/tunnelkit">npm</a> ·
  <a href="./docs/api.md">API reference</a> ·
  <a href="./docs/cli.md">CLI reference</a> ·
  <a href="./examples/README.md">Examples</a> ·
  <a href="https://github.com/myrialabs/tunnelkit/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tunnelkit"><img src="https://img.shields.io/npm/v/tunnelkit" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/runtime-Node%2018%2B%20%7C%20Bun-black" alt="Node 18+ and Bun" />
</p>

---

TunnelKit wraps the `cloudflared` binary and gives you a typed, managed API over Cloudflare's three
tunnel modes. It downloads and drives the binary for you, so you can expose a local service to the
internet in a few lines.

```ts
import { TunnelKit } from 'tunnelkit';

const tk = new TunnelKit();
await tk.bin.ensure();

const { publicUrl } = await tk.quick.start({ service: 3000 }); // port → http://localhost:3000
console.log(publicUrl); // https://random-words.trycloudflare.com
```

Or straight from the terminal, no code required:

```sh
npm i -g tunnelkit      # or: bun add -g tunnelkit
tunnelkit quick 3000    # → https://random-words.trycloudflare.com
```

## Why TunnelKit

- **All three modes, first-class** — Quick, Remote (token), and Local (named), each behind its own namespace.
- **Fully typed, including events** — `TunnelKit` and `CloudflaredTunnel` are typed `EventEmitter`s.
- **Manages the binary** — downloads `cloudflared` on demand, or reuses one already on `PATH`.
- **Persistence on by default** — remote/local tunnels you start are saved so you can restore them by name; point it anywhere with a custom `TunnelStore`, or pass `store: false` to disable. `tk.store` is always accessible.
- **Ships a CLI** — the same capabilities from your terminal via `tunnelkit <command>`.
- **Zero dependencies** — pure Node built-ins. Runs identically on **Node 18+** and **Bun**.

## Feature matrix

Each mode lives under its own namespace (`tk.quick`, `tk.remote`, `tk.local`).

| Capability | API |
| --- | --- |
| Quick tunnel (TryCloudflare) | `tk.quick.start` / `tk.quick.stop` |
| Remote tunnel (token) | `tk.remote.start` / `tk.remote.stop` / `tk.remote.ingress` |
| Local tunnel (named) | `tk.local.login` / `tk.local.create` / `tk.local.routeDns` / `tk.local.start` / `tk.local.stop` / `tk.local.delete` |
| Account tunnel list | `tk.local.list` |
| Auto-stop (quick) | `tk.quick.start({ autoStopMinutes })` |
| Live status / ingress / connections | `'status-changed'` / `'ingress-update'` / `'connection'` events; `tk.list()` carries live `connections` per tunnel |
| Binary install / status | `tk.bin.ensure` / `tk.bin.install` / `tk.bin.isInstalled` / `tk.bin.status` |
| Config persistence | `TunnelStore` (on by default, API & CLI) |
| Low-level process control | `CloudflaredTunnel` |
| Terminal usage | `tunnelkit` CLI ([docs](./docs/cli.md)) |

## Install

```sh
bun add tunnelkit          # as a library
bun add -g tunnelkit       # or globally, for the CLI
# npm install tunnelkit / npm i -g tunnelkit
```

You also need the `cloudflared` binary. TunnelKit can download it (`tk.bin.ensure()` /
`tunnelkit install`), or use one already on your `PATH` (brew/apt/winget).

## The three modes

### Quick tunnel

A random `*.trycloudflare.com` URL — no account, no config. Great for demos and webhooks.

`service` is the proxy target: a bare port (`3000`) is shorthand for `http://localhost:3000`, or pass
a full URL (`http://localhost:8080`, `https://192.168.1.5:8443`).

```ts
const { publicUrl } = await tk.quick.start({ service: 8080, autoStopMinutes: 30 });
await tk.quick.stop(8080); // by port, the full service URL, or the returned id
```

### Remote (token-based) tunnel

A tunnel created in the Cloudflare dashboard, run locally from its token. Ingress rules are pushed
by Cloudflare at runtime and surfaced via the resolved promise and the `ingress-update` event.

```ts
const { ingress } = await tk.remote.start({ id: 'my-app', token: process.env.CF_TUNNEL_TOKEN! });
tk.on('ingress-update', ({ id, ingress }) => console.log(id, ingress));
await tk.remote.stop('my-app');
```

### Local (named) tunnel

A named tunnel you fully control: authenticate once, create, route DNS, then run with ingress rules
you define.

```ts
// 1. Authenticate once — surface the URL; the user approves in the browser.
await new Promise<void>((resolve, reject) => {
  tk.local.login({ onUrl: (url) => console.log('Authorize:', url), onComplete: resolve, onError: reject });
});

// 2. Create the tunnel and route a hostname.
const { tunnelId, credentialsFile } = await tk.local.create('acme-prod');
await tk.local.routeDns('acme-prod', 'app.example.com');

// 3. Run it.
//    `id` is your handle in TunnelKit's registry; `name` is the Cloudflare tunnel name.
await tk.local.start({
  id: 'storefront',
  name: 'acme-prod',
  tunnelId,
  credentialsFile,
  ingress: [{ hostname: 'app.example.com', service: 'http://localhost:3000' }]
});

// later: await tk.local.stop('storefront');
```

`tk.local.create` includes orphan recovery: if a same-named tunnel exists on Cloudflare but isn't
tracked locally and has no active connections, it is deleted and the create is retried. Guard tunnels
you track with the `isTunnelKnown` option.

## CLI

Installing globally puts a `tunnelkit` command on your `PATH` that drives the same three modes.

```sh
tunnelkit                                             # interactive control panel (in a terminal)
tunnelkit quick 3000                                  # quick tunnel (3000 → localhost:3000)
tunnelkit quick http://localhost:8080 --auto-stop 30  # full URL + auto-stop after 30 min
tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --name prod
tunnelkit remote run prod                             # reuse the saved "prod" token
tunnelkit local login                                 # authenticate (named tunnels)
tunnelkit local run my-app --route app.example.com=http://localhost:3000
tunnelkit local run my-app                            # rerun the saved "my-app" tunnel
tunnelkit local list
tunnelkit dashboard                                   # Cloudflare Tunnels dashboard link
tunnelkit install && tunnelkit status
```

Run `tunnelkit` with no command in a terminal for a **live control panel** — manage several tunnels
at once (`[↑/↓]` select, `[n]` new tunnel, `[x]` stop, `[c]` copy URL, `[m]` manage saved, `[q]` quit). See the
[CLI reference](./docs/cli.md) for every command and flag.
Interactive wizards use breadcrumbs, one-step `Esc` navigation, and persistent progress logs for
multi-step work like creating named tunnels and routing DNS.

## Events

A `TunnelKit` instance is a typed `EventEmitter` with three high-level events:

```ts
tk.on('status-changed', (tunnels) => console.log('Active:', tunnels));           // a tunnel starts/stops, or its connections change
tk.on('ingress-update', ({ id, ingress }) => console.log(id, ingress));          // a remote tunnel's ingress syncs
tk.on('connection', ({ id, info, status }) => console.log(id, status, info.location)); // an edge connection up/down
```

Each `ActiveTunnel` in `tk.list()` carries live `connections: ConnectionInfo[]`; `status-changed`
fires on every change, so watching it alone is enough for a health view. The `connection` event
gives per-edge detail (ip / location) as it happens.

The low-level [`CloudflaredTunnel`](#low-level-api) emits `url`, `connected`, `disconnected`,
`config`, `error`, `exit`, `stdout`, and `stderr`. Reach for it only when you want to drive a
process directly.

## Persistence

Remote and local tunnels you start are saved by default — through both the API and the CLI — so
you can restore them later. (Quick tunnels are ephemeral and never saved.) The store is a small JSON
file (`<dataDir>/config.json`, written `0600`).

```ts
new TunnelKit();                                  // auto-save under dataDir (default)
new TunnelKit({ dataDir: '~/.myapp/tunnels' });   // save somewhere else
new TunnelKit({ store: false });                  // noop store — reads empty, writes skipped
```

Read saved tunnels back from `tk.store` — e.g. to restore everything on startup:

```ts
const tk = new TunnelKit();
await tk.restoreAll();
```

`TunnelStore` has no dependency on `TunnelKit`, so you can also use it standalone:

```ts
import { TunnelStore } from 'tunnelkit';

const store = new TunnelStore({ dataDir: '~/.myapp/tunnels' });
store.getRemotes();             // [{ id, name, token }]
store.addLocalIngress(id, 'app.example.com', 'http://localhost:3000');
```

## Binary management

Everything shells out to `cloudflared`. TunnelKit resolves it from the managed `installDir` (default
`~/.tunnelkit/bin`), then from `PATH`. The library never downloads on its own — you call
`tk.bin.ensure()` when you want it. (The CLI downloads automatically on first use.)

```ts
tk.bin.status();                       // { installed, version, path }
await tk.bin.ensure();                 // resolve, downloading on first use
await tk.bin.install();                // download into installDir
await tk.bin.install('2024.12.2');     // pin a version
```

If no binary can be resolved, operations throw `CloudflaredMissingError`.

## Options

```ts
new TunnelKit({
  dataDir,          // ALL persisted state: cert.pem, credentials, configs, saved tunnels (default: ~/.tunnelkit)
  installDir,       // ONLY the cloudflared binary (default: ~/.tunnelkit/bin)
  store,            // true/omit = auto-save; false = noop; (advanced) a TunnelStore instance
  logger,           // any { log, warn, error } — silent if omitted (try `console`)
  quickTimeoutMs,   // quick-tunnel URL timeout (default: 30000)
  connectTimeoutMs, // remote/local connection timeout (default: 60000)
  isTunnelKnown     // predicate guarding name-conflict orphan cleanup
});
```

`dataDir` is the one place to set a location — it holds `cert.pem`, per-tunnel credentials and
configs, and the saved-tunnels store. `installDir` is separate only so a shared binary can live
outside your app's data.

## How is this different from `cloudflared`?

TunnelKit doesn't replace the `cloudflared` binary — it *drives* it, replacing the wrapper layer.

**vs. the `cloudflared` CLI:** you could shell out and parse logs yourself; TunnelKit removes that
glue — typed API, URL/connection promises, timeouts, auto-stop, a multi-tunnel registry, and live
events.

**vs. the [`cloudflared` npm package](https://www.npmjs.com/package/cloudflared):**

| | `cloudflared` npm | TunnelKit |
| --- | --- | --- |
| Quick tunnels | ✅ | ✅ |
| Token / config tunnels | pass flags yourself | first-class `tk.remote.start` / `tk.local.start` |
| High-level manager (lifecycle, timeouts, auto-stop, registry) | ❌ | ✅ `TunnelKit` |
| login / create / delete / route-dns / list helpers | ❌ | ✅ |
| `config.yml` generation + orphan recovery | ❌ | ✅ |
| Built-in persistence | ❌ | ✅ `TunnelStore` (default-on) |
| Typed events end-to-end | partial | ✅ |
| Runtime | Node | Node 18+ **and** Bun |

For **building an app that creates, runs, monitors, and persists tunnels across all three modes**,
use TunnelKit. (Capabilities reflect the projects as of writing.)

## Low-level API

For direct control over the child process, use `CloudflaredTunnel`:

```ts
import { CloudflaredTunnel } from 'tunnelkit';

const tunnel = CloudflaredTunnel.quick('http://localhost:3000');
tunnel.on('url', (url) => console.log(url));
tunnel.on('connected', (info) => console.log(info));
// tunnel.stop();
```

Static commands: `CloudflaredTunnel.login`, `.createTunnel`, `.deleteTunnel`, `.routeDns`,
`.listTunnels`.

## Graceful shutdown

TunnelKit never installs process hooks for you. Stop tunnels on exit yourself:

```ts
const shutdown = async () => { await tk.stopAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

## Examples

Four runnable scenarios cover the most common cases: quick tunnel, remote (token-based), local (named, full lifecycle), and restore-on-startup. See [`examples/`](./examples/README.md).

```sh
bun run examples/quick.ts 3000
```

## Documentation

- [API reference](./docs/api.md) — every export, option, method, and event.
- [CLI reference](./docs/cli.md) — every command, option, and example.
- [Examples](./examples/README.md) — runnable scenarios.

## Support

If TunnelKit is useful to you, consider supporting its development:

| Method | Address / Link |
|--------|----------------|
| Bitcoin (BTC) | `bc1qd9fyx4r84cce2a9hkjksetah802knadw5msls3` |
| Solana (SOL) | `Ev3P4KLF1PNC5C9rZYP8M3DdssyBQAQAiNJkvNmPQPVs` |
| Ethereum (ERC-20) | `0x61D826e5b666AA5345302EEEd485Acca39b1AFCF` |
| USDT (TRC-20) | `TLH49i3EoVKhFyLb6u2JUXZWScK7uzksdC` |
| Saweria | [saweria.co/myrialabs](https://saweria.co/myrialabs) |

## License

MIT License — see [LICENSE](LICENSE) for details.

---

**Website:** [tunnelkit.myrialabs.dev](https://tunnelkit.myrialabs.dev) · **Repository:** [github.com/myrialabs/tunnelkit](https://github.com/myrialabs/tunnelkit) · **Issues:** [Report a bug or request a feature](https://github.com/myrialabs/tunnelkit/issues)
