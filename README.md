# tunnelkit

Zero-dependency, TypeScript-native toolkit for running **Cloudflare Tunnels** from Node or Bun.

It wraps the `cloudflared` binary and gives you a clean, event-driven, fully-typed API over all three tunnel modes — plus binary management and optional persistence — so you can expose a local service to the internet in a few lines.

```ts
import { TunnelKit } from 'tunnelkit';

const tk = new TunnelKit();
if (!tk.isBinaryInstalled()) await tk.installBinary();

const { publicUrl } = await tk.startQuick({ port: 3000 });
console.log(publicUrl); // https://random-words.trycloudflare.com
```

## Why tunnelkit

- **All three tunnel modes**, first-class: Quick, Remote (token), and Local (named).
- **Zero npm dependencies** — pure Node built-ins. Runs identically on **Node 18+** and **Bun**.
- **Fully typed**, including events. `TunnelKit` and `CloudflaredTunnel` are typed `EventEmitter`s.
- **Manages the binary** — download `cloudflared` on demand, or reuse one already on `PATH`.
- **Optional persistence** (`TunnelStore`) when you want it; stateless core when you don't.

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
| Config persistence | `TunnelStore` (optional) |
| Low-level process control | `CloudflaredTunnel` |

## Install

```sh
bun add tunnelkit
# or: npm install tunnelkit
```

You also need the `cloudflared` binary. tunnelkit can download it (`installBinary()`), or use one already on your `PATH` (brew/apt/winget).

## The three modes

### Quick tunnel

A random `*.trycloudflare.com` URL. No account, no config — great for demos and webhooks.

```ts
const { publicUrl } = await tk.startQuick({ port: 8080, autoStopMinutes: 30 });
await tk.stopQuick(8080);
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

// 2. Create + route.
const { tunnelId, credentialsFile } = await tk.createTunnel('my-tunnel');
await tk.routeDns(tunnelId, 'app.example.com');

// 3. Run.
await tk.startLocal({
  id: 'my-tunnel',
  name: 'my-tunnel',
  tunnelId,
  credentialsFile,
  ingress: [{ hostname: 'app.example.com', service: 'http://localhost:3000' }]
});
```

`createTunnel` includes orphan recovery: if a same-named tunnel exists on Cloudflare but isn't known locally and has no active connections, it's deleted and the create retried. Guard tunnels you track with the `isTunnelKnown` option.

## Events

Both `TunnelKit` and `CloudflaredTunnel` are typed `EventEmitter`s.

```ts
tk.on('status-changed', (tunnels) => console.log('Active:', tunnels));
tk.on('ingress-update', ({ id, ingress }) => console.log(id, ingress));
```

`CloudflaredTunnel` emits `url`, `connected`, `disconnected`, `config`, `error`, `exit`, `stdout`, `stderr`.

## Persistence (optional)

`TunnelKit` is stateless about *which* tunnels you've configured. `TunnelStore` is the batteries-included companion that persists remote tokens, local tunnel records, ingress rules, and an authorized zone to `<dataDir>/config.json`:

```ts
import { TunnelStore } from 'tunnelkit';

const store = new TunnelStore();
const remote = store.addRemote('prod', token);
store.getRemotes();             // [{ id, label, token }]
store.addLocalIngress(id, 'app.example.com', 'http://localhost:3000');
```

Bring your own storage instead (a DB, env vars, …) — the two are fully decoupled.

## Binary management

Everything ultimately shells out to `cloudflared`. tunnelkit resolves it from the managed `installDir` (default `~/.tunnelkit/bin`), then from `PATH`. It never downloads automatically — you decide when.

```ts
tk.getBinaryStatus();           // { installed, version, path }
await tk.installBinary();       // download into installDir
await tk.installBinary('2024.12.2'); // pin a version
```

If no binary can be resolved, operations throw `CloudflaredMissingError`.

## Options

```ts
new TunnelKit({
  dataDir,          // cert + credentials + generated configs (default: ~/.tunnelkit)
  installDir,       // managed cloudflared binary (default: ~/.tunnelkit/bin)
  logger,           // any { log, warn, error } — silent if omitted (try `console`)
  quickTimeoutMs,   // quick-tunnel URL timeout (default: 30000)
  connectTimeoutMs, // remote/local connection timeout (default: 60000)
  isTunnelKnown     // predicate guarding name-conflict orphan cleanup
});
```

`dataDir` holds `cert.pem` (from `login()`, migrated from `~/.cloudflared` if found) and per-tunnel `<tunnelId>/credentials.json` + `config.yml`.

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
| Optional persistence | ❌ | ✅ `TunnelStore` |
| Typed events end-to-end | partial | ✅ |
| Dependencies | has runtime deps | **zero** |
| Runtime | Node | Node 18+ **and** Bun |
| Install cloudflared as a system service | ✅ | ❌ (out of scope) |

In short: for a one-off URL from the terminal use the CLI; for installing cloudflared as a daemon use the npm package; for **building an app that creates, runs, monitors, and persists tunnels across all three modes**, use tunnelkit. (Capabilities described reflect the projects as of writing.)

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

- [API reference](./docs/api.md) — every export, option, method, and event.
- [Examples](./examples/README.md) — case-by-case runnable scenarios.

## License

MIT
