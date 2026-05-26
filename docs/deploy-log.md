# TuneVault — Deploy Log

Append-only. One row per deploy. Newest at top.

**Format:** `Date | Task ID | Tag before → after | What changed (1-line) | Who`

Use `ROLLBACK` as the task ID for rollback events.

---

| Date | Task ID | Tags | Change | By |
|------|---------|------|--------|----|
| 2026-05-17 | #1651797 | `—` → `v3.6.0-baseline-2026-05-17` | Add git tagging workflow, rollback runbook, deploy log | Engineering |
| 2026-05-17 | #1651273 | `—` | Fix EBS Ops nav + unify Add Connection flow | Engineering |
| 2026-05-17 | #1649428 | `—` | Delete buttons in Run History modal | Engineering |
| 2026-05-17 | #1649328 | `—` | Proxy outbound channel + connection test fix (agent-channel.js) | Engineering |
| 2026-05-17 | #1648669 | `—` | Styled delete confirmation modal for connections | Engineering |
| 2026-05-17 | #1648801 | `—` | Fix "No agent installed" badge on registered agents | Engineering |

---

## Notes

- **Tag column:** format is `pre-task-tag → post-task-tag`. Use `—` if no tag was created.
- **Tagging convention:** `./tag-release.sh {version} {description}` — see `RELEASES.md`
- **Rollback:** if something breaks, see `docs/rollback.md`
- **Correlation:** Use the Date column to narrow down "when did X break?" — cross-reference with the task list and Render build timestamps

---

## How to add an entry

Before every deploy of a task that touches >3 files:

1. Run `./tag-release.sh {version} pre-{task-id}` and push the tag
2. Do the work, commit, push
3. After confirming live, prepend a row to this table
4. Note the post-deploy tag if you created one (`stable-{feature}`)

One row per deploy. No batching.
