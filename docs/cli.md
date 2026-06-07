# tunnelkit CLI reference

Installing tunnelkit globally exposes a `tunnelkit` command that drives the same three tunnel modes
as the library — from your terminal, no code.

```sh
bun add -g tunnelkit
# or: npm i -g tunnelkit
```

The CLI needs the `cloudflared` binary. It is downloaded automatically into `~/.tunnelkit/bin` on
first use; you can also run `tunnelkit install` ahead of time, or rely on a `cloudflared` already
on your `PATH`.

```sh
tunnelkit <command> [options]
```

Commands are grouped by mode. Authentication is under `local` because only named tunnels touch your
Cloudflare account — quick needs nothing and remote runs from a token.

- [Interactive mode](#interactive-mode)
- [Quick](#quick)
  - [`quick`](#quick-1)
- [Remote](#remote)
  - [`remote run`](#remote-run)
- [Local](#local)
  - [`local login` / `local logout`](#local-login--local-logout)
  - [`local run`](#local-run)
  - [`local list`](#local-list)
  - [`local delete`](#local-delete)
- [General](#general)
  - [`saved` / `forget`](#saved--forget)
  - [`dashboard`](#dashboard)
  - [`install`](#install)
  - [`status`](#status)
  - [`version` / `help`](#version--help)
- [Global options](#global-options)
- [Exit codes](#exit-codes)

---

## Interactive mode

Run `tunnelkit` with **no command** in a terminal to open a **live control panel** — a persistent
view of every running tunnel, updating in place. Piped or in CI the bare command prints help
instead, so scripts are unaffected.

```sh
tunnelkit            # control panel (in a TTY)
```

The panel shows each tunnel's status, public URL or ingress routes, live edge connections with their
locations, and uptime:

```
tunnelkit · 3 tunnels active   up 04:12

❯ ● quick  http://localhost:3000  https://aaa.trycloudflare.com  2 conns SIN,LAX
  ● remote prod                   3 routes                       1 conn  SIN
      app.example.com    →  http://localhost:3000
      api.example.com    →  http://localhost:8080
      admin.example.com  →  http://localhost:9000
  ● local  my-app                 2 routes                       4 conns SIN,LAX,FRA,IAD
      shop.example.com   →  http://localhost:4000
      cms.example.com    →  http://localhost:4001

  ↑/↓ select · n new · x stop · c copy URL · q quit
```

| Key | Action |
| --- | --- |
| `↑`/`↓` (or `j`/`k`) | Move the selection |
| `n` | Start another tunnel — opens a mode wizard (Quick / Remote / Local / a saved one) |
| `x` | Stop the selected tunnel; the others keep running |
| `c` | Copy the selected tunnel's URL to the clipboard |
| `q` / `Ctrl+C` | Stop **all** tunnels and exit |

Pressing `n` opens a wizard (mode → prompts for port / token / routes); `Esc` steps back one level
without exiting. With no tunnels running the wizard opens automatically. Starting a tunnel by
command (e.g. `tunnelkit quick 3000`) opens the panel automatically, so you can add more from
there.

Outside a TTY, commands run non-interactively — missing arguments error, destructive actions skip
confirmation, and there is no panel. Pass [`--yes`](#global-options) to suppress confirmation
prompts in a TTY.

---

## Quick

### `quick`

Start a quick [TryCloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
tunnel to a local service. Prints the public URL, then opens the [control panel](#interactive-mode)
in a terminal; otherwise runs in the foreground until `Ctrl+C`. No Cloudflare account required.

```sh
tunnelkit quick <port|url> [--auto-stop <minutes>]
```

| Option | Default | Description |
| --- | --- | --- |
| `<port\|url>` | — | What to expose (required). A bare port is shorthand for `http://localhost:<port>`; a full URL is used as-is. |
| `--auto-stop <minutes>` | `0` | Minutes until auto-stop; `0` means run until stopped. |

```sh
tunnelkit quick 3000
tunnelkit quick http://localhost:8080 --auto-stop 30
tunnelkit quick https://127.0.0.1:8443
```

---

## Remote

### `remote run`

Run a dashboard-managed (token-based) tunnel. Ingress is configured in the Cloudflare Zero Trust
dashboard and pushed to cloudflared at runtime — hostnames are printed as they arrive. Opens the
panel in a terminal; otherwise runs in the foreground until `Ctrl+C`.

```sh
tunnelkit remote run [name] [--token <token>] [--name <name>] [--id <id>]
```

| Option | Default | Description |
| --- | --- | --- |
| `[name]` | — | A saved tunnel to reuse; its stored token is loaded automatically. |
| `--token <token>` | `$CF_TUNNEL_TOKEN` | Tunnel token; falls back to the env var. |
| `--name <name>` | the name or id | Name used to save & reuse the token. |
| `--id <id>` | `cli-remote` | Stable identifier for the running tunnel. |

Supply the token once, then reuse it by name:

```sh
tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --name prod   # first time — saves as "prod"
tunnelkit remote run prod                                       # subsequent runs
```

Pass `--no-save` to run without reading or writing the store.

---

## Local

Local tunnels are the only mode that talks to your Cloudflare account, so authentication, listing,
and deleting all live under `local`.

### `local login` / `local logout`

`local login` authenticates with Cloudflare for named tunnels. It prints an authorization URL —
open it in a browser and approve. The origin certificate is saved under `~/.tunnelkit`.
`local logout` removes that certificate.

```sh
tunnelkit local login
tunnelkit local logout
```

### `local run`

Create a named tunnel, route one or more hostnames to it, and run it — the full local lifecycle in
one command. Requires authentication with [`tunnelkit local login`](#local-login--local-logout).
Opens the panel in a terminal; otherwise runs in the foreground until `Ctrl+C`.

```sh
tunnelkit local run <name> --route <hostname=service> [--route …]
tunnelkit local run <name> --hostname <host> --service <url>
```

| Option | Description |
| --- | --- |
| `<name>` | Name for the tunnel (required). |
| `--route <hostname=service>` | Ingress rule, repeatable. e.g. `app.example.com=http://localhost:3000`. |
| `--hostname <host>` | Single ingress hostname (pair with `--service`). |
| `--service <url>` | Local service for `--hostname`. |

```sh
tunnelkit local run my-app --route app.example.com=http://localhost:3000
tunnelkit local run my-app \
  --route app.example.com=http://localhost:3000 \
  --route api.example.com=http://localhost:4000
tunnelkit local run my-app    # reuse the saved tunnel and routes
```

The tunnel and its routes are saved by default. Pass `--no-save` to skip saving (and to ignore any
previously saved tunnel of the same name). If a tunnel with the same name already exists on
Cloudflare but isn't in use, it is treated as an orphan and recreated.

### `local list`

List every named tunnel on the authenticated account, with its id and active connection count.

```sh
tunnelkit local list
```

### `local delete`

Delete a named tunnel by name or id. Prompts for confirmation in a terminal (skip with `--yes`).
Also drops any locally-saved entry for that tunnel.

```sh
tunnelkit local delete my-app
tunnelkit local delete 6d8e…-uuid
```

---

## General

### `saved` / `forget`

`saved` lists tunnels saved locally for reuse — remote tokens and local tunnel configs. `forget`
removes a single entry by name. Neither command touches Cloudflare; they operate on the local store
only (`<dataDir>/config.json`).

```sh
tunnelkit saved            # list all saved remote + local tunnels
tunnelkit forget prod      # remove the saved "prod" entry
```

To also delete a named tunnel from Cloudflare, use [`local delete`](#local-delete). Use `--no-save`
on any run to skip the store entirely.

### `dashboard`

Print a shortcut link to the Cloudflare Zero Trust **Tunnels** dashboard — the `?to=/:account/…`
form resolves the signed-in account, so no account id is needed.

```sh
tunnelkit dashboard
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
tunnelkit help      # or -h
```

With no command, `tunnelkit` opens the [control panel](#interactive-mode) in a terminal, or prints
help when not in a TTY.

---

## Global options

These apply to every command.

| Option | Description |
| --- | --- |
| `--yes`, `-y` | Skip confirmation prompts (e.g. `local delete`). Also skipped automatically without a TTY. |
| `--no-save` | Don't read or write the saved-config store for this run. Applies to `remote run` and `local run`. |
| `--data-dir <dir>` | Override the data directory (`cert.pem`, credentials, configs, saved store). Default `~/.tunnelkit`. |
| `--install-dir <dir>` | Override the managed binary directory. Default `~/.tunnelkit/bin`. |
| `--verbose` | Print library diagnostics to stderr. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

`--` ends option parsing; everything after it is treated as a positional argument.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (or a foreground tunnel was stopped with `Ctrl+C` / `q`). |
| `1` | An error occurred — invalid arguments, a missing binary, or a failed Cloudflare operation. Details are printed to stderr. |
| `130` | An interactive prompt or menu was cancelled (`Esc` / `Ctrl+C`). |
