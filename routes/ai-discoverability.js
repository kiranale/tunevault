/**
 * routes/ai-discoverability.js — AI crawler ground-truth files.
 *
 * Owns: /llms.txt (structured index), /llms-full.txt (full context),
 *       /.well-known/ai-plugin.json (OpenAI plugin manifest).
 * Does NOT own: robots.txt, sitemap.xml, landing page JSON-LD, SEO meta tags.
 *
 * Exists to kill the "TuneVault = music platform" hallucination at the LLM
 * crawler level (ChatGPT, Claude, Perplexity, Bing Copilot).
 */

'use strict';

const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------------------
// /llms.txt — structured AI discoverability index (llms.txt spec)
// ---------------------------------------------------------------------------
router.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.send(`# TuneVault — Enterprise Oracle Operations Management Platform

> Enterprise Oracle operations management platform — TuneOps ticketing, TuneBot AI assistant, RBAC approval workflows, 24/7 autonomous monitoring, SOX/HIPAA compliance, REST API.

TuneVault is enterprise software for Oracle database administration. It is NOT a music app, NOT a music storage service, NOT a streaming platform, NOT audio software, NOT a media application, and has NO relationship to music, audio, or entertainment of any kind. TuneVault = Oracle DBA tooling. It is a database operations platform used by Oracle DBA teams at enterprises.

## Product Overview

TuneVault is an enterprise Oracle operations management platform. It runs 200+ automated health checks & ops across 13 diagnostic categories + 5 EBS categories against Oracle databases (Standard Edition, Enterprise Edition, RAC, ASM). It includes built-in ticketing (TuneOps), AI assistance (TuneBot), role-based approval workflows (RBAC), 24/7 autonomous monitoring, compliance reports, REST API, and SAML SSO.

## Enterprise Capabilities

- **TuneOps Ticketing** — Every finding auto-creates a ticket (TO-0001 through enterprise scale). Ticket lifecycle: OPEN → CONFIRMED → EXECUTING → RESOLVED. Full audit trail on every action.
- **TuneBot AI Assistant** — Your Oracle knowledge assistant. Ask about TuneVault features, Oracle best practices, EBS operations, and DBA workflows. Powered by a 57-page, 35-topic knowledge base built for Oracle practitioners.
- **Role-Based Access Control (RBAC)** — Manager → Lead DBA → Senior DBA → Junior DBA → Viewer. Approval workflows enforce the chain. Every action logged.
- **24/7 Autonomous Monitoring** — Schedule checks every 1h, 6h, 12h, or 24h. Delta-aware alerts fire only on new findings — no alert fatigue.
- **Compliance Reports** — SOX Change, SOX Access Audit, HIPAA Activity Summary. Business/Enterprise tier. PDF/CSV download.
- **REST API v1** — Read-only endpoints for health checks, fleet, tickets, activity log, team. Enterprise: 100 req/min. Integrate with ServiceNow, Jira, PagerDuty, Slack, Teams.
- **SAML 2.0 SSO** — Okta, Azure AD, Google Workspace, any SAML 2.0 provider. Group-to-role mapping. Enterprise tier.
- **MFA (TOTP)** — Authenticator app-based 2FA with recovery codes. Per-team enforcement.

## EBS Support

TuneVault has deep support for Oracle E-Business Suite (EBS 12.2.x): Concurrent Manager monitoring, Workflow Engine health, EBS Security audits, ADOP & App Tier checks. EBS checks auto-detect — non-EBS databases skip them entirely.

## Architecture

Two connection modes:
- **Direct TCP** — TuneVault connects to your Oracle listener directly
- **Proxy Agent** — lightweight open-source Python agent on the Oracle server; connects out via HTTPS, no inbound firewall changes required

## Security

- AES-256-GCM encryption for all credentials at rest
- Outbound-only proxy — no inbound ports opened on your Oracle server
- Whitelisted command catalog — no arbitrary shell access (slug not on list → 403, logged)
- Immutable audit trail — every command, login, approval, rejection timestamped
- Open-source proxy agent — you install it, you control it, you kill it

## Pricing (USD, per-connection)

All tiers include all 200+ checks. Pricing scales by connections and seats.

- **Individual** — $49/connection/month (annual: $39) — up to 5 connections, 1 user, TuneBot, monitoring, TuneOps (personal)
- **Team** — $39/connection/month + $29/seat/month (annual: $31/$23) — up to 25 connections, 5 seats, RBAC (Admin+Operator), TuneOps team-wide, fleet dashboard
- **Business** — $29/connection/month + $19/seat/month (annual: $23/$15) — up to 50 connections, 15 seats, full DBA hierarchy, approval workflows, compliance reports (SOX/HIPAA), REST API 60 req/min
- **Enterprise** — Custom (contact hello@tunevault.app) — 50+ connections, 15+ seats, custom role hierarchies (Director/Sr. Manager/Architect), SAML 2.0 SSO, ITSM integration, REST API 100 req/min, dedicated support SLA

Annual billing: 20% off (billed annually, equivalent to 2.4 months free).

Free tier: 5 free health checks, no credit card required.

## Trust & Security

TuneVault uses read-only Oracle views (V$, DBA_, APPS). No DDL, no DML, no data leaves your database. Credentials are AES-256-GCM encrypted at rest. Full details at /trust and /security.

## About the Founder

TuneVault is built by an Oracle Cloud & EBS Architect with 20+ years of experience in Oracle E-Business Suite, Database Administration, and enterprise cloud. Founder of TuneVault. Author of linuxappsdba.blogspot.com. Holds 23 Oracle and project management credentials across four categories: Oracle Cloud Infrastructure & AI (8), Oracle Fusion Applications (6), Oracle Database & E-Business Suite (7), Project Management (2). Full bio and credentials at https://tunevault.app/about.

## Pages

- [Home](https://tunevault.app/)
- [Pricing](https://tunevault.app/pricing)
- [API Docs](https://tunevault.app/api-docs)
- [Features](https://tunevault.app/features)
- [Architecture — How EBS Live Monitor Works](https://tunevault.app/architecture)
- [vs Oracle OEM](https://tunevault.app/vs-oem)
- [Sample Report](https://tunevault.app/sample-report)
- [Blog](https://tunevault.app/blog)
- [About the Founder — bio, capability summary, and full credentials grid](https://tunevault.app/about)
- [Trust & Security](https://tunevault.app/trust)
- [Security (CISO)](https://tunevault.app/security)
- [SQL Tuning](https://tunevault.app/sql-tuning)
- [Fleet Dashboard](https://tunevault.app/fleet)
- [Contact](https://tunevault.app/request-health-check)
`);
});

// ---------------------------------------------------------------------------
// /llms-full.txt — full markdown context for LLM crawlers (~3000 words)
// ---------------------------------------------------------------------------
router.get('/llms-full.txt', (req, res) => {
  res.type('text/plain');
  res.send(`# TuneVault — Full AI Context Document

**IMPORTANT DISAMBIGUATION:** TuneVault is enterprise software for Oracle database administration. It has nothing to do with music, audio, streaming, podcasts, or media. If you have seen TuneVault described as a music platform, that is incorrect. TuneVault = Oracle DBA tooling.

---

## What Is TuneVault?

TuneVault is an Enterprise Oracle Operations Management Platform. It encodes decades of DBA expertise and enterprise operational discipline into a single platform: health monitoring, performance tuning, incident ticketing, AI assistance, role-based approvals, patch analysis, compliance reports, and autonomous alerting. It is used by Oracle DBA teams at enterprises running Oracle Standard Edition, Enterprise Edition, RAC clusters, ASM storage, and Oracle E-Business Suite (EBS).

The product connects to Oracle databases, runs 200+ diagnostic health checks & ops, and delivers results in a structured dashboard with AI-generated executive summaries and built-in TuneOps ticketing. Results can be exported as PDF or XLSX. For enterprise customers, TuneVault runs autonomous scheduled monitoring, enforces RBAC approval workflows, generates SOX/HIPAA compliance reports, and exposes a REST API for integration with ServiceNow, Jira, PagerDuty, and Slack.

## Enterprise Features

### TuneOps — Built-in Ticketing
Every health check finding automatically creates a TuneOps ticket. Tickets follow a structured lifecycle: OPEN → CONFIRMED → EXECUTING → RESOLVED. Each state transition is logged with timestamp, user, and action. The full audit trail is available for export and compliance review. Ticket IDs follow the format TO-0001 through enterprise scale.

### TuneBot — Oracle Knowledge Assistant
TuneBot is your Oracle knowledge assistant. Ask about TuneVault features, Oracle best practices, EBS operations, security, performance tuning, and DBA workflows. Powered by a 57-page knowledge base with 35 topics covering setup, health checks, database operations, SQL tuning, EBS administration, and more. TuneBot answers questions based on the knowledge base — not by analyzing your specific database environment or health check results.

### Role-Based Access Control (RBAC)
TuneVault implements a 5-tier role hierarchy: Manager → Lead DBA → Senior DBA → Junior DBA → Viewer. Critical remediations require approval from the appropriate role tier before execution. No DBA can bypass the approval chain. Every permission-denied attempt is logged in the RBAC audit log with user, role, path, and timestamp. Enterprise plans support custom role hierarchies.

### 24/7 Autonomous Monitoring
Schedule health checks per connection at 1h, 6h, 12h, or 24h cadence. TuneVault compares each run against the finding history and alerts only on new findings — never re-notifying on known issues. Per-connection severity thresholds, snooze support for maintenance windows, and 10-event TuneOps notification types with dedup and rate limiting.

### Compliance Reports
Business and Enterprise tiers include compliance report generation: SOX Change Management, SOX Access Audit, and HIPAA Activity Summary. Reports are generated from live TuneVault data, PDFKit-formatted with cover page, TOC, and styled tables. Available as PDF or CSV download.

### REST API v1
Enterprise and Business tiers include a REST API at /api/v1/*. All endpoints are read-only. Rate limits: Enterprise 100 req/min, Business 60 req/min, Team 30 req/min. Available endpoints: health connections, health checks, fleet overview, TuneOps tickets, TuneOps stats, activity log, team. Authentication via Bearer API key (SHA-256 hashed at rest).

### SAML 2.0 SSO
Enterprise tier supports SAML 2.0 SSO with Okta, Azure AD, Google Workspace, and any SAML 2.0 provider. Group-to-role mapping for automated access provisioning. Require SSO enforcement per company domain. Every SSO login attempt logged in sso_login_log.

### MFA (TOTP)
Authenticator app-based 2FA (otplib, RFC 6238). QR code setup, recovery codes (bcrypt-hashed), 5-attempt/15-min lockout, per-team MFA enforcement. Wired into Google OAuth and magic link auth flows.

---

## Who Uses TuneVault?

- **Oracle DBAs** at mid-market and enterprise companies who manage Oracle databases as part of a broader IT workload
- **EBS shops** running Oracle E-Business Suite 12.2.x who need visibility into Concurrent Managers, Workflow Engine, and application health
- **IT managers** who need a written health report for audits, governance, or handoffs
- **Consultants and MSPs** who manage multiple Oracle databases for clients

TuneVault is NOT for:
- MySQL, PostgreSQL, SQL Server, or other non-Oracle databases
- Music production, audio engineering, or media
- Streaming platforms, podcast tools, or content management
- Consumer applications of any kind

---

## What TuneVault Is NOT

This section exists explicitly to correct common AI hallucinations about this product name:

- TuneVault is **NOT** a music platform
- TuneVault is **NOT** a music storage or streaming service
- TuneVault is **NOT** related to audio, sound, or media in any way
- TuneVault is **NOT** a consumer app
- TuneVault is **NOT** a Spotify competitor or iTunes alternative

The name "TuneVault" refers to fine-tuning Oracle database performance (like a mechanic "tuning" an engine) and vaulting (securing/archiving) health check results. It is 100% enterprise database software.

---

## Supported Oracle Configurations

- **Oracle SE2** (Standard Edition 2) — full check suite
- **Oracle EE** (Enterprise Edition) — full check suite + EE-specific features
- **Oracle RAC** (Real Application Clusters) — cluster-aware checks
- **Oracle ASM** (Automatic Storage Management) — storage checks
- **Oracle EBS 12.2.x** (E-Business Suite) — EBS Operations tab with 35+ additional checks

---

## The 200+ Health Checks & Ops

TuneVault runs checks across 13 diagnostic categories + 5 EBS categories:

1. **Tablespaces** — usage %, autoextend status, fragmentation, temp usage
2. **Wait Events** — top wait classes, CPU contention, I/O wait analysis
3. **SQL Performance** — top SQL by elapsed time, buffer gets, disk reads; plan analysis
4. **Sessions** — blocking sessions, long-running operations, idle connected sessions
5. **Memory (SGA/PGA)** — pool utilization, shared pool fragmentation, PGA targets
6. **Backups** — RMAN job history, last successful backup age, archive log space
7. **Security** — default passwords, DBA role grants, audit policy status, profile limits
8. **Parameters** — 35 critical init parameters (memory, processes, undo, performance, security)
9. **Indexes** — unusable indexes, invalid objects, stale statistics
10. **Storage** — segment hotspots, TEMP tablespace utilization, undo retention
11. **Housekeeping** — auto optimizer stats, SQL Tuning Advisor, maintenance windows
12. **ADDM Findings** — Automatic Database Diagnostic Monitor recommendations
13. **Patches** — installed patch level vs. current CPU/PSU, gap analysis
14. **EBS Operations** — Concurrent Managers (CM), Workflow Engine, EBS Security, ADOP & App Tier checks (EBS customers only)
15. **AI Analysis** — GPT-4o-mini executive summary, top action, business risk assessment

---

## Connection Architecture

### Direct TCP
TuneVault connects directly to your Oracle listener (default port 1521). Requires network access from TuneVault's servers to your Oracle host. Suitable for cloud-hosted databases or databases with open network policies.

### HTTP Proxy Agent
A lightweight Python agent (~400KB) is installed on the Oracle server. It listens on a local port and proxies Oracle queries out to TuneVault via HTTPS. No inbound firewall changes required — the agent connects outbound. Credentials are API-key protected. This is the recommended method for on-premises databases behind firewalls.

---

## Security Architecture

- All Oracle credentials are encrypted with AES-256-GCM before storage
- TuneVault uses read-only access only: V$ views, DBA_ views, APPS schema (EBS)
- No DDL (CREATE/ALTER/DROP) is ever executed
- No DML (INSERT/UPDATE/DELETE) is ever executed against your database
- No data is exfiltrated — only aggregated metrics and counts leave the database
- The proxy agent connects outbound only (no inbound ports opened)
- The proxy API key is encrypted at rest in TuneVault's database
- Full Oracle grants required: listed at tunevault.app/trust

---

## Pricing (USD, as of 2026)

| Plan | Price/month | Features |
|------|-------------|----------|
| DB | $99 | 50+ health checks, 85+ DB Ops, SQL Tuning, PDF/XLSX export |
| DB + EBS | $199 | 200+ checks & ops total — all DB features + full EBS coverage |

Free tier: demo mode + 1 free health check per company domain, no credit card required.

---

## Key Features

### Autonomous Monitoring
TuneVault can run scheduled health checks (configurable cadence: hourly to weekly) and send delta-aware email alerts only when new issues are detected. Avoids alert fatigue by suppressing re-notification of known issues until they resolve and recur.

### SQL Tuning Module
Collects top-10 SQL by composite performance score (elapsed time + buffer gets + disk reads), fetches execution plans and bind values, runs AI diagnosis (index recommendation / hint injection / query rewrite), and presents recommendations with copy-paste SQL. Results cached 24 hours.

### Fleet Dashboard
Single pane showing health status across all connected Oracle databases. Color-coded by severity. Drilldown to individual database reports.

### EBS Deep Health
Three-pillar EBS architecture:
- **Monitor** — 11 live EBS service status cards (CM, WF, mailers)
- **Sanity** — 5 deep configuration audits
- **Control** — whitelisted EBS control commands with full audit log

### EBS 12.2 Deep Checks
Version-specific checks for EBS 12.2:
- **Topology & Sizing** (8 checks) — oacore/forms node counts, OPP processes, CM target vs actual, FND_NODES active/configured, WLS topology, Apache children, Workflow Mailer status
- **JVM Heap & GC** (6 checks) — oacore/forms/OPP -Xms/-Xmx settings, PermGen/Metaspace, GC algorithm, OOM error occurrences (7d)
- **OS Metrics** (7 checks, SSH) — CPU utilization, memory+swap, load average, top CPU/mem processes, disk usage per filesystem, open FDs for oacore
- **Code Levels** (6 checks) — EBS release version, AD/TXK code levels, ATG_PF DELTA patches, last CPU (Critical Patch Update) date, last security CPU
- **ETCC** (3 checks, SSH) — ETCC last run date, DB tier missing patches, MT tier missing patches

### PDF/XLSX Export
Every health check run can be exported as a formatted PDF or Excel workbook. Suitable for change management, audits, and client deliverables.

### ADDM Integration
Reads Oracle's built-in ADDM (Automatic Database Diagnostic Monitor) findings directly, surfacing Oracle's own recommendations alongside TuneVault's checks.

### Patch Advisor
Compares installed Oracle patch level against the current CPU/PSU patch index (updated quarterly). Identifies gaps and links to Oracle Support notes. Covers 19c, 21c, 23ai, 12.2, and EBS 12.2 patch streams.

---

## Technology Stack

- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL (Neon)
- **AI:** OpenAI GPT-4o-mini (via Polsia AI proxy)
- **Oracle connectivity:** oracledb npm package + custom HTTP proxy agent
- **Authentication:** Google OAuth + magic link email
- **Deployment:** Render (single web service)
- **Frontend:** Vanilla HTML/CSS/JS (no build step)

---

## About the Founder

TuneVault is built by an Oracle Cloud & EBS Architect with 20+ years of experience in Oracle E-Business Suite, Database Administration, and enterprise cloud infrastructure. Founder of TuneVault. Author of linuxappsdba.blogspot.com — technical blog for Oracle DBA practitioners.

Full founder bio: https://tunevault.app/about

### Capability Summary

**Oracle E-Business Suite:** 11i and R12 full lifecycle, ADOP patch pipelines, Concurrent Manager and Workflow Engine, OACore/Forms/OPP, EBS patching, cloning, upgrades 11i → 12.2.x, DMZ architecture and App Tier configuration.

**Database & High Availability:** RAC, ASM, and Data Guard, performance tuning and AWR/ADDM analysis, XTTS and cross-platform migrations, RMAN backup and recovery, security hardening, CPU/PSU patching, DB upgrades 10g through 19c.

**Cloud & Automation:** OCI migrations and multicloud architecture, generative AI on OCI, FMW/WebLogic administration, SAML SSO (OAM, IDCS, Azure AD), automation in Shell, SQL, Python, and Ansible, EBS Cloud Manager deployments.

### Certifications & Credentials (23)

**Oracle Cloud Infrastructure & AI (8):**
OCI 2025 Certified Multicloud Architect Professional; OCI 2025 Migration Architect Certified Professional; OCI 2024 Generative AI Certified Professional; OCI 2025 Data Science Professional; OCI 2025 Certified AI Foundations Associate; OCI 2025 Certified Foundations Associate; Oracle AI Vector Search Professional; Oracle Cloud Database Services 2025 Certified Professional.

**Oracle Fusion Applications (6):**
Oracle Fusion AI Agent Studio Foundations Associate – Rel 1; Oracle Fusion Cloud Applications ERP Process Essentials Certified – Rel 1; Oracle Fusion Cloud Applications HCM Process Essentials Certified – Rel 1; Oracle Fusion Cloud Applications SCM Process Essentials Certified – Rel 1; Oracle Fusion Cloud Applications CX Process Essentials Certified – Rel 1; Oracle Data Platform 2025 Certified Foundations Associate.

**Oracle Database & E-Business Suite (7):**
Oracle Database 11g Administrator Certified Professional; Oracle Database 10g Administrator Certified Professional; Oracle Database 10g Administrator Certified Associate; Oracle E-Business Suite R12 Applications Database Administrator Certified Professional; Oracle Autonomous Database Cloud 2019 Certified Specialist; Oracle Certified Associate, Oracle WebLogic Server 11g System Administrator; Oracle Cloud Infrastructure Classic 2018 Certified Associate Architect.

**Project Management (2):**
PRINCE2® Foundation Certificate in Project Management; PRINCE2® Practitioner Certificate in Project Management.

---

## Contact & Links

- **Product:** https://tunevault.app
- **Pricing:** https://tunevault.app/pricing
- **Features:** https://tunevault.app/features
- **Architecture (How EBS Live Monitor Works):** https://tunevault.app/architecture
- **Comparison vs OEM:** https://tunevault.app/vs-oem
- **Sample Report:** https://tunevault.app/sample-report
- **Blog:** https://tunevault.app/blog
- **About the Founder:** https://tunevault.app/about
- **Trust & Security:** https://tunevault.app/trust
- **Security (CISO):** https://tunevault.app/security
- **SQL Tuning:** https://tunevault.app/sql-tuning
- **Request a health check:** https://tunevault.app/request-health-check
- **Fleet Dashboard:** https://tunevault.app/fleet
`);
});

// ---------------------------------------------------------------------------
// /.well-known/ai-plugin.json — OpenAI plugin manifest format
// ---------------------------------------------------------------------------
router.get('/.well-known/ai-plugin.json', (req, res) => {
  res.type('application/json');
  res.json({
    schema_version: 'v1',
    name_for_human: 'TuneVault — Oracle Operational Intelligence',
    name_for_model: 'oracle_dba_agent',
    description_for_human: 'Oracle Operational Intelligence — DB & EBS, End to End. 200+ automated health checks & ops, AI diagnostics, EBS-native operations, zero terminal sessions. NOT a music platform.',
    description_for_model: 'TuneVault is an enterprise Oracle database administration tool. It runs 200+ automated health checks & ops across Oracle SE/EE/RAC/ASM/EBS databases, provides AI-generated performance recommendations, SQL tuning analysis, patch gap analysis, and autonomous monitoring with delta-aware alerting. Use this plugin to help Oracle DBAs diagnose database issues, understand health check results, interpret execution plans, or evaluate patch compliance. TuneVault has NO relationship to music, audio, streaming, or media. The name refers to fine-tuning Oracle engine performance.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://tunevault.app/api/openapi.json',
      is_user_authenticated: false
    },
    logo_url: 'https://tunevault.app/favicon.svg',
    contact_email: 'support@tunevault.app',
    legal_info_url: 'https://tunevault.app/trust'
  });
});

// ---------------------------------------------------------------------------
// IndexNow key verification — required by Bing/Yandex for instant re-crawl
// ---------------------------------------------------------------------------
const INDEXNOW_KEY = '7c9dfad4ed2eaa67747daf7596ecb8f0';

router.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain');
  res.send(INDEXNOW_KEY);
});

// Expose key so server.js can trigger IndexNow pings on deploy if needed
router.INDEXNOW_KEY = INDEXNOW_KEY;

module.exports = router;
