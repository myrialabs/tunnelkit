# tunnelkit API reference

This page documents the programmatic API. For the terminal command, see the
[CLI reference](./cli.md).

All exports come from the package root: `import { … } from 'tunnelkit'`.

- [`TunnelKit`](#tunnelkit)
- [`TunnelStore`](#tunnelstore)
- [`CloudflaredTunnel`](#cloudflaredtunnel)
- [Binary functions](#binary-functions)
- [Utilities & types](#utilities--types)

---

## TunnelKit

High-level orchestration over all three tunnel modes. A typed `EventEmitter`.

```ts
new TunnelKit(options?: TunnelKitOptions)
```

Each mode is reached through its own namespace:

- `tk.quick` — quick (TryCloudflare) tunnels.
- `tk.remote` — remote (token-based) tunnels.
- `tk.local` — local (named) tunnels **and** all Cloudflare-account operations (`login`, `list`,
  `delete`, …), since only named tunnels touch your account.

Cross-cutting concerns — the binary, `list()`/`stopAll()`, the store, and events — stay on `tk`
itself.

### TunnelKitOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dataDir` | `string` | `~/.tunnelkit` | All persisted state: `cert.pem`, credentials, generated configs, and the saved-tunnels store. |
| `installDir` | `string` | `~/.tunnelkit/bin` | The managed cloudflared binary only — separate so a shared binary can live outside your data. |
| `logger` | `Logger` | silent | `{ log?, warn?, error? }`; pass `console` for output. |
| `quickTimeoutMs` | `number` | `30000` | Timeout waiting for a quick-tunnel URL. |
| `connectTimeoutMs` | `number` | `60000` | Timeout waiting for remote/local connection. |
| `isTunnelKnown` | `(tunnelId: string) => boolean` | `() => false` | Guards named tunnels you track from orphan cleanup during `create`. |
| `store` | `boolean \| TunnelStore` | `true` | Persist started tunnels. `true`/omit = auto-save under `dataDir`; `false` = off; a `TunnelStore` = bring your own instance. |

### Binary methods

| Method | Returns | Description |
| --- | --- | --- |
| `isBinaryInstalled()` | `boolean` | Whether a managed binary exists in `installDir`. |
| `getBinaryStatus()` | `BinaryStatus` | `{ installed, version, path }`. |
| `installBinary(version?)` | `Promise<string>` | Download cloudflared; returns its path. |

### Quick tunnel — `tk.quick`

```ts
tk.quick.start(opts: { service: string | number; autoStopMinutes?: number }, onProgress?: ProgressCallback)
  : Promise<{ id: string; service: string; publicUrl: string; timings: Record<string, number> }>
tk.quick.stop(service: string | number): Promise<void>
tk.quick.isActive(service: string | number): boolean
```

`service` accepts a bare port (`3000` → `http://localhost:3000`) or a full URL. `tk.quick.stop`
accepts the same port/URL you started with, or the returned `id` (`quick:<service>`).

### Remote tunnel — `tk.remote`

```ts
tk.remote.start(opts: { id: string; token: string; label?: string }, onProgress?: ProgressCallback)
  : Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }>
tk.remote.stop(id: string): Promise<void>
tk.remote.ingress(id: string): IngressInfo[]
tk.remote.isActive(id: string): boolean
```

### Local tunnel — `tk.local`

```ts
// Authentication
tk.local.checkAuth(): { authenticated: boolean; certPath: string }
tk.local.certPath(): string
tk.local.login(callbacks: LoginCallbacks): void          // { onUrl, onComplete, onError }
tk.local.cancelLogin(): void
tk.local.logout(): { success: boolean }

// Named tunnel management (Cloudflare account)
tk.local.create(name: string): Promise<{ tunnelId: string; credentialsFile: string }>
tk.local.delete(tunnelId: string, credentialsFile?: string): Promise<void>
tk.local.cleanupFiles(tunnelId: string): void
tk.local.routeDns(tunnelName: string, hostname: string): Promise<{ alreadyExists: boolean }>
tk.local.writeConfig(config: { tunnelId; credentialsFile; ingress }): string  // returns config.yml path
tk.local.list(): Promise<TunnelListEntry[]>

// Running
tk.local.start(config: LocalTunnelConfig, onProgress?: ProgressCallback)
  : Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }>
tk.local.stop(id: string): Promise<void>
tk.local.isActive(id: string): boolean
```

`LocalTunnelConfig`: `{ id, name, tunnelId, credentialsFile, ingress: IngressInfo[] }`, where:

- `id` — your handle in TunnelKit's registry (passed to `stop`/`isActive`).
- `name` — the Cloudflare tunnel name (from `create`).
- `tunnelId` / `credentialsFile` — returned by `create`.

`id` and `name` are independent. `start` throws if `ingress` is empty.

### Persistence

```ts
tk.store               // TunnelStore | null — null when store: false
```

Remote and local tunnels are auto-saved on start (quick tunnels are not). Read them back to restore
on startup: `for (const r of tk.store?.getRemotes() ?? []) await tk.remote.start(r)`. See
[`TunnelStore`](#tunnelstore).

### Status & lifecycle

```ts
tk.list(): ActiveTunnel[]            // every tunnel this manager is running, all modes
tk.stop(id: string): Promise<void>   // stop a single tunnel by id
tk.stopAll(): Promise<void>          // stop every managed tunnel
```

To list named tunnels on your Cloudflare account (not just the running ones), use
[`tk.local.list()`](#local-tunnel--tklocal).

### Events

| Event | Payload | When |
| --- | --- | --- |
| `status-changed` | `(tunnels: ActiveTunnel[])` | A tunnel starts or stops, or its `connections` changes |
| `ingress-update` | `({ id: string; ingress: IngressInfo[] })` | A remote tunnel's ingress syncs from Cloudflare |
| `connection` | `({ id: string; info: ConnectionInfo; status: 'up' \| 'down' })` | An edge connection comes up or goes down |

Each `ActiveTunnel` carries live `connections`; `status-changed` fires on every change. Use the
`connection` event for per-edge detail (ip / location) as it happens.

---

## TunnelStore

JSON-file persistence (`<dataDir>/config.json`, written `0600`). `TunnelKit` auto-saves to this by
default; it has no dependency on `TunnelKit`, so you can also use it standalone.

```ts
new TunnelStore(options?: { dataDir?: string; logger?: Logger })
store.path                         // absolute path to config.json
```

| Method | Returns | Description |
| --- | --- | --- |
| `getRemotes()` | `RemoteTunnelEntry[]` | All remote configs. |
| `getRemote(id)` | `RemoteTunnelEntry \| null` | One remote config. |
| `addRemote(label, token)` | `RemoteTunnelEntry` | Persist a new remote config (generates `id`). |
| `upsertRemote(id, label, token)` | `RemoteTunnelEntry` | Insert or update by `id` (used by auto-save). |
| `removeRemote(id)` | `boolean` | Remove; `true` if it existed. |
| `getLocals()` | `LocalTunnelEntry[]` | All local tunnels. |
| `getLocal(id)` | `LocalTunnelEntry \| null` | One local tunnel. |
| `addLocal(name, tunnelId, credentialsFile)` | `LocalTunnelEntry` | Persist a new local tunnel (empty ingress). |
| `upsertLocal(entry)` | `LocalTunnelEntry` | Insert or replace by `entry.id` (used by auto-save). |
| `removeLocal(id)` | `boolean` | Remove; `true` if it existed. |
| `addLocalIngress(id, hostname, service)` | `LocalTunnelEntry \| null` | Add or update an ingress rule (matched by hostname). |
| `removeLocalIngress(id, hostname)` | `LocalTunnelEntry \| null` | Remove an ingress rule. |
| `getZone()` / `setZone(zone)` / `clearZone()` | `string \| null` / `void` / `void` | Authorized DNS zone. |

`RemoteTunnelEntry`: `{ id, label, token }`. `LocalTunnelEntry`: `{ id, name, tunnelId, credentialsFile, ingress: IngressInfo[] }`.

---

## CloudflaredTunnel

Low-level typed `EventEmitter` around a `cloudflared` process. Most callers should prefer `TunnelKit`.

### Factories

```ts
CloudflaredTunnel.quick(url?: string, binaryPath?: string): CloudflaredTunnel
CloudflaredTunnel.withToken(token: string, binaryPath?: string): CloudflaredTunnel
CloudflaredTunnel.withConfig(configPath: string, binaryPath?: string): CloudflaredTunnel
```

### Instance

```ts
tunnel.process            // the underlying ChildProcess
tunnel.stop(): boolean    // SIGINT the process
tunnel.addHandler(fn)     // register a custom output parser
```

### Static commands

```ts
CloudflaredTunnel.login(callbacks: LoginCallbacks, options?: LoginOptions): LoginHandle
CloudflaredTunnel.createTunnel(name, options?: CreateTunnelOptions): Promise<CreateTunnelResult>
CloudflaredTunnel.deleteTunnel(tunnel, options?: DeleteTunnelOptions): Promise<DeleteTunnelResult>
CloudflaredTunnel.routeDns(tunnel, hostname, options?: RouteDnsOptions): Promise<RouteDnsResult>
CloudflaredTunnel.listTunnels(options?: ListTunnelsOptions): Promise<TunnelListEntry[]>
```

All command options accept `origincert` and `binaryPath`. `LoginOptions` also accepts
`preventBrowserOpen` (default `true`). `DeleteTunnelOptions` accepts `force`. `RouteDnsOptions`
accepts `overwriteDns`.

### Events (`CloudflaredTunnelEvents`)

| Event | Payload |
| --- | --- |
| `url` | `(url: string)` — TryCloudflare URL or ingress hostname |
| `connected` | `(info: ConnectionInfo)` |
| `disconnected` | `(info: ConnectionInfo)` |
| `config` | `({ config, version })` — config update pushed from Cloudflare (remote tunnels) |
| `error` | `(error: Error)` |
| `exit` | `(code, signal)` |
| `stdout` / `stderr` | `(data: string)` |

### CloudflaredMissingError

Thrown when no `cloudflared` binary can be resolved.

---

## Binary functions

```ts
defaultInstallDir(): string                             // ~/.tunnelkit/bin
getBinaryPath(installDir?): string                      // path to managed binary
isBinaryInstalled(installDir?): boolean
resolveCloudflaredBinary(installDir?): string | null    // managed, else PATH, else null
getBinaryVersion(binaryPath): string | null
getBinaryStatus(installDir?): BinaryStatus              // { installed, version, path }
installBinary(options?: InstallBinaryOptions): Promise<string>
```

`InstallBinaryOptions`: `{ installDir?, version?, logger? }`. `BinaryStatus`: `{ installed, version, path }`.

---

## Utilities & types

```ts
which(binary: string): string | null   // cross-runtime PATH lookup
noopLogger: Required<Logger>
CLOUDFLARE_TUNNELS_DASHBOARD_URL: string   // 'https://dash.cloudflare.com/?to=/:account/tunnels'
```

`CLOUDFLARE_TUNNELS_DASHBOARD_URL` links to the Cloudflare Zero Trust Tunnels dashboard. The
`?to=/:account/…` form resolves the signed-in account automatically, so no account id is needed.

Types: `Logger`, `TunnelType`, `IngressInfo`, `ActiveTunnel`, `ProgressStage`, `ProgressCallback`,
`TunnelKitOptions`, `TunnelKitEvents`, `LocalTunnelConfig`, `TunnelStoreOptions`,
`RemoteTunnelEntry`, `LocalTunnelEntry`, `CloudflaredTunnelEvents`, `ConnectionInfo`, `LoginHandle`,
`LoginCallbacks`, `LoginOptions`, `CreateTunnelOptions`, `CreateTunnelResult`,
`DeleteTunnelOptions`, `DeleteTunnelResult`, `RouteDnsOptions`, `RouteDnsResult`,
`ListTunnelsOptions`, `TunnelListEntry`, `InstallBinaryOptions`, `BinaryStatus`.

### ActiveTunnel

```ts
{
  id: string;               // "quick:<service>" or your supplied id
  type: 'quick' | 'remote' | 'local';
  service?: string;         // resolved local service for quick tunnels; absent for remote/local
  publicUrl: string;        // TryCloudflare URL or https://<first-hostname>
  startedAt: string;        // ISO timestamp
  autoStopMinutes?: number; // quick only; absent/0 means no auto-stop
  label?: string;
  ingress?: IngressInfo[];
  connections: ConnectionInfo[];  // live HA edge connections; empty while coming up, non-empty once serving
}
```
