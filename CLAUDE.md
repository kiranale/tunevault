# TuneVault — CLAUDE.md

## What this app does
TuneVault connects to Oracle databases and runs comprehensive health checks (200+ checks & ops across 13 DB categories + 5 EBS categories). Users connect via Direct TCP or a lightweight HTTP proxy agent installed on the Oracle server. Results are displayed in a 9-tab dashboard with PDF/XLSX export.

## Stack
Node.js + Express, PostgreSQL (Neon), Render deployment. Vanilla JS frontend (no build step). Static HTML in `public/`.

## Directory map
- `server.js` — single Express entry point (~5000 lines); all routes, business logic, scheduler
- `db/setup/` — canonical DBA setup SQL (tunevault_reader.sql = least-privilege role script)
- `routes/` — modular Express routers: admin-agents.js (fleet list, log-tail, CSV export); tns-topology.js (7-query TNS analysis, snapshots, share links); ready-to-test.js (go/no-go badges); ssh-connectivity.js (SSH key store + test); upgrade-verifications.js (agent verification); ssh-profiles.js (per-connection SSH profiles); installer-validation.js (OL7/OL8 CI validation); privileges.js (role script docs); seo.js (sitemap); ai-discoverability.js (llms.txt, ai-plugin.json); payments.js (Razorpay); billing.js (usage + history); blog.js; addm.js; performance-advisor.js (ADDM + SQL Tuning Advisor); performance.js (top-sql, wait-events, blocking); housekeeping.js; sessions.js; outreach-*.js (lock/approve/audit); security.js (CISO page, lockdown); ebs-deep.js (Deep EBS status + sanity); ebs-deep-reports.js; ebs-control.js (EBS catalog + lockdown); control-runbook.js (4 recovery runbooks); patches.js (patch advisor); schedules.js (autonomous monitoring); fleet.js (fleet overview); ebs-validation.js (16 EBS smoke tests); proxy-self-test.js; reports.js (DB/EBS/combined PDF+XLSX); test-harness.js; ebs-ssh-checks.js (SSH check runner); os-exec.js (whitelisted OS cmds via proxy); db-ops.js (32 ops, 11 categories); ebs-middleware.js (WLS/Apache/OHS ops, rolling bounce SSE); ebs-concurrent.js (running requests, node ops); ssh-targets.js (admin SSH vault); user-ssh-targets.js (user SSH vault); apps-tunnel.js (EBS/WebLogic HTTP tunnel); team.js; roles.js (RBAC + approvals); tuneops.js (ticketing); console.js (SQL editor + terminal); ssh-execute.js; sql-execute.js; fndload.js (FNDLOAD wizard); tunebot.js (AI chat); ssh-install.js (Add Connection wizard + SSE install stream); page-events.js (CTA tracking)
- `db/` — DB query helpers: index.js (Pool); per-table CRUD modules for tns-topology, ebs-adop-state, connection-health, installer-validation, payments, blog, outreach, ebs-deep, ebs-control, performance, advisor-findings, addm-runs, email-drip, patches, schedules, fleet, teams, tier-usage, tuneops-notifications, compliance-reports, roles, sql-audit-log, fndload, proxy-exec-audit
- `config/` — pricing.js (plan prices); finding_weights.json (severity×blast_radius weights for Top 5 ranking)
- `lib/` — ai-client.js (OpenAI + Anthropic calls); oracle/service-classifier.js (CDB/PDB service ranking); ebs/adop-state.js (ADOP patch-cycle detector)
- `data/` — oracle-patches.json (CPU/PSU patch index 19c/21c/23ai/12.2 + EBS 12.2; refresh due 2026-07-22)
- `services/` — adop-detector.js; oracle-runner.js (SSH-first query, pooled SSH); agent-channel.js (Postgres durable long-poll); outreach-mailer.js; drip-mailer.js; welcome-email.js; alert-mailer.js; schedule-runner.js; ebs-ssh-checks.js (24-check SSH catalog); ebs-12-2-checks.js (30 EBS 12.2.7+ checks); db-ops-executor.js (86-op catalog); tier-limits.js; tuneops-mailer.js; tuneops-ticket-engine.js
- `middleware/` — auth.js (requireAuth/Admin/ConnectionOwner/Role); security.js (helmet, rate limiters, zod); tier-enforce.js (402 on cap hit)
- `public/` — static HTML pages
- `proxy/` — PROXY_SCHEMA.md (full proxy payload schema); fixtures/synthetic-ebs-payload.json
- `migrations/` — node-pg-migrate JS files
- `oracle-client.js` — Oracle DB connection + query helpers; APPS.DUAL probe gates EBS Operations
- `oracle-proxy.js` / `oracle-proxy.py` — proxy binaries served as downloads
- `pdf-generator.js` — PDF report generation
- `crypto-utils.js` — AES-256-GCM encrypt/decrypt
- `install.sh` / `uninstall.sh` — agent installer/uninstaller served at /install.sh + /uninstall.sh
- `scripts/ci-installer-validation.sh` — OL7/OL8 CI install validation (7 probes, JSON result)

## Database
- `oracle_connections` — connections: host/port/creds (AES-GCM), proxy_url/key, server_type db|apps|both, connectivity_mode tns|ssh_sqlplus|both, privilege_model reader|sysdba, apps_pwd_enc, weblogic_pwd_enc, ebs_instance_name, auto_upgrade_enabled, agent metadata (proxy_version, python_version, cx_oracle_version, os_id)
- `agent_upgrade_audit` — auto-upgrade lifecycle: from/to version, status queued|in_progress|completed|failed, verification_payload/status
- `health_checks` — HC runs: results, score, ai_analysis, summary_text, ebs_summary, analysis_stage, ai_recommendations JSONB
- `analysis_runs` — per-run AI pipeline timing: t0-t6 timestamps, token counts, finish_reason
- `check_results` — individual check results per run: 51+ core checks + EBS_* checks; category='ebs_operations'
- `users` — user accounts: email, google_id, magic link tokens
- `company_hc_usage` — free-tier HC usage per company domain
- `health_check_requests` — async HC job queue
- `checks_catalogue` — master catalogue: 92 core check definitions (100+ with on-demand panels)
- `payments` — Razorpay orders: one_time + subscription
- `subscriptions` — subscription state: razorpay_subscription_id, plan_tier, status, period
- `user_credits` — check quota: checks_remaining, plan_tier
- `blog_posts` — SEO blog: title, slug, content, published_at, coming_soon BOOL
- `roadmap_reminders` — deferred roadmap items with trigger_condition_json
- `payment_test_runs` — admin payment pipeline test runs
- `payment_method_test_runs` — live checkout tests per method (upi/netbanking/card)
- `outreach_batches` — email wave config: name, template, approval_status; 60-min approval expiry
- `outreach_recipients` — prospects per batch: email, send_authorized, status
- `outreach_send_log` — append-only audit of every sendOutreachEmail() call
- `ebs_deep_reports` — Deep EBS report runs: findings_json, ai_analysis, is_demo
- `ebs_sanity_runs` — EBS Sanity Check results per connection: overall_status, findings_json
- `ebs_control_commands` — whitelisted EBS control catalog: slug, shell_template, risk_level; seeded by migration
- `audit_log` — append-only EBS control preview attempts: slug, allowed, rejection_reason
- `payment_reconciliation` — append-only payment error log for manual review
- `sql_fix_cache` — AI SQL fix recommendations: sql_id, plan_hash_value, fix_sql; 24h TTL
- `analytics_events` — full funnel event log: 14 event types, user_id, session_id, properties JSONB
- `page_events` — landing page CTA tracking: event_type, event_name, ip_hash SHA-256
- `email_drip_state` — per-user drip state: sequence_step 1/2/3, sent_at, suppressed_at
- `connection_schedules` — autonomous monitoring: cadence_minutes, enabled, next_run_at, alert_email, snoozed_until
- `finding_history` — per-check delta state: finding_key, severity, first_seen_at, resolved_at; unique on (connection_id, finding_key)
- `sql_tuning_findings` — SQL tuning snapshot per connection: sql_id, plan_hash, metrics_json, ai_recommendation_text
- `outreach_attempts` — hard-lock audit: every sendOutreachEmail() attempt, blocked status
- `ssh_targets` — admin SSH credential vault: host, os_user, auth_method, AES-GCM key; user_id=NULL=admin
- `ssh_audit` — SSH execution log: command_key, exit_code, was_rejected, rejection_reason
- `ebs_validation_runs` — EBS smoke-test run results: summary JSONB + tests JSONB
- `teams` — team accounts: name, owner_id, plan_tier
- `team_members` — team membership: (team_id, user_id) + role admin|senior_dba|junior_dba|viewer
- `team_invites` — invite tokens: email, role, 7-day expiry
- `rbac_audit_log` — permission-denied API attempts: method, path, required_role, actual_role
- `sample_report_leads` — /sample-report email captures
- `tuneops_notification_prefs` — per-user TuneOps email prefs: enabled, severity threshold
- `tuneops_notification_mutes` — per-user per-connection 24h mutes
- `tuneops_notification_log` — send dedup log: 1h window, 10/ticket/hour rate limit
- `user_mfa` — TOTP secret (AES-GCM), is_enabled, recovery_codes (bcrypt JSONB)
- `mfa_attempts` — MFA attempt log: drives 5-attempt/15-min lockout
- `sso_configs` — SAML 2.0 per domain: sso_url, entity_id, certificate, role mapping; enterprise only
- `sso_login_log` — SSO login audit: company_domain, email, succeeded, failure_reason
- `api_keys` — per-user API keys: key_prefix, key_hash SHA-256, revoked_at
- `compliance_reports` — compliance report records: report_type, date_from/to, generated_data JSONB; business+ only
- `alert_policies` — alert threshold rules: check_type, conditions JSONB, escalation_chain, sustained_minutes
- `alert_events` — alert instances: policy_id, severity, status triggered|acknowledged|escalated|resolved
- `activity_log` — unified DBA audit: action_type, detail JSONB, connection_id, duration_ms, ip_address
- `roles` — per-team role definitions: slug, branch dba|functional|dev|management, permissions JSONB; 8 defaults seeded
- `approval_requests` — TuneOps approval gate: ticket_id, status pending|approved|rejected, approver_role_id
- `tuneops_tickets` — tickets: TO-XXXX, canonical_key, severity, status OPEN→RESOLVED, source, reopened_count
- `clone_recipes` — EBS clone wizard: source/target connections, clone_steps JSONB, last_run_status
- `clone_history` — clone run log: status running|success|failed|aborted, step_results JSONB
- `sql_audit_log` — execute-sql attempts: sql_text, allowed, block_reason, success, duration_ms
- `sql_console_history` — SQL Console history: 90-day retention, indexed by (user_id, connection_id)
- `fndload_history` — FNDLOAD audit: action download|diff|upload, object_type, pre_state_ldt for rollback
- `user_preferences` — HC completion email toggle + 10-min throttle; unique on user_id
- `email_log` — outbound email audit: template, hc_id, status sent|failed|suppressed, postmark_message_id
- `advisor_findings` — ADDM/STA snapshot per connection: addm_tasks, ai_summary, licensed flag
- `addm_runs` — ADDM history: task_name, snap IDs, db_time_seconds, findings JSONB, ai_commentary
- `agent_tunnels` — tunnel metadata: tunnel_uuid, dns_hostname, status pending→active→uninstalled
- `agent_reg_tokens` — install tokens: 30-min expiry, redeemed by install.sh via /api/agent/provision
- `agents_log_buffer` — last 500 log lines per agent; read by /admin/agents log-tail modal
- `proxy_exec_audit` — OS exec attempts: command_id, exit_code, duration_ms, succeeded
- `ssh_install_credentials` — encrypted SSH creds for Add Connection wizard: install_status, install_log
- `installer_validation_runs` — OL7/OL8 CI validation results: probe_1..6 status, trigger_source
- `connection_health_runs` — 8-probe diagnostic per connection: probe_1..8 status+ms, drives fleet-health dots
- `connection_ssh_profiles` — SSH profiles per connection role (db_host/apps_tier/web_tier): auth_method, known_hosts_pin
- `smoke_test_runs` — end-to-end smoke test runs: overall_status, steps_jsonb
- `ebs_credentials` — EBS/WebLogic passwords: credential_type apps|system|sys|weblogic_admin, AES-GCM encrypted
- `credential_access_log` — in-memory decryption audit: credential_type, action, accessed_at
- `ebs_adop_state` — ADOP state per connection: patching bool, phase, session_id; drives red banner + op-gating
- `validation_runs` — validation suite runs: status, share_token (7-day), summary_json
- `check_failure_bundles` — per-check failure context: ORA error, traceback, proxy log tail; 30-day purge
- `tns_topology_snapshots` — TNS topology per connection: service_names[], share_token; 30-day purge
- `agent_diagnose_runs` — 8-probe diagnose results: probes JSONB, overall_status; last 50 kept
- `agent_install_failures` — failed install.sh log: error_class, journalctl_tail, install_log_tail
- `agent_command_results` — one-shot command results queued via /pull-journalctl
- `agent_crash_alerts_sent` — crash-loop email dedup: once per 24h per connection
- `agent_restart_events` — proxy restart log: reason_code, uptime_seconds; ≥5 same reason/10min → restart_loop flag
- `agent_channel_state` — agent poll state: last_poll_at, last_heartbeat_at, claim_holder
- `agent_command_queue` — durable command queue: SELECT FOR UPDATE SKIP LOCKED, 60s claim expiry

## External integrations
- **OpenAI** — direct API calls (gpt-4o-mini) for AI summaries, structured recommendations, executive summaries. Key: OPENAI_API_KEY env var on Render.
- **Anthropic/Claude** — Claude API for additional AI features. Key: ANTHROPIC_API_KEY env var on Render.
- **Google OAuth** — sign-in with Google
- **Razorpay** — one-time payments + monthly subscriptions (USD only); live keys RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET
- **Resend** — transactional emails (magic links, HC completion emails, alert emails). RESEND_API_KEY env var. Domain tunevault.app verified on Resend (Cloudflare DNS auto-configured).
- **Tunnel API** — auto-provisions secure tunnels + DNS CNAME for one-line agent install (optional env vars)

## Add Connection route rule

All Add Connection links in the app MUST point to `/connections/new` — the single canonical v6 wizard (routes/ssh-install.js). `/setup/fresh` is a 301 permanent redirect to it as of 2026-05-22. Adding a new entry point? Verify it points to `/connections/new`, not `/setup/fresh`.

## Known Issues (as of 2026-06-09)

🟡 High:
- AI summary not showing on EBS app tier health checks — runAIAnalysis() is called (3.20.7+, verified by [ai] log), but summary text not surfacing in report UI. Needs investigation on live HC run with ebs12212-app-dev.
- apex-lab (192.168.56.101, OEL 8.10, Oracle 23ai) — agent never installed.
- EBS Ops cards — need full redesign and wiring (service control panel, start/stop per component). NOT started — review/design required before implementation.
- forms-c4ws_server1 showing as critical — optional server, should be warning or skipped.
- App tier score showing 30 instead of 15 — investigate scoring logic for EBS app tier.

🟢 Low:
- Blog articles need seeding to DB — run `node scripts/seed-blog.js` in Render shell, or POST /api/admin/seed-blog. AWR/ASH, 19c upgrade, tablespace mgmt are now full articles; 5 stubs remain.
- ~20 debug/fix/verify scripts in repo root — move to scripts/debug/ or delete.
- README.md CI badge URLs point to Polsia-Inc/tunevault — should be kiranale/tunevault.
- OPP check not yet added to EBS app tier checks.

## Recent changes

- 2026-06-09: FIX — HC completion email Impact column: f.detail → f.details (plural) for EBS app tier findings. The field is `details` in the proxy findings structure; f.detail was always undefined so Impact showed "—".
- 2026-06-09: FIX — DB Ops Run endpoint: removed stale cxOracleVersion pre-check that blocked runs when oracle_connections.cx_oracle_version was null (stale metadata). The proxy's /api/run_sql already handles no-driver case. Consistent with hasSqlOps=agentOnline from capabilities.
- 2026-06-09: FIX — PDF export: all PDF generators (generateDbPDF, generateEbsPDF, generateCombinedPDF in reports.js; buildExportPDF in health-check-export.js) called doc.end() before pipe(res) — wrong Node.js stream order causing the HTTP response to hang. Fixed by piping inside the generator functions (before end) for reports.js, and pdfDoc.pipe(res) then pdfDoc.end() for health-check-export.js.
- 2026-06-09: FEAT — 3 full blog articles: oracle-awr-ash-analysis, oracle-19c-upgrade-from-12c, oracle-tablespace-management. DB Time analysis, AWR wait tables, ASH drill-down SQL; AutoUpgrade config + post-upgrade tasks; autoextend framework, growth trend SQL, UNDO formula. Run seed-blog to publish.
- 2026-06-08: FIX — HC completion email for EBS app tier: counts were 0/0, now correctly reads from metrics.findings[] JSONB. DB tier email also fixed (hc.score → hc.overall_score, connection_name → name).

## Pending Tasks (immediate — before go-live)
1. EBS Ops — full redesign (service control panel, start/stop per component, JVM heap, concurrent requests) — NEEDS DESIGN REVIEW FIRST
2. Support agent setup — Claude API + Intercom/Crisp
3. Outreach email templates
4. Blog articles — 5 remaining stubs (adop-patching, rac-troubleshooting, data-guard, ebs-performance-tuning, ebs-oci-cloning, security-hardening)
5. apex-lab agent install (Oracle 23ai)
6. Autonomous monitoring UI — "Run now" button, status display after save
