# Binary management

Every tunnel mode shells out to the `cloudflared` binary. tunnelkit resolves
it for you and can download it on demand — the library never does this
automatically on its own, so nothing hits the network unless you ask.

## Resolution order

1. A managed install under `installDir` (default `~/.tunnelkit/bin`).
2. Any `cloudflared` already on `$PATH` — so a system-wide install (via
   `brew`, `apt`, `winget`, or similar) is reused instead of downloading a
   second copy.

If neither is found, calls that need the binary throw
`CloudflaredMissingError` (see
[Advanced usage](../guides/advanced-usage.md#cloudflaredmissingerror)).

## Through `TunnelKit` — `tk.bin`

```ts
await tk.bin.ensure(); // resolve, downloading on first use only
tk.bin.status(); // { installed, version, path }
await tk.bin.install('2024.12.2'); // pin a specific release
```

`tk.bin.ensure()` is the common case: it resolves an existing binary if one is
found, and downloads the latest release only if nothing is available yet.
Call it once at startup before starting any tunnel.

## Through the CLI

```sh
tunnelkit install            # latest
tunnelkit install 2024.12.2  # pin a release
tunnelkit status              # installed? version? resolved path?
```

The CLI also auto-installs `cloudflared` the first time any command needs it,
so `tunnelkit install` ahead of time is optional, not required — it exists
for pinning a version or pre-warming a fresh environment (e.g. a Docker image
build step).

## Standalone functions

For use outside a `TunnelKit` instance (e.g. a setup script), the same logic
is exported as plain functions — `resolveCloudflaredBinary`,
`isBinaryInstalled`, `installBinary`, `getBinaryStatus`, `getBinaryVersion`,
`getBinaryPath`, `defaultInstallDir` — documented in full in the
[API reference](../reference/api.md#binary-functions).

## Where downloads come from

`installBinary` downloads the platform/arch-appropriate build directly from
[cloudflared's GitHub releases](https://github.com/cloudflare/cloudflared/releases).
Linux and Windows binaries are used as-is; the macOS release ships as a
`.tgz` and is extracted automatically. Unsupported platform/architecture
combinations throw a clear error rather than silently failing.

## Where to next

- [Tunnel modes](../essential/tunnel-modes.md) — every mode calls
  `requireBinary` under the hood before starting.
- [CLI reference](./cli.md) — `install`, `status`, and every other command.
- [API reference](../reference/api.md#binary-functions) — full function
  signatures and `BinaryStatus`/`InstallBinaryOptions` shapes.
