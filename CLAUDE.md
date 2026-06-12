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

## Known Issues (as of 2026-06-11)

🟡 High:
- apex-lab (192.168.56.101, OEL 8.10, Oracle 23ai) — agent never installed
- WF Notification Mailer — DEACTIVATED_SYSTEM on conn 140 due to mail server
  config error (OUTBOUND_SERVER unreachable). Not a TuneVault bug — needs 
  EBS mail config fix before Start/Reset will work.

🟢 Low:
- README.md CI badge URLs point to Polsia-Inc/tunevault
- Outreach email templates not written yet
- Result persistence — EBS Ops and DB Ops cards load blank on navigate-back;
  fix: localStorage last-run cache with timestamp, no auto-run
- Long-running job model — start/stop ops >30s have no persist-across-nav;
  design: ebs_jobs table (id, connection_id, op_key, status, stdout, etc.)
- OPP Queue query may need tuning for some EBS versions
- adalnctl start/stop: pgrep sentinel kept as defense-in-depth; TCP lsnrctl
  is the primary status path (3.20.47+). TWO_TASK-based pgrep may miss 
  multi-node balance aliases — revisit if customer reports listener anomalies

## Key Configuration
- `ebs_instance_name`: conn 134 (ebs12212-db-dev) and conn 140 
  (ebs12212-app-dev) both set to `EBS12212`. EBS Ops SQL routes conn 140 → 
  conn 134 via findPairedDbConn() using this value. APPS password stored in 
  apps_pwd_enc on conn 140. WebLogic password in weblogic_pwd_enc on conn 140.
- Current proxy version: 3.20.56 on both conn 134 and conn 140
- Render auto-deploy: ON (GitHub webhook active)
- SKIP_TIER_LIMITS=true in Render env vars
- APP_URL=https://tunevault.app set in Render env vars
- Custom domain: tunevault.app → tunevault-bm8c.onrender.com (Cloudflare CNAME, DNS only)

## EBS Ops architecture (as of 2026-06-10)

### Transport
All EBS Ops run through the agent on the target server — no SSH from 
TuneVault. Two paths:
- **Shell ops** (Service Status, CM control): POST /api/ebs-ops/middleware-run
  → agent-channel → /api/ebs-ctrl on the app-tier agent (conn 140). Scripts 
  source EBSapps.env, run as applmgr via su, return stdout + exit code.
- **SQL ops** (Concurrent, WF Mailer, Patching): POST /api/ebs-ops/run →
  findPairedDbConn() pairs conn 140 → conn 134 via ebs_instance_name → 
  agent-channel → /api/run_sql on DB agent (conn 134) as APPS user.

### /api/ebs-ctrl whitelisted ops (oracle-proxy.py)
Status: adapcctl_status, adopmnctl_status, adalnctl_status (TCP lsnrctl),
adnodemgrctl_status, wls_admin_status, oacore_status, forms_status, 
oafm_status, managed_servers_status, adcmctl_status, fnd_svc_ctrl_start,
fnd_svc_ctrl_stop
Start/Stop: adapcctl_start/stop, adopmnctl_start/stop, adalnctl_start/stop,
adnodemgrctl_start/stop, wls_admin_start/stop, managed_server_start/stop 
(requires server_name param, validated ^[a-zA-Z0-9_-]{1,64}$),
adcmctl_start/stop, wf_mailer_start/stop/reset (all PL/SQL via sqlplus)

### adalnctl special handling
adalnctl_status uses TCP lsnrctl directly (bypasses Unix socket in 
/var/tmp/.oracle which is hidden when PrivateTmp=true in systemd unit):
  ALN_PORT=$(grep -i 'Port=' "$TNS_ADMIN/listener.ora" | head -1 | sed ...)
  lsnrctl status "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=$ALN_PORT)))"
ok = exit==0 AND "STATUS of the LISTENER" in stdout.

### WF Mailer PL/SQL signature (confirmed on EBS 12.2)
fnd_svc_component.start_component(p_component_id=>N, p_retcode=>OUT, p_errbuf=>OUT)
fnd_svc_component.stop_component — same signature.
DEACTIVATED_SYSTEM reset: UPDATE fnd_svc_components SET 
component_status='STOPPED', component_status_info=NULL WHERE component_id=N
then call start_component. Cannot reset via restart_count (column does not 
exist). If DEACTIVATED_SYSTEM persists after reset, use CM Stop All + 
Start All (adcmctl) to fully restart the GSM framework.

### EBS Ops tabs (5 tabs)
1. Service Status — inline agent cards: Apache/OHS, OPMN, Apps Listener, 
   Node Manager, WLS Admin Server, OACore/Forms/OAFM/All Managed Servers.
   Each card has ▶ Status + ▶ Start + ▶ Stop (CONFIRM gate on destructive).
   Per-server Start/Stop appears inside the result panel after status runs.
2. Concurrent Processing — CM Control (adcmctl status/start/stop) + SQL 
   cards: Running/Long-running/Pending/Failed requests, CM Managers, OPP 
   Queue/Programs/Manager/Heap.
3. WF Mailer — PL/SQL control (Stop/Start/Reset WF Mailer) + SQL cards: 
   Mailer Status (with per-component inline Start/Stop), Stuck Notifications,
   WF Errors 24h/7d, Mailer Queues, Open Notification count, Notification 
   by ID (parameterised).
4. Patching & ADOP — ADOP Session Status, Recent Patches (90 days via 
   AD_ADOP_SESSION_PATCHES), APPS Invalid Objects.
5. Reports — existing report links.

## Recent changes

- 2026-06-12: FIX — oracle-proxy.py 3.20.61: apps_start_all proxy timeout 1225→1800s (30 min);
  route 1820000ms; frontend 1825000ms. ebs-ops.html: full-stack timeout no longer shows ✗ error —
  detected via "Request timed out" prefix on storeKey apps_stop/start_all, renders "⚠ Still running"
  badge + guidance text + "↻ Check Services Now" button (calls extracted refreshAllServiceStatus()).
  LATEST_PROXY_VERSION 3.20.61.
- 2026-06-12: FIX — oracle-proxy.py 3.20.59: apps_stop_all adds sleep 20 + TV_PROGRESS before
  OS process check (grace period for processes to exit); apps_start_all adds sleep 15.
  Stop op grep chain gains `| grep -v "RemoteCommand.*kill"` to exclude JTF shutdown process.
  Timeouts: stop 600→630s, start 1200→1225s; routes 650k/1245k ms; frontend 655k/1250k ms.
  ebs-ops.html renderMiddlewareTab: Full Stack Control moved to top of Service Status tab;
  Individual Services sub-header added; Advanced Operations stays at bottom.
  LATEST_PROXY_VERSION 3.20.59.
- 2026-06-12: FEAT — oracle-proxy.py 3.20.58: apps_stop_all/apps_start_all append OS process
  verification block after adstpall/adstrtal — ps filtered for httpd/java/tnslsnr/FNDLIBR/
  FNDSM/opmn/frmweb/f60; "none found" message on clean stop. ebs-ops.html: card descs
  corrected (adstpall.sh y → -mode=allnodes); warning banner updated; storeAndRenderMiddlewareResult
  parses OS_PROCESS_CHECK sentinel and renders "🔍 OS Process Verification" sub-header with
  monospace pre block. LATEST_PROXY_VERSION 3.20.58.
- 2026-06-12: FIX — oracle-proxy.py 3.20.57: apps_stop_all/apps_start_all timeouts doubled
  (stop: 300→600s, start: 600→1200s). TV_PROGRESS echo markers added to bash script so
  result panel shows step summary (start, success/timeout/exit code) after the op completes.
  routes/ebs-ops.js ctrlTimeout: 310→620s / 610→1220s. ebs-ops.html: _MW_TIMEOUTS 315→625s /
  615→1225s; runMiddlewareOp gains 5s setInterval elapsed counter for full-stack ops;
  storeAndRenderMiddlewareResult parses TV_PROGRESS lines and renders them prominently before
  raw stdout. report.html build tag updated to 2026-06-11-ebs-ops-v1.
  LATEST_PROXY_VERSION 3.20.57.
- 2026-06-11: FIX — oracle-proxy.py 3.20.56: "Workflow Mailer Not Running" finding
  remediation text corrected — old text pointed to "EBS System Admin → Workflow →
  Service Components" with no detail; new text lists 3 options: TuneVault EBS Ops
  WF Mailer tab, OAM UI path, and PL/SQL fnd_svc_component.start_component snippet.
  Explicitly notes adadminsrvctl.sh start wfmail does not exist.
  LATEST_PROXY_VERSION 3.20.56.
- 2026-06-11: FIX — oracle-proxy.py 3.20.55: adstpall/adstrtal command corrected —
  APPS password is now a slash-joined argument ("APPS/$APPS_PWD"), WLS password
  piped via stdin only, -mode=allnodes added for multi-node support. ebs-ops.html:
  Full Stack Control cards now use mw- element IDs so storeAndRenderMiddlewareResult
  and runMiddlewareOp render the result panel correctly; _MW_TIMEOUTS entries added.
  LATEST_PROXY_VERSION 3.20.55.
- 2026-06-11: FEAT — oracle-proxy.py 3.20.54: apps_start_all/apps_stop_all ops
  added to /api/ebs-ctrl whitelist. Run adstrtal.sh y / adstpall.sh y via agent
  tunnel; passwords piped non-interactively via printf. Timeout: 610s start,
  310s stop. routes/ebs-ops.js: catalog + ctrlTimeoutMap updated. ebs-ops.html:
  new "Full Stack Control" section at bottom of Service Status tab — two cards
  with typed confirmation (START-ALL-APPS / STOP-ALL-APPS) and auto-refresh of
  all individual service status cards on success. LATEST_PROXY_VERSION 3.20.54.
- 2026-06-11: FIX — oracle-proxy.py 3.20.53: c4ws/oaea managed servers
  (forms-c4ws_server1, oaea_server1) classified as warning when down, not
  critical — these are optional EBS components not deployed on all instances.
  LATEST_PROXY_VERSION bumped to 3.20.53.
- 2026-06-11: FIX — report.html: EBS App Tier export buttons now inject as
  soon as report renders (status=analyzing + server_type=apps); explicit
  injectExportButtons() fallback added on poll completion.
- 2026-06-10: docs — rewrote all EBS Ops card descriptions to plain English
- 2026-06-10: FEAT — oracle-proxy.py 3.20.52: fnd_svc_ctrl_start/stop ops 
  (start/stop any GSM component by component_id); wf_mailer_reset pre-checks 
  DEACTIVATED_SYSTEM and shows advisory instead of silently failing. 
  ebs-ops.html: WF Mailer Status table shows per-component Start/Stop/⚠ 
  inline buttons; fixed column order (COMPONENT_NAME first), colored status 
  badges, 60-char truncation on COMPONENT_STATUS_INFO.
- 2026-06-10: FIX — oracle-proxy.py 3.20.51: wf_mailer_start/stop/reset all 
  use correct fnd_svc_component PL/SQL signature with named params 
  (p_component_id, p_retcode OUT, p_errbuf OUT). DEACTIVATED_SYSTEM reset 
  uses UPDATE component_status='STOPPED', component_status_info=NULL 
  (restart_count column does not exist on EBS 12.2).
- 2026-06-10: FEAT — oracle-proxy.py 3.20.50: all three WF Mailer control 
  ops (start/stop/reset) use fnd_svc_component PL/SQL only — no adcmctl. 
  Scoped to WF Mailer component only, does not affect other CMs.
- 2026-06-10: FEAT — oracle-proxy.py 3.20.48/49: CM Status card shows 
  FNDLIBR/FNDSM process list (CM_PROCESSES block) after adcmctl status. 
  WF Mailer Start/Stop use targeted fnd_svc_component PL/SQL. CM control 
  cards (adcmctl) correctly documented as affecting ALL CMs + GSM.
- 2026-06-10: FEAT — oracle-proxy.py 3.20.41: full start/stop controls for 
  all service components — adapcctl/adopmnctl/adalnctl/adnodemgrctl/
  wls_admin start+stop; managed_server_start/stop (per-server, requires 
  server_name validated ^[a-zA-Z0-9_-]{1,64}$); adcmctl_start/stop. 
  WF Mailer tab added (5th tab): PL/SQL stop/start/reset + 7 SQL cards. 
  CONFIRM gate on all destructive ops; post-control auto-refresh.
- 2026-06-10: FIX — oracle-proxy.py 3.20.47: adalnctl_status rewritten to 
  use TCP lsnrctl directly (bypasses PrivateTmp Unix socket isolation). 
  Port read from listener.ora dynamically. ok = exit==0 AND "STATUS of 
  the LISTENER" in stdout. Fixes persistent TNS-12541 false-down.
- 2026-06-10: FIX — oracle-proxy.py 3.20.44: hardcoded APPS_EBSDB removed 
  from pgrep; replaced with $TWO_TASK-based dynamic listener name. 
  ready-to-test.js lab SSH fallback nulled.
- 2026-06-10: FIX — oracle-proxy.py 3.20.45: unset ORACLE_HOME/TNS_ADMIN/
  LD_LIBRARY_PATH before sourcing EBSapps.env in all generated scripts — 
  prevents proxy's Oracle instant-client env leaking into EBS scripts.
- 2026-06-10: FIX — oracle-proxy.py 3.20.42: adcmctl.sh credential format 
  fixed to "apps/$APPS_PWD" (single slash-joined arg, not two args). 
  ADOP/patch queries fixed for EBS 12.2 schema (no APPLIED_ON_NODE; 
  use AD_ADOP_SESSION_PATCHES). WF Mailer query fixed (no LAST_ERROR_DATE; 
  use COMPONENT_STATUS_INFO). WF Errors query uses ASSIGNED_DATE not 
  ERROR_DATE. Managed server state classified from output text (NOT_DEPLOYED,
  RUNNING, DOWN, optional c4ws/oaea).
- 2026-06-10: FEAT — oracle-proxy.py 3.20.40: per-server managed server 
  start/stop added. Server name validated in both proxy and Node route.
  Service Status tab: per-server Start/Stop buttons render inside result 
  panels after status runs.
- 2026-06-09: FEAT — DB Ops and EBS Ops inline collapsible results matching 
  pattern across all cards. result-panel / result-panel-hdr / result-toggle.
- 2026-06-09: FIX — PDF export: all generators fixed (doc.end before pipe 
  was hanging HTTP response). HC completion email: f.detail → f.details.
- 2026-06-09: FIX — DB Ops Run endpoint: removed stale cx_oracle_version 
  pre-check that blocked runs when field was null.
