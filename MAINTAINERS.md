# Maintainers Guide

Internal guide for tunnelkit maintainers. External contributors follow [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Guiding Principles

- **Audit before asking the contributor to validate.** Read the full diff and check adjacent code before requesting changes. The audit is the maintainer's job, not the contributor's.
- **Protect the invariants.** Zero runtime dependencies and cross-runtime (Node + Bun) support are load-bearing. A PR that adds a dependency or a runtime-specific API needs explicit justification, not a default merge.
- **Default to the established pattern.** New mechanisms need a reason the existing shape (`TunnelKit` / `CloudflaredTunnel` / `TunnelStore` / `binary.ts`) doesn't fit.
- **Warm, brief, substantive — in that order.** Open by naming something specific the contributor did well; generic "thanks for the PR" is filler. One concern reads as a short paragraph; multiple concern classes get `## Topic` sections. `file:line` inline.
- **Closure is administrative, not adversarial.** A closed PR can be reopened; frame it as housekeeping with the door open.
- **Attribution always.** Whether you build on a branch or close-and-replace, the original find earns credit.

---

## The PR Lifecycle

1. **Intake** — `gh pr checkout <N>`, read the entire diff before forming a position.
2. **Audit** — check four things before responding:
   - **Invariants** — does it keep zero-dependency + cross-runtime? (the most common reason to push back here)
   - **Adjacent code** — same-shape gaps the PR didn't touch.
   - **Tests** — is there a `*.test.ts` where [CONTRIBUTING.md → Tests](./CONTRIBUTING.md) expects one?
   - **Before/after** — walk one concrete scenario in user terms.
3. **Choose a path** (below).
4. **Merge** — squash-merge via the GitHub UI; subject = PR title `(#N)`; extended body empty except a `Co-authored-by:` trailer when reshaping a contributor's work; delete the branch.

### Review Paths

| Situation | Path |
|---|---|
| Audit clean | **Approve & merge.** Short approval naming what they did well; note checks green; merge. |
| Right shape, small additions needed, contributor engaged | **Iterate on the branch.** Push a *new* commit (never amend theirs), `merge` (not rebase) to sync `main`, post a summary of what you added. |
| Out-of-scope same-shape gaps found | **Merge as-is, follow-up PR.** Credit the find; open `fix/<scope>-...` separately. |
| Substantive concerns, you might be missing context | **Comment & wait.** Warm opener, `file:line` concerns, the question that would flip your position, a plain-English deadline (`May 25, 2026`), explicit auto-stale consequence. |
| Shape must change / you'd rewrite most of it | **Close & replace.** Apologize if you reversed after asking them to validate; explain why with `file:line`; open a replacement crediting them via `Co-authored-by:`. |
| Premise doesn't hold and no replacement warranted | **Close as not actionable.** Restate their premise fairly, show with `file:line` why it doesn't hold, state what would change your mind, invite reopen. |

When unsure between "comment & wait" and a close, default to comment & wait — it preserves optionality.

---

## Communication Norms

- **All PR-facing text in English** — comments, suggested commits, branch names — even when the maintainer conversation is in another language. Respond to non-English contributors in English, warmly.
- **Don't link this file from PR comments.** It's internal; reference [CONTRIBUTING.md](./CONTRIBUTING.md) or inline the policy in one sentence.
- **`file:line` references** for technical points, anchored inside sentences, not as bolded list leads.
- **Resolve conflicts locally**, never via the GitHub web UI. Never `--no-verify`. Never force-push to `main`.

### Suggest by Default; Act on Confirmation

When an assistant contributes review work, it always drafts (a) a suggested commit message and (b) a suggested PR comment matching the path — inline, without asking permission to draft. Acting on them is gated: ask before editing the working tree, and again before committing/pushing/posting. A "yes" to one stage is not consent for the next.

---

## Release Process

Releases are tag-driven and automated by `.github/workflows/ci.yml`. The `publish` job runs only on `v*.*.*` tags, after the `ci` job (typecheck, lint, test, build) passes.

```bash
# 1. Ensure main is green and the changelog is updated.
git checkout main && git pull origin main

# 2. Bump the version in package.json, commit.
#    (edit "version", then:)
git commit -am "release: vX.Y.Z"

# 3. Tag and push — this triggers the publish job.
git tag vX.Y.Z
git push origin main --tags
```

The workflow then runs `npm publish --provenance --access public` (using the `NPM_TOKEN` secret) and creates a GitHub release with generated notes.

**Prerequisites (one-time):**
- `NPM_TOKEN` repository secret with publish rights to the `@myrialabs/tunnelkit` package.
- The npm package name `@myrialabs/tunnelkit` is owned by the org/account behind that token.

**Versioning (semver):** `fix` → patch, `feat` → minor, any breaking public-API change → major (call it out in the PR's `## Breaking changes`).

---

## Co-authored-by Trailer

Used in squash bodies when reshaping a contributor's PR. Format is strict:

```
Co-authored-by: Full Name <email@example.com>
```

Get the email via `git log <branch> -1 --format='%ae'`. Verify the contributor's avatar appears on the merged commit.
