# tunnelkit examples

Each file is a self-contained, runnable scenario. Run any with Bun:

```sh
bun run examples/<file>.ts [args]
```

Most examples download `cloudflared` on first run if it isn't already installed.

## By case

| Example | Mode | What it shows |
| --- | --- | --- |
| [`quick.ts`](./quick.ts) | Quick | Minimal quick tunnel with auto-stop |
| [`webhook-server.ts`](./webhook-server.ts) | Quick | Expose a real local HTTP server to receive webhooks |
| [`multiple-tunnels.ts`](./multiple-tunnels.ts) | Quick | Run several tunnels at once; track via `status-changed` |
| [`remote.ts`](./remote.ts) | Remote | Token-based tunnel + live `ingress-update` events |
| [`local.ts`](./local.ts) | Local | Full lifecycle: login → create → route → run, persisted |
| [`local-multi-hostname.ts`](./local-multi-hostname.ts) | Local | Map several hostnames through one tunnel |
| [`account-tunnels.ts`](./account-tunnels.ts) | Account | List account tunnels; delete one by name |
| [`restore-on-startup.ts`](./restore-on-startup.ts) | Persistence | Reload + restart saved tunnels after a restart |
| [`binary-management.ts`](./binary-management.ts) | Binary | Check status/version; install (latest or pinned) |
| [`custom-logger.ts`](./custom-logger.ts) | Config | Plug in your own logger |
| [`error-handling.ts`](./error-handling.ts) | Errors | Handle `CloudflaredMissingError` and timeouts |
| [`low-level.ts`](./low-level.ts) | Low-level | Drive `CloudflaredTunnel` directly |

## Notes

- **Quick** tunnels need no Cloudflare account.
- **Remote** tunnels need a token from the Cloudflare Zero Trust dashboard (`CF_TUNNEL_TOKEN`).
- **Local** tunnels need a Cloudflare account with a zone you control; you authenticate once via `tk.local.login()`, and hostnames must belong to your zone. Account operations (`tk.local.list()`, `tk.local.delete()`) live under `local` too.
