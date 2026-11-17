# tunnelkit docs

tunnelkit runs Cloudflare Tunnels — Quick, Remote, and Local — from Node 18+ or
Bun, through a typed API and a `tunnelkit` CLI, with zero runtime dependencies.

New here? Start with [Getting Started](./getting-started/quick-start.md) for
an install + first-tunnel walkthrough in both the API and the CLI.

## Getting Started

| Page | What it answers |
| --- | --- |
| [Quick start](./getting-started/quick-start.md) | Install tunnelkit, get `cloudflared`, and open your first tunnel — API and CLI side by side. |

## Essential

| Page | What it answers |
| --- | --- |
| [Tunnel modes](./essential/tunnel-modes.md) | What are Quick, Remote, and Local, and which one fits my use case? |
| [Events & persistence](./essential/events-and-persistence.md) | How do I observe live tunnel state, and how does tunnelkit save/restore tunnels across restarts? |

## Operations

| Page | What it answers |
| --- | --- |
| [CLI reference](./operations/cli.md) | Every `tunnelkit` command, flag, and the interactive control panel. |
| [Binary management](./operations/binary-management.md) | How tunnelkit finds, downloads, and pins the `cloudflared` binary. |

## Guides

| Page | What it answers |
| --- | --- |
| [Advanced usage](./guides/advanced-usage.md) | Error handling, orphan tunnel recovery, aborting/timeouts, and the low-level `CloudflaredTunnel` escape hatch. |

## Reference

| Page | What it answers |
| --- | --- |
| [API reference](./reference/api.md) | Every export, option, method, event, and type — the exhaustive lookup. |

## Elsewhere

- [Examples](../examples/README.md) — runnable scenarios for each mode.
- [Root README](../README.md) — project overview and quick links.
