# tunnelkit examples

Each file is a self-contained, runnable scenario. Run any with Bun:

```sh
bun run examples/<file>.ts [args]
```

All examples download `cloudflared` on first run if it isn't already installed.

## Files

| Example | Mode | What it shows |
| --- | --- | --- |
| [`quick.ts`](./quick.ts) | Quick | Minimal quick tunnel with auto-stop |
| [`remote.ts`](./remote.ts) | Remote | Token-based tunnel + live `ingress-update` events |
| [`local.ts`](./local.ts) | Local | Full lifecycle: login → prepare → start |
| [`restore-on-startup.ts`](./restore-on-startup.ts) | Persistence | Restore all saved tunnels with one call |
| [`events.ts`](./events.ts) | Events | `status-changed` and `connection` events |

## Notes

- **Quick** tunnels need no Cloudflare account.
- **Remote** tunnels need a token from the Cloudflare Zero Trust dashboard (`CF_TUNNEL_TOKEN`).
- **Local** tunnels need a Cloudflare account with a zone you control; authenticate once via `tk.local.login()`, then hostnames must belong to that zone.
