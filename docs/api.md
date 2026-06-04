# tunnelkit API reference

This page documents the programmatic API. For the terminal command, see the
[CLI reference](./cli.md).

All exports come from the package root: `import { … } from 'tunnelkit'`.

- [`TunnelKit`](#tunnelmanager)
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

### TunnelKitOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dataDir` | `string` | `~/.tunnelkit` | All persisted state: `cert.pem`, credentials, generated configs, and the saved-tunnels store (`config.json`). Set this to relocate everything. |
| `installDir` | `string` | `~/.tunnelkit/bin` | Only the managed cloudflared binary — separate so a shared binary can live outside your data. |
| `logger` | `Logger` | silent | `{ log?, warn?, error? }`; pass `console` for output. |
| `quickTimeoutMs` | `number` | `30000` | Timeout waiting for a quick-tunnel URL. |
| `connectTimeoutMs` | `number` | `60000` | Timeout waiting for remote/local connection. |
| `isTunnelKnown` | `(tunnelId: string) => boolean` | `() => false` | Protects tunnels you track from orphan cleanup. |
| `store` | `boolean \| TunnelStore` | `true` | Persist started tunnels (saved under `dataDir`). `true`/omit = auto-save; `false` = off; a `TunnelStore` = advanced (bring your own instance). Change the location via `dataDir`, not here. |

### Binary methods

| Method | Returns | Description |
| --- | --- | --- |
| `isBinaryInstalled()` | `boolean` | Whether a managed binary exists in `installDir`. |
| `getBinaryStatus()` | `BinaryStatus` | `{ installed, version, path }`. |
| `installBinary(version?)` | `Promise<string>` | Download cloudflared; returns its path. |

### Quick tunnel

```ts
startQuick(opts: { service: string | number; autoStopMinutes?: number }, onProgress?: ProgressCallback)
  : Promise<{ id: string; service: string; publicUrl: string; timings: Record<string, number> }>
stopQuick(service: string | number): Promise<void>
```

`service` is the proxy target: a bare port number (`3000`) is shorthand for `http://localhost:3000`; a full URL is used as-is. `autoStopMinutes` defaults to `0` (no auto-stop). `stopQuick` accepts the same port/URL you started with, or the returned `id` (`quick:<service>`).

### Remote tunnel

```ts
startRemote(opts: { id: string; token: string; label?: string }, onProgress?: ProgressCallback)
  : Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }>
stopRemote(id: string): Promise<void>
getRemoteIngress(id: string): IngressInfo[]
isRemoteActive(id: string): boolean
```

### Local tunnel

```ts
checkAuth(): { authenticated: boolean; certPath: string }
getCertPath(): string
login(callbacks: LoginCallbacks): void          // { onUrl, onComplete, onError }
cancelLogin(): void
logout(): { success: boolean }

createTunnel(name: string): Promise<{ tunnelId: string; credentialsFile: string }>
deleteTunnel(tunnelId: string, credentialsFile?: string): Promise<void>
cleanupTunnelFiles(tunnelId: string): void
routeDns(tunnelName: string, hostname: string): Promise<{ alreadyExists: boolean }>
writeLocalConfig(config: { tunnelId; credentialsFile; ingress }): string  // returns config.yml path

startLocal(config: LocalTunnelConfig, onProgress?: ProgressCallback)
  : Promise<{ ingress: IngressInfo[]; timings: Record<string, number> }>
stopLocal(id: string): Promise<void>
isLocalActive(id: string): boolean
```

`LocalTunnelConfig`: `{ id, name, tunnelId, credentialsFile, ingress: IngressInfo[] }`, where:

- `id` — *your* handle for this tunnel in TunnelKit's registry (what you pass to `stopLocal`/`isLocalActive`). Choose whatever your app keys on.
- `name` — the Cloudflare tunnel name (the one you passed to `createTunnel`).
- `tunnelId` / `credentialsFile` — returned by `createTunnel`.

`id` and `name` are independent: they may match, but they don't have to. `startLocal` throws if `ingress` is empty.

### Persistence

```ts
tk.store               // TunnelStore | null — the backing store (null when `store: false`)
```

Remote and local tunnels are saved to `tk.store` automatically when they start (quick tunnels are not). Read them back to restore on startup, e.g. `for (const r of tk.store?.getRemotes() ?? []) await tk.startRemote(r)`. See [`TunnelStore`](#tunnelstore).

### Account & status

```ts
listTunnels(): Promise<TunnelListEntry[]>   // every named tunnel on the account
list(): ActiveTunnel[]                       // tunnels this manager is running
stopAll(): Promise<void>
```

### Events

| Event | Payload |
| --- | --- |
| `status-changed` | `(tunnels: ActiveTunnel[])` |
| `ingress-update` | `({ id: string; ingress: IngressInfo[] })` |

---

## TunnelStore

JSON-file persistence (`<dataDir>/config.json`, written with `0600` permissions since it can hold tokens). This is the store `TunnelKit` auto-saves to by default (via the `store` option); it has no dependency on `TunnelKit`, so you can also use it standalone or point it at a custom location.

```ts
new TunnelStore(options?: { dataDir?: string; logger?: Logger })
store.path                                  // absolute path to config.json
```

| Method | Returns | Description |
| --- | --- | --- |
| `getRemotes()` | `RemoteTunnelEntry[]` | All remote configs. |
| `getRemote(id)` | `RemoteTunnelEntry \| null` | One remote config. |
| `addRemote(label, token)` | `RemoteTunnelEntry` | Persist a new remote config (generates `id`). |
| `upsertRemote(id, label, token)` | `RemoteTunnelEntry` | Insert or update a remote keyed by `id` (used by auto-save). |
| `removeRemote(id)` | `boolean` | Remove; `true` if it existed. |
| `getLocals()` | `LocalTunnelEntry[]` | All local tunnels. |
| `getLocal(id)` | `LocalTunnelEntry \| null` | One local tunnel. |
| `addLocal(name, tunnelId, credentialsFile)` | `LocalTunnelEntry` | Persist a new local tunnel (empty ingress). |
| `upsertLocal(entry)` | `LocalTunnelEntry` | Insert or replace a local entry keyed by `entry.id` (used by auto-save). |
| `removeLocal(id)` | `boolean` | Remove; `true` if it existed. |
| `addLocalIngress(id, hostname, service)` | `LocalTunnelEntry \| null` | Add/update an ingress rule (matched by hostname). |
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

Command options accept `origincert` and `binaryPath`; `LoginOptions` also accepts `preventBrowserOpen` (default `true`).

### Events (`CloudflaredTunnelEvents`)

| Event | Payload |
| --- | --- |
| `url` | `(url: string)` — TryCloudflare URL or ingress hostname |
| `connected` | `(info: ConnectionInfo)` |
| `disconnected` | `(info: ConnectionInfo)` |
| `config` | `({ config, version })` |
| `error` | `(error: Error)` |
| `exit` | `(code, signal)` |
| `stdout` / `stderr` | `(data: string)` |

### CloudflaredMissingError

Thrown when no `cloudflared` binary can be resolved.

---

## Binary functions

```ts
defaultInstallDir(): string                       // ~/.tunnelkit/bin
getBinaryPath(installDir?): string                // path to managed binary
isBinaryInstalled(installDir?): boolean
resolveCloudflaredBinary(installDir?): string | null   // managed, else PATH, else null
getBinaryVersion(binaryPath): string | null
getBinaryStatus(installDir?): BinaryStatus        // { installed, version, path }
installBinary(options?: InstallBinaryOptions): Promise<string>
```

`InstallBinaryOptions`: `{ installDir?, version?, logger? }`. `BinaryStatus`: `{ installed, version, path }`.

---

## Utilities & types

```ts
which(binary: string): string | null   // cross-runtime PATH lookup
noopLogger: Required<Logger>
```

Types: `Logger`, `TunnelType`, `IngressInfo`, `ActiveTunnel`, `ProgressStage`, `ProgressCallback`, `TunnelKitOptions`, `TunnelKitEvents`, `LocalTunnelConfig`, `TunnelStoreOptions`, `RemoteTunnelEntry`, `LocalTunnelEntry`, `CloudflaredTunnelEvents`, `ConnectionInfo`, `LoginHandle`, `LoginCallbacks`, `LoginOptions`, `CreateTunnelOptions`, `CreateTunnelResult`, `DeleteTunnelOptions`, `DeleteTunnelResult`, `RouteDnsOptions`, `RouteDnsResult`, `ListTunnelsOptions`, `TunnelListEntry`, `InstallBinaryOptions`, `BinaryStatus`.

### ActiveTunnel

```ts
{
  id: string;            // "quick:<service>" or your supplied id
  type: 'quick' | 'remote' | 'local';
  service?: string;      // resolved local service for quick (e.g. http://localhost:3000); absent otherwise
  publicUrl: string;     // TryCloudflare URL or https://<first-hostname>
  startedAt: string;     // ISO timestamp
  autoStopMinutes?: number;  // quick only; absent/0 means no auto-stop
  label?: string;
  ingress?: IngressInfo[];
}
```
