# Claude Code Guidelines

Guidelines for Claude Code when working on **tunnelkit**.

---

## What This Project Is

tunnelkit is a zero-dependency, TypeScript-native library and CLI for running
Cloudflare Tunnels from Node 18+ or Bun. It wraps the `cloudflared` binary and
exposes typed APIs for all three tunnel modes:

- `tk.quick` - ephemeral TryCloudflare tunnels.
- `tk.remote` - dashboard-managed tunnels started from a token.
- `tk.local` - named tunnels managed through a Cloudflare account.

The package ships as ESM (`NodeNext`) from `src/` to `dist/`, exports the API
from `src/index.ts`, and exposes the `tunnelkit` command through
`dist/cli.js`.

---

## Non-Negotiables

- Keep the package zero runtime dependencies. Use Node built-ins unless the
  maintainer explicitly approves a dependency.
- Keep `src/` cross-runtime for Node 18+ and Bun. Do not introduce Bun-only APIs
  or runtime-specific shortcuts in library code.
- The library core must stay silent. Route diagnostics through the optional
  `Logger` interface. Terminal writes belong only in the CLI layer.
- Use ESM imports with explicit `.js` specifiers.
- Preserve strict TypeScript. Do not loosen compiler or lint settings to make a
  change pass.
- Do not overwrite user changes. Check `git status` and work around unrelated
  dirty files.

---

## Current Architecture

- `src/index.ts` - public package exports.
- `src/tunnelkit.ts` - high-level `TunnelKit` manager. It wires the three mode
  facades, aggregate lifecycle (`list`, `stop`, `stopAll`, `restoreAll`), typed
  events, persistence, and binary management.
- `src/cloudflared-tunnel.ts` - low-level typed `EventEmitter` wrapper around a
  `cloudflared` child process plus one-shot commands (`login`, `createTunnel`,
  `deleteTunnel`, `routeDns`, `listTunnels`).
- `src/modes/context.ts` - shared mode plumbing: `ManagerContext`,
  `ConnectionTracker`, `waitForStart`, and `AbortError`.
- `src/modes/quick.ts` - quick TryCloudflare tunnels. Handles service
  normalization, URL startup, connection tracking, and optional auto-stop.
- `src/modes/remote.ts` - token-based dashboard tunnels. Tracks config-pushed
  ingress and saves remote configs through `TunnelStore`.
- `src/modes/local.ts` - named tunnels and all account operations: auth, create,
  orphan name-conflict recovery, DNS routing, config writing, start/stop, list,
  delete, and cleanup.
- `src/binary.ts` - binary resolution, install path, download, version/status
  helpers.
- `src/binary-manager.ts` - `tk.bin` facade over binary operations.
- `src/which.ts` - cross-runtime PATH lookup.
- `src/store.ts` - JSON persistence for saved remote/local tunnel config.
- `src/types.ts` - shared public types.
- `src/logger.ts` - logger normalization and noop logger.
- `src/cli.ts` - CLI entry and dispatch only.
- `src/cli-args.ts` - pure argv parser.
- `src/cli-helpers.ts` - CLI kit/store factories, validation, start helpers, and
  terminal/runtime utilities.
- `src/cli-commands.ts` - non-interactive command handlers.
- `src/cli-flows.ts` - interactive control panel and wizards.
- `src/cli-ui.ts` - terminal rendering, colors, prompts, and clipboard helpers.
- `docs/api.md`, `docs/cli.md`, `examples/` - public documentation and usage
  examples.

Do not refer to old file names such as `src/tunnel.ts`, `src/manager.ts`, or
`src/modes/shared.ts`; they are not part of the current structure.

---

## Work Protocol

### Before Editing

- Inspect the relevant source and nearby tests before changing behavior.
- Use `rg` / `rg --files` for search.
- Check existing docs if the change touches public API or CLI behavior.
- Keep documentation-only tasks scoped to docs unless the user asks for code
  changes.

### While Editing

- Match the local style: tabs, single quotes, semicolons, `const` by default.
- Keep files kebab-case. Use `camelCase` values, `PascalCase` types/classes,
  and `UPPER_SNAKE_CASE` constants.
- Add tests next to non-trivial logic using `bun:test`.
- Keep `any` limited to dynamic `cloudflared` payloads, especially config data.
- For typed events, class/interface declaration merging is intentional for
  `TunnelKit` and `CloudflaredTunnel`.
- Prefer focused changes over broad refactors.

### After Editing

Run the narrowest useful checks first, then the full project checks when code
changed:

```sh
bun run typecheck
bun run lint
bun run test
bun run build
```

For docs-only changes, at least inspect the rendered Markdown mentally and run a
light check if practical. Mention if no automated checks were run because the
change only touched docs.

---

## Public Surface Rules

- Public API changes require updates to `README.md` and `docs/api.md`.
- CLI changes require updates to `README.md` and `docs/cli.md`.
- Examples should stay aligned with the documented API.
- `README.md` may be dirty from user edits; do not overwrite it unless the task
  explicitly requires it.
- Keep repository-facing text such as branch names, commit messages, PR titles,
  and PR descriptions in English, following `CONTRIBUTING.md`.

---

## CLI Boundaries

- Terminal output should live in `src/cli-ui.ts` and CLI command/flow files.
- `src/cli.ts` should remain the dispatch layer and `main` entry point.
- Keep pure parsing in `src/cli-args.ts` and test it there.
- Interactive behavior belongs in `src/cli-flows.ts`; non-interactive command
  behavior belongs in `src/cli-commands.ts`.
- CLI commands may auto-install/download `cloudflared` when designed to do so;
  the library API should not download unless the caller invokes `tk.bin.ensure`
  or install helpers.

---

## Verification Reference

- `bun run typecheck` - `tsc -p tsconfig.json --noEmit`
- `bun run lint` - ESLint flat config
- `bun run test` - `bun:test`
- `bun run build` - emit `dist/`
- `bun run clean` - remove `dist/`
- `bun run prepublishOnly` - clean and build

Live Cloudflare tunnel testing requires `cloudflared` and account/token setup.
Unit tests and builds should not require live tunnel credentials.
