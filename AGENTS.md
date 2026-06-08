# Agent Guidelines

This file is for coding agents working in the **tunnelkit** repository.

## Project Snapshot

tunnelkit is a zero-dependency TypeScript ESM library and CLI for Cloudflare
Tunnels. It runs on Node 18+ and Bun, wraps the `cloudflared` binary, and
supports:

- Quick tunnels through `tk.quick`.
- Remote token tunnels through `tk.remote`.
- Local named tunnels and Cloudflare-account operations through `tk.local`.

Development uses Bun for scripts and tests. Runtime package code must remain
dependency-free.

## Core Rules

- Do not add runtime dependencies without explicit maintainer approval.
- Keep library code cross-runtime for Node 18+ and Bun.
- Do not write to stdout/stderr from library core. Use the optional `Logger`.
  Terminal I/O belongs in the CLI layer.
- Use explicit `.js` import specifiers in TypeScript source.
- Keep strict TypeScript and existing ESLint rules intact.
- Do not revert or overwrite unrelated user changes.
- Update public docs when public behavior changes.

## Repository Map

- `src/index.ts` - package exports.
- `src/tunnelkit.ts` - high-level manager and typed events.
- `src/cloudflared-tunnel.ts` - low-level `cloudflared` process wrapper and
  static commands.
- `src/modes/context.ts` - mode shared context, connection tracking, startup
  waiting, abort handling.
- `src/modes/quick.ts` - TryCloudflare quick mode.
- `src/modes/remote.ts` - token/dashboard-managed mode.
- `src/modes/local.ts` - named tunnel mode, auth, DNS routing, config files,
  account list/delete.
- `src/binary.ts` and `src/binary-manager.ts` - binary install, resolve, status,
  and `tk.bin`.
- `src/store.ts` - JSON persistence for saved remote/local tunnel configs.
- `src/which.ts` - PATH lookup compatible with Node and Bun.
- `src/cli.ts` - CLI entry and dispatch.
- `src/cli-args.ts` - pure argument parsing.
- `src/cli-helpers.ts` - CLI helpers, validators, kit/store factories.
- `src/cli-commands.ts` - non-interactive command handlers.
- `src/cli-flows.ts` - interactive panel and wizards.
- `src/cli-ui.ts` - terminal UI primitives.
- `docs/api.md` - programmatic API reference.
- `docs/cli.md` - CLI reference.
- `examples/` - runnable usage examples.

Ignore obsolete architecture references to `src/tunnel.ts`, `src/manager.ts`,
or `src/modes/shared.ts`; the current implementation uses the files above.

## Style

- TypeScript, strict mode.
- Tabs, single quotes, semicolons.
- `const` by default; `let` only when reassigned.
- `camelCase` values, `PascalCase` types/classes, `UPPER_SNAKE_CASE` constants,
  `kebab-case` files.
- `any` is acceptable only where `cloudflared` returns dynamic config payloads.
- Use focused comments only when they explain non-obvious behavior.

## Testing And Checks

Use Bun:

```sh
bun run typecheck
bun run lint
bun run test
bun run build
```

For targeted test runs:

```sh
bun test src/some-file.test.ts
```

Add `*.test.ts` next to changed non-trivial logic such as parsers, path/argument
building, store round-trips, binary resolution, or lifecycle edge cases. Live
tunnel behavior can require `cloudflared` and Cloudflare credentials, but normal
unit tests should not.

## Documentation Rules

- Public API changes: update `README.md` and `docs/api.md`.
- CLI changes: update `README.md` and `docs/cli.md`.
- Example-affecting changes: update `examples/` or `examples/README.md`.
- Do not create new Markdown files unless requested or clearly needed. This
  `AGENTS.md` exists because it was requested.

## CLI Boundaries

- Keep `src/cli.ts` as dispatch and process-level error handling.
- Keep terminal rendering/prompt logic in `src/cli-ui.ts`.
- Keep interactive flows in `src/cli-flows.ts`.
- Keep non-interactive commands in `src/cli-commands.ts`.
- Keep parsing pure and tested in `src/cli-args.ts`.

## Persistence And Runtime Behavior

- Remote and local tunnels are saved through `TunnelStore` by default.
- Quick tunnels are ephemeral and should not be persisted.
- The library should not download `cloudflared` implicitly; callers choose
  `tk.bin.ensure()` or binary install helpers. CLI commands may perform the
  user-facing auto-install behavior documented in `docs/cli.md`.
- `TunnelKit.list()` should reflect every active tunnel across quick, remote,
  and local modes, including live connection info.

## Contribution Metadata

Follow `CONTRIBUTING.md` for branch names, commit messages, PR titles, and PR
descriptions. Repository-facing contribution text should be in English.
