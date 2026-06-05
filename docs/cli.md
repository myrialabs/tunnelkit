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

Commands are grouped by the mode they belong to. Each mode is a namespace, so
it's always clear which mode an operation is for — for example authentication is
`tunnelkit local login`, because only named (local) tunnels touch your Cloudflare
account. Quick needs no account, and remote runs from a token.

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

Run `tunnelkit` with **no command** in a terminal to open a **live control
panel** — a persistent view of every tunnel you're running, where you can start
more and stop them individually. Outside a terminal (piped, CI), the bare
command prints help instead, so scripts are unaffected.

```sh
tunnelkit            # control panel (in a TTY)
```

The panel lists each running tunnel with its status, public URL / ingress, live
edge connections (and their locations), and uptime — all updating in place:

```
tunnelkit · 3 tunnels active   up 04:12

❯ ● quick  http://localhost:3000  https://aaa.trycloudflare.com   2 conns SIN,LAX
  ● remote prod                   3 routes                        1 conn SIN
      app.example.com    →  http://localhost:3000
      api.example.com    →  http://localhost:8080
      admin.example.com  →  http://localhost:9000
  ● local  my-app                  2 routes                        4 conns SIN,LAX,FRA,IAD
      shop.example.com   →  http://localhost:4000
      cms.example.com    →  http://localhost:4001

  ↑/↓ select · n new · x stop · c copy URL · q quit
```

When a remote/local tunnel serves a single hostname the header shows its URL;
with several it shows a route count and lists each `hostname → service` below.

| Key | Action |
| --- | --- |
| `↑`/`↓` (or `j`/`k`) | Move the selection |
| `n` | Start another tunnel (Quick / Remote / Local / a saved one) — added alongside the others |
| `x` | Stop the selected tunnel (the rest keep running) |
| `c` | Copy the selected tunnel's URL (when it serves several hostnames, pick which one to copy) |
| `q` / `Ctrl+C` | Stop **all** tunnels and exit |

Pressing `n` opens a short wizard (mode → prompts for port / token / routes); the
panel pauses while you answer, then resumes with the new tunnel in the list. With
**no** tunnels running yet, the panel skips straight to this wizard. `Esc` always
steps back one level (prompt → menu → panel) and never exits — quitting is always
an explicit `q`, which stops every tunnel. The panel runs on the alternate screen,
so on exit your terminal is exactly as you left it.

Starting a tunnel by command drops you straight into the panel, so you can add
more from there:

```sh
tunnelkit quick 3000          # starts the tunnel, then opens the panel
```

Interactivity is layered on top of the regular commands — it never replaces them:

- **Missing arguments are prompted for** when attached to a terminal; with no TTY
  they error as before, so scripted usage stays strict.
- **Destructive actions ask first.** `local delete` confirms before removing a
  tunnel. Pass [`--yes`](#global-options) (or run without a TTY) to skip the prompt.
- **No TTY, no takeover.** Run commands fall back to a static summary plus "Press
  Ctrl+C to stop", so pipes and CI logs stay clean.

---

## Quick

### `quick`

Start a quick [TryCloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
tunnel to a local service and print the public URL. In a terminal it then opens
the [control panel](#interactive-mode), where you can add more tunnels or stop
this one; otherwise it runs in the foreground until `Ctrl+C`.

```sh
tunnelkit quick <port|url> [--auto-stop <minutes>]
```

| Option | Default | Description |
| --- | --- | --- |
| `<port\|url>` | — | What to expose (required). A bare port is shorthand for `http://localhost:<port>`; a full URL (`http://localhost:8080`, `https://192.168.1.5:8443`) is used as-is. |
| `--auto-stop <minutes>` | `0` | Minutes until the tunnel auto-stops; `0` (the default) means it runs until you stop it. |

```sh
tunnelkit quick 3000
tunnelkit quick http://localhost:8080 --auto-stop 30
tunnelkit quick https://127.0.0.1:8443
```

No Cloudflare account is required.

---

## Remote

### `remote run`

Run a dashboard-managed (token-based) tunnel. Ingress is configured in the
Cloudflare Zero Trust dashboard and pushed to the tunnel at runtime — hostnames
are printed as they arrive. Runs in the foreground until `Ctrl+C`.

```sh
tunnelkit remote run [name] [--token <token>] [--label <label>] [--id <id>]
```

| Option | Default | Description |
| --- | --- | --- |
| `[name]` | — | A saved tunnel to reuse. With no `--token`, its stored token is loaded. |
| `--token <token>` | `$CF_TUNNEL_TOKEN` | Tunnel token. Falls back to the `CF_TUNNEL_TOKEN` env var. |
| `--label <label>` | the name/id | Friendly name. When given with a fresh `--token`, the token is saved under it for reuse. |
| `--id <id>` | `cli-remote` | Stable identifier for the running tunnel. |

Supply the token once, then reuse it by name. Two equivalent ways to pass a
token the first time:

```sh
# (a) as a flag
tunnelkit remote run --token "$CF_TUNNEL_TOKEN" --label prod

# (b) via the environment
CF_TUNNEL_TOKEN=… tunnelkit remote run --label prod
```

Either of the above saves the token under `prod`, so later you can just:

```sh
tunnelkit remote run prod
```

Pass `--no-save` to run without reading or writing the saved store.

---

## Local

Local tunnels are the only mode that talks to your Cloudflare account, so
authentication, listing, and deleting all live under `local`.

### `local login` / `local logout`

`local login` authenticates with Cloudflare for named tunnels. It prints an
authorization URL — open it in a browser and approve. The origin certificate is
saved under `~/.tunnelkit`. `local logout` removes that certificate.

```sh
tunnelkit local login
tunnelkit local logout
```

### `local run`

Create a named tunnel, route one or more hostnames to it, and run it — the full
local lifecycle in one command. Requires that you have authenticated first with
[`tunnelkit local login`](#local-login--local-logout). Runs in the foreground
until `Ctrl+C`.

```sh
tunnelkit local run <name> --route <hostname=service> [--route …]
tunnelkit local run <name> --hostname <host> --service <url>
```

| Option | Description |
| --- | --- |
| `<name>` | Name for the tunnel (required). |
| `--route <hostname=service>` | Ingress rule, repeatable. e.g. `app.example.com=http://localhost:3000`. |
| `--hostname <host>` | A single ingress hostname (pair with `--service`). |
| `--service <url>` | The local service for `--hostname`. |

```sh
tunnelkit local run my-app --route app.example.com=http://localhost:3000
tunnelkit local run my-app \
  --route app.example.com=http://localhost:3000 \
  --route api.example.com=http://localhost:4000
```

The tunnel and its routes are saved, so you can rerun it later without
respecifying anything:

```sh
tunnelkit local run my-app    # reuse the saved tunnel + routes
```

Pass `--no-save` to skip saving (and to ignore any previously saved tunnel of
the same name).

Hostnames must belong to a zone in your authenticated Cloudflare account. If a
tunnel with the same name already exists on Cloudflare but isn't in use, it is
treated as an orphan and recreated.

### `local list`

List every named tunnel on the authenticated account, with its id and active
connection count. Requires `tunnelkit local login`.

```sh
tunnelkit local list
```

### `local delete`

Delete a named tunnel by name or id. Requires `tunnelkit local login`.

```sh
tunnelkit local delete my-app
tunnelkit local delete 6d8e…-uuid
```

Deleting also drops any locally-saved entry for that tunnel (see below).

---

## General

### `saved` / `forget`

The CLI remembers tunnels you run so you can reuse them by name — `remote run`
saves its token, `local run` saves its tunnel and routes. These commands inspect
and prune that local store (`<dataDir>/config.json`); neither touches Cloudflare.

```sh
tunnelkit saved            # list saved remote + local tunnels
tunnelkit forget prod      # remove the saved "prod" entry
```

`forget` only removes the saved config. To also delete a named tunnel from
Cloudflare, use [`local delete`](#local-delete). Use `--no-save` on any run to
skip the store entirely.

### `dashboard`

Print a shortcut link to the Cloudflare Zero Trust **Tunnels** dashboard. The
`?to=/:account/…` form lets Cloudflare resolve the signed-in account, so it goes
straight to your tunnels without an account id — handy for creating or
configuring the remote (dashboard-managed) tunnels you run with
[`remote run`](#remote-run).

```sh
tunnelkit dashboard
```

```
  Cloudflare Tunnels dashboard:

    https://dash.cloudflare.com/?to=/:account/tunnels
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

With no command, `tunnelkit` opens the [control panel](#interactive-mode) in a
terminal, or prints help when output is not a TTY.

---

## Global options

These apply to every command.

| Option | Description |
| --- | --- |
| `--yes`, `-y` | Skip confirmation prompts (e.g. `local delete`). Confirmations are also skipped automatically without a TTY. |
| `--no-save` | Don't read or write the saved-config store (`<dataDir>/config.json`) for this run. Applies to `remote run` and `local run`. |
| `--data-dir <dir>` | Override the data directory (`cert.pem`, credentials, configs, saved store). Default `~/.tunnelkit`. |
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
| `0` | Success (or a foreground tunnel was stopped with `Ctrl+C` / `q`). |
| `1` | An error occurred — invalid arguments, a missing binary, or a failed Cloudflare operation. Details are printed to stderr. |
| `130` | An interactive prompt or menu was cancelled (`Esc` / `Ctrl+C`). |
