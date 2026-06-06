# Claude Code Guidelines

Guidelines for Claude Code when working on **tunnelkit**.

---

## WHAT THIS PROJECT IS

tunnelkit is a **zero-dependency, TypeScript-native library** that wraps the
`cloudflared` binary and exposes a typed API over the three Cloudflare Tunnel
modes (Quick, Remote, Local). It runs on **Node 18+ and Bun**. It is consumed
as a library by host applications, and also ships a thin `tunnelkit` CLI
(`src/cli.ts` → `dist/cli.js`, the package `bin`) for terminal use.

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
  `Logger` interface. The library core must not write to the terminal directly.
  `src/cli.ts` is the one terminal-facing entry: it may write to
  `process.stdout` / `process.stderr` (it is the CLI), but everything else in
  `src/` stays silent.

### After coding

- Run `bun run typecheck`, `bun run lint`, and `bun run test`.
- Run `bun run build` and confirm `dist/` emits cleanly.
- If you changed the public API, update `README.md` and `docs/api.md`.
- If you changed the CLI, update `README.md` and `docs/cli.md`.
- Add a `*.test.ts` next to non-trivial logic (parsers, path/arg building,
  store round-trips) using `bun:test`.
- Do NOT create `.md` files unless asked.
- Suggest branch/commit names per CONTRIBUTING.md — do not create them yourself.

---

## ARCHITECTURE

- **`src/tunnel.ts`** — `CloudflaredTunnel`: EventEmitter around a `cloudflared`
  child process + static one-shot commands (login/create/delete/route-dns/list).
- **`src/manager.ts`** — `TunnelKit`: composes the three mode facades, owns the
  cross-cutting concerns (binary, aggregate `list()`/`stopAll()`, store, events),
  and builds the shared `ManagerContext`. The primary public entry point.
- **`src/modes/`** — one facade per mode, reached via `tk.quick` / `tk.remote` /
  `tk.local`. `shared.ts` holds `ManagerContext`, `waitForStart`, and
  `ConnectionTracker` (per-tunnel live edge connections, surfaced as
  `ActiveTunnel.connections`); `quick.ts`, `remote.ts`, `local.ts` each own their
  registry and lifecycle. All account/auth operations (login, list, delete,
  route-dns) live in `local.ts`.
- **`src/store.ts`** — `TunnelStore`: optional JSON persistence, decoupled from
  `TunnelKit`.
- **`src/binary.ts`** — binary resolution (managed dir → PATH) and download.
- **`src/which.ts`** — cross-runtime PATH lookup (no `Bun.which`).
- **`src/cli.ts`** — the `tunnelkit` CLI entry (the package `bin`). Thin wrapper
  over `TunnelKit`; the only file that writes to the terminal directly.
- **`src/cli-args.ts`** — pure, tested argv parser used by the CLI.

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
- ❌ Write to the terminal from the library core (everything in `src/` except
  `src/cli.ts`) — no `console.*`, no `process.stdout`/`stderr`
- ❌ Create docs/.md files without request
