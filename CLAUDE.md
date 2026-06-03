# Claude Code Guidelines

Guidelines for Claude Code when working on **tunnelkit**.

---

## WHAT THIS PROJECT IS

tunnelkit is a **zero-dependency, TypeScript-native library** that wraps the
`cloudflared` binary and exposes a typed API over the three Cloudflare Tunnel
modes (Quick, Remote, Local). It runs on **Node 18+ and Bun**. It is consumed
as a library by host applications — there is no app, server, or UI here.

---

## WORK PROTOCOL

### During coding

- Keep the package **zero-dependency** — use only Node built-ins. Do not add a
  runtime dependency without explicit discussion; it's the project's headline
  property.
- Keep the code **cross-runtime** — no Bun-only or Node-only APIs in `src/`.
  Anything runtime-specific must be abstracted (see `src/which.ts`).
- Match the established structure and style: `TunnelKit` (high-level manager),
  `CloudflaredTunnel` (low-level wrapper), `TunnelStore` (optional persistence),
  `binary.ts` (resolve/install), shared `types.ts` / `logger.ts`.
- The library never logs on its own — route diagnostics through the optional
  `Logger` interface. Never use `console.*` in `src/`.

### After coding

- Run `bun run typecheck`, `bun run lint`, and `bun run test`.
- Run `bun run build` and confirm `dist/` emits cleanly.
- If you changed the public API, update `README.md` and `docs/api.md`.
- Add a `*.test.ts` next to non-trivial logic (parsers, path/arg building,
  store round-trips) using `bun:test`.
- Do NOT create `.md` files unless asked.
- Suggest branch/commit names per CONTRIBUTING.md — do not create them yourself.

---

## ARCHITECTURE

- **`src/tunnel.ts`** — `CloudflaredTunnel`: EventEmitter around a `cloudflared`
  child process + static one-shot commands (login/create/delete/route-dns/list).
- **`src/manager.ts`** — `TunnelKit`: lifecycle, timeouts, auto-stop, registry,
  events. The primary public entry point.
- **`src/store.ts`** — `TunnelStore`: optional JSON persistence, decoupled from
  `TunnelKit`.
- **`src/binary.ts`** — binary resolution (managed dir → PATH) and download.
- **`src/which.ts`** — cross-runtime PATH lookup (no `Bun.which`).

---

## CODE STYLE

- TypeScript throughout, strict mode. `const` by default; `let` only when reassigned.
- ESM with explicit `.js` import specifiers (required by `NodeNext`).
- Tabs, single quotes, semicolons.
- Naming: `camelCase` values, `PascalCase` types/classes, `UPPER_SNAKE_CASE` constants, `kebab-case` files.
- `any` is acceptable only for cloudflared's dynamic config payloads.

---

## DO

- ✅ Keep zero runtime dependencies
- ✅ Keep code cross-runtime (Node + Bun)
- ✅ Run typecheck + lint + test + build before finishing
- ✅ Update README + docs/api.md when the public API changes
- ✅ Route logs through the `Logger` interface

## DO NOT

- ❌ Add a runtime dependency without discussion
- ❌ Use Bun-only or Node-only APIs in `src/`
- ❌ Use `console.*` in `src/`
- ❌ Create docs/.md files without request
