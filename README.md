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

TunnelKit wraps the `cloudflared` binary into a typed library and a CLI command.

```ts
// API
const tk = new TunnelKit();
const { publicUrl } = await tk.quick.start({ service: 3000 });
```

```sh
# CLI
tunnelkit quick 3000
```

## Why TunnelKit

- **All three modes** — Quick, Remote (token), and Local (named), each behind its own namespace.
- **Fully typed events** — `TunnelKit` and `CloudflaredTunnel` are typed `EventEmitter`s.
- **Manages the binary** — downloads `cloudflared` on demand, or reuses one on `PATH`.
- **Persistence by default** — tunnels you start are saved; restore them by name, or disable with `store: false`.
- **Zero dependencies** — pure Node built-ins. Runs on **Node 18+** and **Bun**.

## Quick start

| Mode | API | CLI |
| --- | --- | --- |
| Quick | `tk.quick.start({ service })` | `tunnelkit quick <port>` |
| Remote | `tk.remote.start({ id, token })` | `tunnelkit remote run --token <token>` |
| Local | `tk.local.start({ id, name, tunnelId, credentialsFile, ingress })` | `tunnelkit local run <name> --route <host>=<service>` |

```sh
bun add tunnelkit          # library
bun add -g tunnelkit       # CLI
```

`cloudflared` is downloaded on first use, or use one already on `PATH`.

## The three modes

**Quick** — a random `*.trycloudflare.com` URL, no account needed.

<table>
<tr><th>API</th><th>CLI</th></tr>
<tr>
<td>

```ts
const { publicUrl } = await tk.quick.start({
  service: 8080, autoStopMinutes: 30
});
```

</td>
<td>

```sh
tunnelkit quick 8080 --auto-stop 30
```

</td>
</tr>
</table>

**Remote** — dashboard-managed tunnel, run from a token.

<table>
<tr><th>API</th><th>CLI</th></tr>
<tr>
<td>

```ts
const { ingress } = await tk.remote.start({
  id: 'my-app', token: process.env.CF_TUNNEL_TOKEN!
});
```

</td>
<td>

```sh
tunnelkit remote run --token "$CF_TUNNEL_TOKEN"
# tunnelkit remote run prod   # reuse saved
```

</td>
</tr>
</table>

**Local** — named tunnel: authenticate once, create, route DNS, run.

<table>
<tr><th>API</th><th>CLI</th></tr>
<tr>
<td>

```ts
await tk.local.login({ onUrl, onComplete, onError });
await tk.local.create('acme-prod');
await tk.local.routeDns('acme-prod', 'app.example.com');
await tk.local.start({ id, name, tunnelId, credentialsFile, ingress });
```

</td>
<td>

```sh
tunnelkit local login
tunnelkit local run my-app \
  --route app.example.com=http://localhost:3000
# tunnelkit local run my-app  # reuse saved
```

</td>
</tr>
</table>

## Interactive panel

`tunnelkit` with no arguments opens a live TUI — view all tunnels, stop/start, copy URLs, manage
saved configs.

```text
  tunnelkit > tunnels

  ❯ ●  quick-5173     →  https://abc.trycloudflare.com
    ○  quick-3000     →  https://xyz.trycloudflare.com
    ●  remotely-prod  →  2 routes
        - http://localhost:4001  →  app.example.com
        - http://localhost:4002  →  api.example.com
    ●  locally-prod   →  2 routes
        - http://localhost:5001  →  shop.example.com
        - http://localhost:5002  →  blog.example.com

  [↑/↓] select   [n] new tunnel   [x] stop   [c] copy URL
  [m] manage saved   [q] quit
```

See the [CLI reference](./docs/cli.md) for all keybindings.

## Events

```ts
tk.on('status-changed', (tunnels) => { });
tk.on('ingress-update', ({ id, ingress }) => { });
tk.on('connection', ({ id, info, status }) => { });
```

The interactive panel shows live status per tunnel; `--verbose` prints diagnostics.

## Persistence

Remote and local tunnels auto-save to `<dataDir>/config.json`. Quick tunnels are ephemeral.

<table>
<tr><th>API</th><th>CLI</th></tr>
<tr>
<td>

```ts
new TunnelKit();                              // auto-save
new TunnelKit({ store: false });              // disable
await tk.restoreAll();                        // rehydrate all
```

</td>
<td>

```sh
tunnelkit saved                 # list saved
tunnelkit forget <name>         # remove entry
# auto-save on remote run / local run
```

</td>
</tr>
</table>

## Binary management

<table>
<tr><th>API</th><th>CLI</th></tr>
<tr>
<td>

```ts
tk.bin.status();
await tk.bin.ensure();
await tk.bin.install('2024.12.2');
```

</td>
<td>

```sh
tunnelkit status
tunnelkit install [version]
```

</td>
</tr>
</table>

## Options

| Option | API | CLI |
| --- | --- | --- |
| Data directory | `{ dataDir }` | `--data-dir` |
| Install directory | `{ installDir }` | `--install-dir` |
| Store / persistence | `{ store: false }` | `--no-save` |
| Logger | `{ logger: console }` | `--verbose` |
| Quick timeout | `{ quickTimeoutMs: 15000 }` | — |
| Connection timeout | `{ connectTimeoutMs: 30000 }` | — |
| Skip confirm | — | `--yes / -y` |

## Low-level API

```ts
import { CloudflaredTunnel } from 'tunnelkit';
const tunnel = CloudflaredTunnel.quick('http://localhost:3000');
tunnel.on('url', (url) => console.log(url));
```

## Graceful shutdown

```ts
const shutdown = async () => { await tk.stopAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

From the CLI, `Ctrl+C` / `q` stops everything.

## Documentation

- [API reference](./docs/api.md) — every export, option, method, and event.
- [CLI reference](./docs/cli.md) — every command, option, and example.
- [Examples](./examples/README.md) — runnable scenarios.

## License

MIT License — see [LICENSE](LICENSE) for details.
