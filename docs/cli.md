# tunnelkit CLI reference

Installing tunnelkit globally exposes a `tunnelkit` command that drives the same
three tunnel modes as the library — straight from your terminal, no code.

```sh
bun add -g tunnelkit
# or: npm i -g tunnelkit
```

The CLI needs the `cloudflared` binary. It is downloaded automatically into
`~/.tunnelkit/bin` on first use; you can also fetch it ahead of time with
`tunnelkit install`, or rely on a `cloudflared` already on your `PATH`.

```sh
tunnelkit <command> [options]
```

- [Commands](#commands)
  - [`quick`](#quick)
  - [`remote`](#remote)
  - [`local`](#local)
  - [`login` / `logout`](#login--logout)
  - [`list`](#list)
  - [`delete`](#delete)
  - [`install`](#install)
  - [`status`](#status)
  - [`version` / `help`](#version--help)
- [Global options](#global-options)
- [Exit codes](#exit-codes)

---

## Commands

### `quick`

Start a quick [TryCloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
tunnel to a local port and print the public URL. Runs in the foreground until
`Ctrl+C`.

```sh
tunnelkit quick <port> [--url <url>] [--auto-stop <minutes>]
```

| Option | Default | Description |
| --- | --- | --- |
| `<port>` | — | Local port to expose (required). |
| `--url <url>` | `http://localhost:<port>` | Override the target the tunnel proxies to. |
| `--auto-stop <minutes>` | `60` | Minutes until the tunnel auto-stops; `0` disables auto-stop. |

```sh
tunnelkit quick 3000
tunnelkit quick 8080 --auto-stop 30
tunnelkit quick 3000 --url http://127.0.0.1:3000 --auto-stop 0
```

No Cloudflare account is required.

### `remote`

Run a dashboard-managed (token-based) tunnel. Ingress is configured in the
Cloudflare Zero Trust dashboard and pushed to the tunnel at runtime — hostnames
are printed as they arrive. Runs in the foreground until `Ctrl+C`.

```sh
tunnelkit remote [--token <token>] [--id <id>] [--label <label>]
```

| Option | Default | Description |
| --- | --- | --- |
| `--token <token>` | `$CF_TUNNEL_TOKEN` | Tunnel token. Falls back to the `CF_TUNNEL_TOKEN` env var. |
| `--id <id>` | `cli-remote` | Stable identifier for the running tunnel. |
| `--label <label>` | the id | Friendly label shown in output. |

```sh
tunnelkit remote --token "$CF_TUNNEL_TOKEN"
CF_TUNNEL_TOKEN=… tunnelkit remote --label prod
```

### `local`

Create a named tunnel, route one or more hostnames to it, and run it — the full
local lifecycle in one command. Requires that you have authenticated first with
[`tunnelkit login`](#login--logout). Runs in the foreground until `Ctrl+C`.

```sh
tunnelkit local <name> --route <hostname=service> [--route …]
tunnelkit local <name> --hostname <host> --service <url>
```

| Option | Description |
| --- | --- |
| `<name>` | Name for the tunnel (required). |
| `--route <hostname=service>` | Ingress rule, repeatable. e.g. `app.example.com=http://localhost:3000`. |
| `--hostname <host>` | A single ingress hostname (pair with `--service`). |
| `--service <url>` | The local service for `--hostname`. |

```sh
tunnelkit local my-app --route app.example.com=http://localhost:3000
tunnelkit local my-app \
  --route app.example.com=http://localhost:3000 \
  --route api.example.com=http://localhost:4000
```

Hostnames must belong to a zone in your authenticated Cloudflare account. If a
tunnel with the same name already exists on Cloudflare but isn't in use, it is
treated as an orphan and recreated.

### `login` / `logout`

`login` authenticates with Cloudflare for named (local) tunnels. It prints an
authorization URL — open it in a browser and approve. The origin certificate is
saved under `~/.tunnelkit`. `logout` removes that certificate.

```sh
tunnelkit login
tunnelkit logout
```

### `list`

List every named tunnel on the authenticated account, with its id and active
connection count. Requires `tunnelkit login`.

```sh
tunnelkit list
```

### `delete`

Delete a named tunnel by name or id. Requires `tunnelkit login`.

```sh
tunnelkit delete my-app
tunnelkit delete 6d8e…-uuid
```

### `install`

Download the `cloudflared` binary into `~/.tunnelkit/bin` (or `--install-dir`).

```sh
tunnelkit install            # latest
tunnelkit install 2024.12.2  # pin a release
```

### `status`

Show whether `cloudflared` is available, its version, and its resolved path.

```sh
tunnelkit status
```

### `version` / `help`

```sh
tunnelkit version   # or -v
tunnelkit help      # or -h, or no command
```

---

## Global options

These apply to every command.

| Option | Description |
| --- | --- |
| `--data-dir <dir>` | Override the data directory (`cert.pem`, credentials, configs). Default `~/.tunnelkit`. |
| `--install-dir <dir>` | Override the managed binary directory. Default `~/.tunnelkit/bin`. |
| `--verbose` | Print the library's internal diagnostics to stderr. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

`--` ends option parsing; everything after it is treated as a positional
argument.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (or a foreground tunnel was stopped with `Ctrl+C`). |
| `1` | An error occurred — invalid arguments, a missing binary, or a failed Cloudflare operation. Details are printed to stderr. |
