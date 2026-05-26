# TuneVault — Release & Tagging Convention

## Quick Start

```bash
# Tag the current HEAD before starting a risky task
./tag-release.sh 3.6.0 pre-{task-id}

# Tag a confirmed-stable state
./tag-release.sh 3.6.1 stable-proxy-rewrite

# Push the tag to GitHub
git push origin v3.6.1-stable-proxy-rewrite
```

---

## Tag Format

```
v{semver}-{description}
```

**Examples:**
| Tag | Meaning |
|-----|---------|
| `v3.6.0-baseline-2026-05-17` | Last-known-good snapshot at this date |
| `v3.6.1-pre-1651273` | Snapshot before task #1651273 |
| `v3.6.2-stable-installer` | Confirmed working after installer shipped |

**Description conventions:**
- `baseline-{YYYY-MM-DD}` — snapshot at the start of a work session
- `pre-{task-id}` — snapshot immediately before a specific engineering task begins
- `stable-{feature}` — confirmed working state after a feature is shipped and verified
- `last-known-good-{date}` — emergency rollback point

---

## Version Numbering

`{major}.{minor}.{patch}`

- **major** — breaking schema change or complete module rewrite
- **minor** — new feature shipped and verified in production
- **patch** — bug fix or small improvement

Current version: **3.6.x** (proxy rewrite era)

---

## Pre-Deploy Tagging Rule

Before any task that touches **>3 files** or **rewires routes/middleware**, the engineering agent must:

1. Create a pre-task tag: `./tag-release.sh {version} pre-{task-id}`
2. Push the tag: `git push origin v{version}-pre-{task-id}`
3. Note the tag in the task completion summary
4. If a **DB schema change** is included: create a Neon branch named `pre-{task-id}` from the Neon console before running migrations

This is a **required step**, not optional.

---

## Baseline Tag (Set Immediately)

The current HEAD (`0eea47c` — 2026-05-17) is the baseline before any further work ships.

To set it manually (run once from the repo):
```bash
git tag -a v3.6.0-baseline-2026-05-17 -m "Last-known-good baseline before regression protection was added"
git push origin v3.6.0-baseline-2026-05-17
```

---

## Known-Good Tags

| Tag | Commit | Date | Notes |
|-----|--------|------|-------|
| `v3.6.0-baseline-2026-05-17` | `0eea47c` | 2026-05-17 | First baseline; EBS Ops nav fix + Add Connection flow |

*(Append rows as tags are created)*

---

## Rollback

See `docs/rollback.md` for step-by-step rollback instructions.
