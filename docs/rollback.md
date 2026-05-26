# TuneVault — Rollback Runbook

**When to use this:** Production is broken. You need to revert to a known-good state fast.

---

## Step 1 — Identify the target commit

```bash
# List recent tags (newest first)
git tag --list | sort -rV | head -20

# See what commit a tag points to
git show v3.6.0-baseline-2026-05-17 --stat

# See the deploy log for context
cat docs/deploy-log.md
```

Pick the tag/commit SHA you want to roll back to.

---

## Step 2 — Redeploy a specific commit on Render

Render does not have a "rollback" button that targets a specific commit from the dashboard. Use one of these two methods:

### Method A — Manual deploy via Render dashboard (fastest, ~2 min)

1. Go to **https://dashboard.render.com**
2. Open the **TuneVault** service
3. Click **"Manual Deploy"** → **"Deploy specific commit"**
4. Paste the commit SHA (e.g., `0eea47c`)
5. Click **Deploy**
6. Watch the build logs — wait for `Your service is live 🎉`

### Method B — Git revert + push (leaves an audit trail, ~5 min)

```bash
# Create a revert commit (does NOT delete history)
git revert HEAD...<bad-commit-sha>  # revert a range
# OR
git revert <bad-commit-sha>          # revert a single commit

git push origin main
```

Render auto-deploys on push to main. Build starts within 30s.

**When to use Method B:** The bad commit introduced a migration. Revert + new migration to undo the schema change is cleaner than a point-in-time deploy.

---

## Step 3 — Restore a Neon DB branch (schema rollback)

If the broken deploy included a **schema migration**, a Render code rollback is not enough — the schema is already mutated.

### If you created a pre-task Neon branch (recommended):

1. Go to **https://console.neon.tech**
2. Open the **TuneVault** project
3. Find the branch named `pre-{task-id}`
4. Click **"Set as primary"** or get the branch connection string
5. Update `DATABASE_URL` in Render environment variables to point at the branch
6. Trigger a Render redeploy (env var change auto-triggers it)

### If no Neon branch exists (write a down migration):

1. Write a migration in `migrations/<timestamp>_revert_<name>.sql` that reverses the DDL
2. Test it locally against a copy of the schema
3. Push — migrations run on next deploy

**Node-pg-migrate down:**
```bash
# Run down migration locally (rolls back last migration)
node migrate.js down
```

---

## Step 4 — Verify the rollback worked

Run this smoke test checklist after any rollback:

```
[ ] GET /health returns 200
[ ] Login page loads (GET /)
[ ] Can log in with Google OAuth
[ ] Dashboard loads and shows connections list
[ ] Health check runs to completion on a test connection
[ ] No 500 errors in Render logs for 2 minutes
[ ] DB migration log shows expected state (no pending down migrations)
```

Check logs:
```
Render dashboard → TuneVault → Logs tab → filter "Error"
```

Expected clean log on startup:
```
Server listening on port 3000
Database connected
Migrations complete.
```

---

## Step 5 — Document it

Append an entry to `docs/deploy-log.md`:

```
| 2026-05-17 | ROLLBACK | v3.6.0-baseline-2026-05-17 | Rolled back task #XXXX — <reason> | Kiran |
```

---

## Emergency Contacts

| Who | For |
|-----|-----|
| Polsia support | Platform/infra issues → support@polsia.com |
| Neon support | DB branch/restore issues → https://neon.tech/support |
| Render support | Deploy failures → https://render.com/support |

---

## Preventing the Next Incident

1. **Always tag before risky work:** `./tag-release.sh {version} pre-{task-id}`
2. **Always create a Neon branch before schema changes**
3. **Never deploy two tasks in the same commit** — one task per commit = surgical rollback
4. **Check `docs/deploy-log.md`** when debugging "when did X break?" — correlate timestamps

See `RELEASES.md` for the full tagging convention.
