# Contributing Guide

Thanks for considering a contribution to **tunnelkit**. This guide covers the dev setup, conventions, and the submission process.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.2+ (used for dev, tests, and CI)
- The `cloudflared` binary is only needed to exercise live tunnels — not to build or unit-test.

tunnelkit ships as a zero-dependency ESM library that runs on **Node 18+ and Bun**. Use `bun` for all package management and scripts.

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/tunnelkit.git
cd tunnelkit
git remote add upstream https://github.com/myrialabs/tunnelkit.git
bun install
bun run typecheck && bun run lint && bun run test
```

All four should pass on a fresh clone.

---

## Development Workflow

```bash
# 1. Sync
git checkout main && git pull upstream main

# 2. Branch
git checkout -b feature/your-feature

# 3. Develop & verify
bun run typecheck && bun run lint && bun run test && bun run build

# 4. Commit
git commit -m "feat(manager): add X"

# 5. Push & open PR targeting main
git push origin feature/your-feature
```

---

## Project Principles

These are non-negotiable — a PR that breaks one needs explicit discussion first:

- **Zero runtime dependencies.** Use only Node built-ins. This is the library's headline property.
- **Cross-runtime.** No Bun-only or Node-only APIs in `src/`. Abstract anything runtime-specific (see `src/which.ts`).
- **No self-logging.** The library is silent unless given a `Logger`. Never use `console.*` in `src/`.
- **Public API changes are documented.** Update `README.md` and `docs/api.md` in the same PR.

---

## Code Style

- TypeScript, strict mode. `const` by default; `let` only when reassigned.
- ESM with explicit `.js` import specifiers (required by `NodeNext`).
- Tabs, single quotes, semicolons. No Prettier — manual consistency.
- Naming: `camelCase` values, `PascalCase` types/classes, `UPPER_SNAKE_CASE` constants, `kebab-case` files.

### Tests

Add a `*.test.ts` next to the source (`foo.ts` → `foo.test.ts`) using `bun:test` when the change introduces non-trivial logic where a regression would be silent — parsers, arg/path building, store round-trips, binary resolution. Skip tests for trivial one-liners or doc tweaks. Tests must pass before opening the PR.

```bash
bun test path/to/file.test.ts   # single file
bun test                        # full suite
```

---

## Submitting Changes

All repository-facing text — branch names, commit messages, PR titles, PR descriptions, and PR comments — must be in **English**, regardless of the language used elsewhere.

### Branch Naming

Format: `<type>/<description>` — lowercase, kebab-case, **exactly one `/`**.

| Type | Use |
|------|-----|
| `feature/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation |
| `chore/` | Build, refactor, dependencies, misc |

Examples: `feature/named-tunnel-events`, `fix/quick-url-parsing`, `docs/api-reference`.

### Commit Messages

Format: `<type>(<scope>): <subject>` — imperative mood, lowercase, no period, ≤72 chars.

| Type | Use |
|------|-----|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `chore` | Refactor, build, perf, dependencies |
| `release` | Version release |

Examples:

```
feat(manager): add listTunnels()
fix(binary): follow redirects on download
docs(readme): add cloudflared comparison
chore: bump typescript-eslint
```

Common scopes: `manager`, `tunnel`, `store`, `binary`, `which`, `readme`, `examples`.

### Pre-commit Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run test` passes
- [ ] `bun run build` emits `dist/` cleanly
- [ ] Public API change reflected in `README.md` + `docs/api.md`
- [ ] No new runtime dependency (or it was discussed)
- [ ] No `console.*` in `src/`

### Pull Request Format

#### Title

Same format as commit messages. GitHub uses it as the squash-commit subject.

#### Description Template

```markdown
## Summary
One or two sentences: what this PR does.

## Why
The motivation — bug it fixes, behavior it changes, constraint it addresses.

## Changes
- bullet list of concrete changes

## Notes (optional)
Trade-offs, follow-ups, areas needing extra eyes.
```

Add `## Breaking changes` whenever the public API changes, with a migration note.

### Comments on Existing PRs

Match the comment's shape to its substance — short replies read best as prose, anchored to `file:line` inline. Open with one or two sentences naming something specific you took from the review; generic "thanks" is filler. Keep it warm, brief, and substantive.

---

## After You Submit

A maintainer reads the full diff before responding: approve & merge, push follow-up commits to your branch, request discussion (1-week default window — silence past it closes the PR as auto-stale, reopenable anytime), or close with a reshape (you'll be credited in the replacement).

---

## Reference

```bash
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run lint:fix     # eslint --fix
bun run test         # bun:test
bun run build        # emit dist/
```

- [TypeScript Docs](https://www.typescriptlang.org/docs/)
- [Bun Docs](https://bun.sh/docs)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Conventional Commits](https://www.conventionalcommits.org/)

## Questions?

- [Issues](https://github.com/myrialabs/tunnelkit/issues)
