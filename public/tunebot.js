/**
 * tunebot.js — TuneBot floating mascot help widget.
 * Owns: retrieval-based Q&A, mascot character UI, reactive expressions, analytics event emission.
 * Does NOT own: auth, health check data, any server-side logic.
 *
 * Usage: <script src="/tunebot.js"></script> — no init call required.
 * Self-initialises on DOMContentLoaded.
 *
 * V1: Reactive vault-robot mascot with CSS/SVG animations.
 * Expressions react to: health scores on page, idle state, greeting, typing.
 */
(function () {
  'use strict';

  // ── Knowledge Base ─────────────────────────────────────────────────────────
  // Each entry: { keywords: [string], q: string, a: string (markdown-ish) }
  var KB = [

    // ── Setup & Proxy ─────────────────────────────────────────────────────
    {
      keywords: ['proxy', 'setup proxy', 'install proxy', 'oracle proxy', 'proxy agent', 'agent install'],
      q: 'How do I set up the TuneVault proxy?',
      a: '**TuneVault Proxy** is a lightweight Python agent you install on your Oracle server.\n\n1. Go to **Settings → Connections → Add Connection**\n2. Choose **Proxy Connection**\n3. Download `oracle-proxy.py` and `oracle-proxy-install.sh`\n4. Run the installer on your Oracle host\n5. Configure `proxy.env` with your DB credentials\n6. Start the proxy — it listens on port 8765 by default\n\nThe proxy only sends outbound HTTPS — nothing opens inbound to your server.'
    },
    {
      keywords: ['direct connection', 'direct tcp', 'direct vs proxy', 'connection type', 'which connection'],
      q: 'Direct Connection vs Proxy Connection — which should I use?',
      a: '**Direct TCP**: TuneVault connects directly to your Oracle listener (port 1521). Use this when your DB is reachable from the internet, or via VPN/bastion.\n\n**Proxy Connection**: Install the lightweight proxy agent on your Oracle server. TuneVault calls the proxy over HTTPS; the proxy queries Oracle locally. Best for servers behind firewalls.\n\nBoth are equally secure — credentials are AES-256-GCM encrypted at rest.'
    },
    {
      keywords: ['oracle user', 'oracle role', 'privilege', 'grant', 'select catalog', 'dba role', 'permission', 'minimum privilege'],
      q: 'What Oracle user/role does TuneVault need?',
      a: 'TuneVault needs a read-only Oracle user with:\n\n```sql\nGRANT CREATE SESSION TO tunevault_user;\nGRANT SELECT_CATALOG_ROLE TO tunevault_user;\nGRANT SELECT ON sys.v_$session TO tunevault_user;\nGRANT SELECT ON sys.v_$sql TO tunevault_user;\nGRANT SELECT ON sys.dba_segments TO tunevault_user;\n```\n\nFor EBS checks, the user also needs read access to `APPS` schema views. See **Settings → Oracle Setup Guide** for the full grant script.'
    },
    {
      keywords: ['ssh target', 'ssh setup', 'configure ssh', 'ssh credential', 'ssh key'],
      q: 'How do I configure SSH targets?',
      a: 'SSH targets let TuneVault run EBS shell commands securely.\n\n1. Go to **Settings → SSH Targets**\n2. Click **Add SSH Target**\n3. Enter host, port, OS user\n4. Choose auth method: **SSH Key** (recommended) or password\n5. Paste your private key or enter the password — stored AES-256-GCM encrypted\n6. Assign a role: `apps_tier`, `db_tier`, or `utility`\n7. Link to a connection (optional)\n\nAll SSH commands use a strict allowlist — arbitrary shell commands are blocked.'
    },
    {
      keywords: ['proxy.env', 'env file', 'proxy environment', 'proxy config'],
      q: 'How do I configure the proxy.env file?',
      a: 'The `proxy.env` file lives alongside `oracle-proxy.py`. Required fields:\n\n```\nDB_HOST=your-oracle-host\nDB_PORT=1521\nDB_SERVICE=ORCL\nDB_USER=tunevault_user\nDB_PASSWORD=yourpassword\nTUNEVAULT_API_KEY=your-api-key-from-settings\nPROXY_PORT=8765\n```\n\nGet your API key from **Settings → API Keys**. Restart the proxy after any change.'
    },
    {
      keywords: ['port', 'firewall', 'outbound', 'network', 'what port', 'which port'],
      q: 'What ports does TuneVault need?',
      a: 'TuneVault only needs **outbound HTTPS (port 443)** from your Oracle server to `tunevault.app`.\n\nNo inbound ports need to be opened on your Oracle server. The proxy agent initiates all connections outbound. Your Oracle listener (1521) stays completely internal.'
    },

    // ── Health Checks ─────────────────────────────────────────────────────
    {
      keywords: ['health check', 'what is health check', 'how health check works', 'check category', 'categories'],
      q: 'What health check categories does TuneVault cover?',
      a: 'TuneVault runs **200+ checks** across 13 DB categories + 5 EBS categories:\n\n**DB Categories:** Storage, Performance, Security, Backup & Recovery, Redo & Archive, Tablespace, Users & Privileges, Parameters, Indexes, Statistics, Locks & Waits, High Availability, Configuration\n\n**EBS Categories:** Concurrent Manager, Workflow, Patches, System Config, Functional Health\n\nEBS categories only run when an E-Business Suite installation is detected automatically.'
    },
    {
      keywords: ['tablespace', 'tablespace full', 'storage', 'users tablespace', 'tablespace percent', '92', '90%'],
      q: 'What does "USERS tablespace 92.5% full" mean and how do I fix it?',
      a: '**Severity: Red** — tablespace is critically full. When a tablespace hits 100%, Oracle throws ORA-01653 errors and transactions fail.\n\n**Quick fix:**\n```sql\n-- Add a datafile\nALTER TABLESPACE USERS ADD DATAFILE SIZE 2G AUTOEXTEND ON NEXT 512M MAXSIZE 20G;\n\n-- Or enable autoextend on existing file\nALTER DATABASE DATAFILE \'/path/to/users01.dbf\' AUTOEXTEND ON MAXSIZE 20G;\n```\n\n**Root cause:** Either data growth or fragmentation. Check for large segments with the **DB Ops → Storage** operations.'
    },
    {
      keywords: ['severity', 'red', 'amber', 'green', 'critical', 'warning', 'severity level', 'color'],
      q: 'What are the severity levels?',
      a: '**🔴 Red (Critical)** — Immediate action required. Service impact is imminent or already occurring.\n\n**🟡 Amber (Warning)** — Monitor closely. Issue exists but not yet critical.\n\n**🟢 Green (Healthy)** — No issues found. Passing.\n\nThe overall **Health Score** is calculated from the weighted mix of check results — more critical checks carry higher weight.'
    },
    {
      keywords: ['health score', 'score calculation', 'how score', 'score formula', 'overall score'],
      q: 'How is the health score calculated?',
      a: 'The health score (0–100) is a weighted average across all checks:\n\n- **Red findings** carry the heaviest penalty\n- **Amber findings** carry a moderate penalty\n- **Green checks** contribute positively\n\nCritical categories (Security, Backup, Storage) are weighted higher than informational ones. A score above 80 is generally healthy. Below 60 needs attention.'
    },
    {
      keywords: ['db checks vs ebs', 'ebs checks', 'difference between db and ebs', 'db check ebs check'],
      q: 'What\'s the difference between DB checks and EBS checks?',
      a: '**DB Checks** run against any Oracle database — they query data dictionary views (`DBA_*`, `V$*`) for storage, performance, security, etc.\n\n**EBS Checks** only run when TuneVault detects an E-Business Suite installation (via `APPS.DUAL` probe). They check Concurrent Manager health, Workflow Engine, ADOP patch status, JVM memory, OS-level logs, and 30+ EBS-specific metrics.\n\nYou\'ll see a separate **EBS** section on the dashboard when EBS is detected.'
    },

    // ── Features ──────────────────────────────────────────────────────────
    {
      keywords: ['db ops', 'what is db ops', 'database operations', 'db operations'],
      q: 'What is DB Ops?',
      a: '**DB Ops** is a curated catalog of 32 one-click database operations across 11 categories:\n\n- Storage analysis, segment sizing\n- Index health and rebuild candidates\n- Lock & blocking session analysis\n- Parameter review\n- Statistics freshness\n- Redo log analysis\n- And more\n\nOperations run via your existing Oracle connection — read-only where possible, destructive ops require confirmation. Access at `/db-ops`.'
    },
    {
      keywords: ['sql tuning', 'what is sql tuning', 'sql analysis', 'slow query', 'top sql', 'wait event'],
      q: 'What is SQL Tuning?',
      a: '**SQL Tuning** (at `/sql-tuning`) identifies your top resource-consuming SQL statements and provides AI-powered fix recommendations:\n\n1. **Top SQL** — identifies high-elapsed, high-CPU, high-I/O statements from `V$SQL`\n2. **Wait Events** — shows what Oracle is waiting on\n3. **Blocking Sessions** — identifies lock chains\n4. **Segment Hotspots** — finds contended objects\n\nFor each problematic query, TuneVault\'s AI suggests index additions, hints, or rewrites. Recommendations are cached for 24 hours.'
    },
    {
      keywords: ['control tab', 'ebs control', 'ebs commands', 'control commands'],
      q: 'What is the Control tab?',
      a: 'The **Control tab** (in EBS Ops) provides a whitelisted catalog of EBS administrative commands:\n\n- Start/stop Concurrent Manager\n- Bounce Apache/OHS\n- Clear cache\n- ADOP operations\n\nAll commands use a strict allowlist — you can\'t run arbitrary shell commands. Every execution is logged to the **audit log** with user, command, timestamp, and output.'
    },
    {
      keywords: ['fleet', 'fleet dashboard', 'fleet overview', 'multiple connections', 'all connections'],
      q: 'What is the Fleet Dashboard?',
      a: '**Fleet Dashboard** (`/fleet`) gives you a single-pane view across all your Oracle connections:\n\n- Health score per connection\n- Last check timestamp\n- Critical/warning/green check counts\n- EBS detected indicator\n- Quick-link to each connection\'s dashboard\n\nIdeal for DBAs managing 5+ databases. Business and Enterprise tiers get unlimited connections.'
    },
    {
      keywords: ['report', 'pdf report', 'xlsx report', 'export', 'download report', 'generate report'],
      q: 'How do reports work?',
      a: 'TuneVault generates three report types:\n\n- **DB Report** — database health checks only\n- **EBS Report** — EBS checks only (requires EBS connection)\n- **Combined Report** — both DB + EBS in one document\n\nAvailable formats:\n- **PDF** — formatted document with cover page, findings, and AI recommendations\n- **XLSX** — spreadsheet with one sheet per check category\n\nAccess from the dashboard: click the **Reports** dropdown next to any connection.'
    },
    {
      keywords: ['tuneops', 'what is tuneops', 'ticket', 'ticketing', 'issue tracker'],
      q: 'What is TuneOps?',
      a: '**TuneOps** is TuneVault\'s built-in DBA ticketing system. It auto-creates tickets from health check findings:\n\n- **TO-XXXX** ticket numbers\n- Status lifecycle: `OPEN → CONFIRMED → EXECUTING → RESOLVED`\n- Severity: Critical / Warning / Info\n- Approval workflows for high-risk operations\n- 5-tier RBAC (admin, senior DBA, junior DBA, viewer, functional)\n- Full audit log of every action\n\nTuneOps tickets auto-close when the underlying finding resolves on the next health check.'
    },
    {
      keywords: ['tunebot', 'what is tunebot', 'help bot', 'chatbot', 'who are you', 'about tunebot'],
      q: 'What is TuneBot?',
      a: 'You\'re talking to me! 👋\n\n**TuneBot** is TuneVault\'s built-in help assistant. I answer questions about:\n- Setup and configuration\n- Health check explanations\n- Feature walkthroughs\n- EBS-specific guidance\n- Pricing and account questions\n- Security and troubleshooting\n\nI\'m a knowledge-base assistant — fast and reliable, no hallucination. If I don\'t have an answer, I\'ll tell you where to get help.'
    },
    {
      keywords: ['autonomous monitoring', 'scheduled check', 'schedule', 'automatic check', 'monitoring cadence'],
      q: 'How does Autonomous Monitoring work?',
      a: '**Autonomous Monitoring** runs health checks on a schedule and emails you when findings change:\n\n1. Go to **Settings → Schedules** (or the schedule icon on a connection)\n2. Set cadence: every 15 min, 30 min, 1h, 6h, 12h, 24h\n3. Set alert email and severity threshold (Critical / Warning / All)\n4. Enable — TuneVault runs checks automatically\n\n**Delta alerts**: Only emails you when findings change — new issues appear, or old ones resolve. No spam for unchanged state.'
    },

    // ── EBS-Specific ──────────────────────────────────────────────────────
    {
      keywords: ['ebs checks', 'ebs health', 'what ebs checks', 'oracle ebs', 'e-business suite check'],
      q: 'What EBS checks does TuneVault perform?',
      a: 'TuneVault performs **30+ EBS 12.2.x checks** covering:\n\n- **ADOP Patch Status** — active/stuck patch cycles, failed runs\n- **Concurrent Manager** — service health, stuck requests, queue depth\n- **Workflow Engine** — agent counts, stuck items, error thresholds\n- **JVM Memory** — heap usage, GC pressure\n- **OS-Level** — filesystem usage on APPL_TOP, log errors\n- **Code Levels** — ETCC/OAF version currency\n- **Topology** — multi-node WebLogic health\n\nAll require an SSH target linked to the apps tier server.'
    },
    {
      keywords: ['adop', 'what is adop', 'online patching', 'patch cycle', 'ebs patch'],
      q: 'What is ADOP and why does TuneVault track it?',
      a: '**ADOP** (AD Online Patching) is Oracle\'s online patching utility for EBS 12.2. It applies patches while the system stays live.\n\nTuneVault tracks ADOP because:\n- **Stuck patch cycles** block future patches and some EBS functions\n- **Failed ADOP runs** leave the filesystem in an inconsistent state\n- **Abandoned cycles** accumulate and bloat storage\n\nTuneVault detects stuck cycles, partial applies, and cleanup opportunities — and surfaces them as critical findings with the exact commands to resolve.'
    },
    {
      keywords: ['ebs auto detection', 'auto detect ebs', 'how ebs detected', 'ebs detection'],
      q: 'How does EBS auto-detection work?',
      a: 'TuneVault probes for EBS automatically when running a health check:\n\n1. **APPS.DUAL probe** — queries `SELECT 1 FROM APPS.DUAL` — if it succeeds, EBS schema exists\n2. **Version detection** — reads `AD_RELEASES` for EBS version (12.1 / 12.2)\n3. **Module activation** — if EBS confirmed, the 5 EBS check categories activate\n\nNo manual configuration needed. Connect with an Oracle user that has `SELECT` on APPS schema and detection is automatic.'
    },
    {
      keywords: ['concurrent manager', 'concurrent requests', 'concurrent manager check', 'cm health'],
      q: 'What are Concurrent Manager checks?',
      a: 'TuneVault checks the Concurrent Manager (CM) for:\n\n- **Service status** — all standard managers running (ICM, Standard, CRP)\n- **Stuck requests** — running requests that haven\'t progressed (> 2h default threshold)\n- **Queue depth** — pending requests backlog\n- **Error rate** — completed-with-error vs completed ratio\n- **Manager capacity** — worker threads vs demand\n\nCM checks appear in the **EBS Operations** tab and require both a DB connection and an SSH target for the apps tier.'
    },

    // ── Pricing & Account ─────────────────────────────────────────────────
    {
      keywords: ['plan', 'pricing', 'tier', 'individual plan', 'team plan', 'business plan', 'enterprise', 'how much', 'cost', 'price'],
      q: 'What plans are available?',
      a: 'TuneVault has 4 tiers:\n\n| Plan | Price | Connections | Members | Checks/mo |\n|------|-------|-------------|---------|----------|\n| **Individual** | $99/mo | 3 | 1 | 100 |\n| **Team** | $249/mo | 10 | 5 | 500 |\n| **Business** | $599/mo | 25 | 15 | Unlimited |\n| **Enterprise** | $19/conn/mo | Unlimited | Unlimited | Unlimited |\n\nAll plans include EBS checks, reports, TuneOps, and autonomous monitoring. See `/pricing` for the full feature matrix.'
    },
    {
      keywords: ['free', 'free tier', 'free checks', 'free health check', 'trial', 'no credit card', 'free plan'],
      q: 'How many free health checks do I get?',
      a: 'TuneVault offers **5 free health checks** — no credit card required, no time limit.\n\nFree checks are shared across your company domain (email-based). Once you\'ve used your 5 free checks, you\'ll need a paid plan.\n\nThere\'s no free *tier* — just a free taste before you commit. Start at `/signup`.'
    },
    {
      keywords: ['upgrade', 'how to upgrade', 'change plan', 'upgrade plan', 'subscribe'],
      q: 'How do I upgrade?',
      a: 'Go to **Settings → Billing** (`/settings/billing`).\n\nFrom there:\n- View your current plan and usage\n- Click **Upgrade** to switch to a higher tier\n- Payments via Razorpay (cards, UPI, netbanking)\n- Upgrades take effect immediately\n\nAll tiers — including Enterprise — go through direct checkout. No sales call required.'
    },
    {
      keywords: ['connection', 'how many connections', 'connection limit', 'max connections', 'add connection'],
      q: 'How do connections work across tiers?',
      a: 'Each saved Oracle connection (DB + optional proxy) counts toward your tier limit:\n\n- **Individual**: 3 connections\n- **Team**: 10 connections\n- **Business**: 25 connections\n- **Enterprise**: Unlimited\n\nA "connection" is one Oracle database endpoint. Multiple EBS environments on separate databases each count as separate connections.'
    },

    // ── Security ──────────────────────────────────────────────────────────
    {
      keywords: ['password stored', 'credentials stored', 'are passwords', 'store credentials', 'encrypt', 'security credentials'],
      q: 'Are passwords stored? How are credentials protected?',
      a: '**No plaintext storage.** All credentials are encrypted with **AES-256-GCM** before being written to the database.\n\n- Encryption key is separate from the database\n- Decrypted only at query time, in memory, for the duration of the connection\n- Never logged, never sent to third-party services\n- SSH private keys get the same treatment\n\nThe encryption is in `crypto-utils.js` and has been independently reviewed.'
    },
    {
      keywords: ['data stored', 'data retention', 'is data stored', 'health check data', 'results stored', 'server side'],
      q: 'Is my Oracle data stored on TuneVault servers?',
      a: '**No raw Oracle data is stored.** TuneVault only stores:\n\n- **Aggregated findings** — e.g., "USERS tablespace is 92% full" — not the actual data\n- **Health scores and check results** — structured summaries\n- **AI analysis text** — generated from the summaries\n\nRaw query output is rendered in your browser and discarded. Your Oracle data never sits on TuneVault infrastructure.'
    },
    {
      keywords: ['audit', 'audit trail', 'audit log', 'who did what', 'log actions'],
      q: 'What about audit trails?',
      a: 'TuneVault maintains comprehensive audit logs:\n\n- **SSH Audit Log** — every SSH command: key used, command run, exit code, stdout/stderr bytes, duration\n- **EBS Control Audit** — every control command attempt (allowed and rejected) with reason\n- **RBAC Audit** — every permission-denied API attempt\n- **Activity Log** — unified DBA action log scoped to your team\n\nAll logs are append-only and viewable at **Settings → Activity**.'
    },
    {
      keywords: ['mfa', 'two factor', '2fa', 'totp', 'multi factor', 'authentication'],
      q: 'Does TuneVault support MFA?',
      a: '**Yes.** TuneVault supports **TOTP-based MFA** (Google Authenticator, Authy, 1Password, etc.).\n\nEnable at **Settings → Security**:\n1. Scan the QR code with your authenticator app\n2. Verify with a code\n3. Save your recovery codes (shown once)\n\nOnce enabled, every login requires your TOTP code. Failed MFA attempts lock out for 15 minutes after 5 tries.'
    },
    {
      keywords: ['sso', 'saml', 'single sign on', 'okta', 'azure ad', 'google workspace sso'],
      q: 'Does TuneVault support SSO?',
      a: '**Yes — on Enterprise tier.** TuneVault supports **SAML 2.0 SSO** compatible with:\n- Okta\n- Azure AD / Entra ID\n- Google Workspace\n- Any SAML 2.0 provider\n\nConfigure at **Settings → SSO** (Enterprise accounts only). You can enforce SSO-only login and map IdP groups to TuneVault roles automatically.'
    },

    // ── Troubleshooting ───────────────────────────────────────────────────
    {
      keywords: ['connection failed', 'cannot connect', 'connection error', 'ora-', 'failed to connect', 'connect error'],
      q: 'Connection failed — what do I check?',
      a: '**Checklist for connection failures:**\n\n1. **Network** — can TuneVault reach your Oracle host? Check firewall rules, VPN, security groups\n2. **Listener** — is `lsnrctl status` showing the listener is UP on port 1521?\n3. **Credentials** — verify username/password with `sqlplus user/pass@host:1521/service`\n4. **Service name** — try both SERVICE_NAME and SID formats\n5. **Oracle user** — ensure the user has `CREATE SESSION` privilege\n6. **Proxy connection** — if using proxy, verify the proxy process is running (`ps aux | grep oracle-proxy`)\n\nError details appear in the connection test modal.'
    },
    {
      keywords: ['proxy not connecting', 'proxy error', 'proxy failed', 'proxy not working', 'proxy down'],
      q: 'Proxy not connecting — troubleshooting steps',
      a: '**Proxy troubleshooting:**\n\n1. **Is it running?** `ps aux | grep oracle-proxy` — if not, start it\n2. **Check logs** — `tail -f oracle-proxy.log` for error details\n3. **Port conflict** — is port 8765 already in use? `ss -tlnp | grep 8765`\n4. **API key** — regenerate the key in **Settings → API Keys** and update `proxy.env`\n5. **Firewall** — ensure outbound HTTPS (443) from the server to `tunevault.app` is open\n6. **Python version** — proxy requires Python 3.7+: `python3 --version`\n7. **DB connectivity** — test locally: `sqlplus $DB_USER/$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_SERVICE`'
    },
    {
      keywords: ['health check error', 'check error', 'check failed', 'error in results', 'missing checks', 'check not running'],
      q: 'Health check shows errors — what do I do?',
      a: '**Common causes:**\n\n- **Missing privileges** — the Oracle user lacks SELECT on a required view. Check the error message for the view name, then grant access\n- **View doesn\'t exist** — some checks are version-specific (e.g., 19c-only views). These skip gracefully\n- **Timeout** — heavily loaded systems may time out individual checks. They show as skipped, not failed\n- **EBS checks without SSH** — EBS shell checks require a linked SSH target. Checks without one show "SSH not configured"\n\nCheck the individual check result for the specific error. Most have inline remediation guidance.'
    },
    {
      keywords: ['rbac', 'roles', 'permissions', 'role based', 'access control', 'who can do what'],
      q: 'How does RBAC work in TuneVault?',
      a: 'TuneVault has **5 built-in roles**:\n\n| Role | Access |\n|------|--------|\n| **Admin** | Full access, manage team, configure SSO |\n| **Senior DBA** | All ops including destructive, approve requests |\n| **Junior DBA** | Read + non-destructive ops, submit approvals |\n| **Viewer** | Read-only: dashboards, reports |\n| **Functional** | EBS functional checks only |\n\nTeam admins can customize roles and require approval for specific operations (e.g., DB restarts require Senior DBA approval). Configure at **Settings → Team**.'
    },
    {
      keywords: ['api', 'rest api', 'api key', 'api access', 'programmatic', 'automate'],
      q: 'Does TuneVault have a REST API?',
      a: '**Yes — REST API v1** is available on Business and Enterprise tiers.\n\n- Generate API keys at **Settings → API Keys**\n- Keys are per-user with customizable names\n- Full documentation at `/api-docs`\n- Authenticate with `Authorization: Bearer YOUR_KEY` header\n\nYou can trigger health checks, retrieve results, manage connections, and query findings programmatically.'
    }
  ];

  // ── Fuzzy Matching ─────────────────────────────────────────────────────────
  function normalize(s) {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function scoreEntry(entry, query) {
    var q = normalize(query);
    var words = q.split(' ').filter(function (w) { return w.length > 2; });
    var score = 0;
    var entryText = normalize(entry.keywords.join(' ') + ' ' + entry.q);

    // Exact keyword match
    entry.keywords.forEach(function (kw) {
      var normKw = normalize(kw);
      if (q.indexOf(normKw) !== -1 || normKw.indexOf(q) !== -1) score += 10;
    });

    // Word-level matches
    words.forEach(function (word) {
      if (entryText.indexOf(word) !== -1) score += 2;
    });

    // Bonus: query word in question text
    var normQ = normalize(entry.q);
    words.forEach(function (word) {
      if (normQ.indexOf(word) !== -1) score += 1;
    });

    return score;
  }

  function findAnswer(query) {
    if (!query || query.trim().length < 2) return null;
    var scored = KB.map(function (entry) {
      return { entry: entry, score: scoreEntry(entry, query) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    if (scored[0].score === 0) return null;
    return scored[0].entry;
  }

  // ── Markdown renderer (lightweight) ───────────────────────────────────────
  function renderMarkdown(text) {
    return text
      // Code blocks
      .replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
        return '<pre style="background:#0d0d10;border:1px solid #2a2a30;border-radius:6px;padding:10px 12px;overflow-x:auto;margin:8px 0;font-size:11px;line-height:1.6;"><code style="font-family:\'JetBrains Mono\',monospace;color:#a8d8a8;">' + escHtml(code.trim()) + '</code></pre>';
      })
      // Inline code
      .replace(/`([^`]+)`/g, '<code style="background:#1a1a1f;border:1px solid #2a2a30;border-radius:3px;padding:1px 5px;font-size:11px;font-family:\'JetBrains Mono\',monospace;color:#f0a830;">$1</code>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#e8e8ed;font-weight:600;">$1</strong>')
      // Tables (simple)
      .replace(/\|(.+)\|\n\|[-| ]+\|\n((?:\|.+\|\n?)+)/g, function (_, header, rows) {
        var ths = header.split('|').filter(function (c) { return c.trim(); })
          .map(function (c) { return '<th style="padding:6px 10px;border-bottom:1px solid #2a2a30;text-align:left;font-size:12px;color:#9898a8;font-weight:500;">' + c.trim() + '</th>'; }).join('');
        var trs = rows.trim().split('\n').map(function (row) {
          var tds = row.split('|').filter(function (c) { return c.trim(); })
            .map(function (c) { return '<td style="padding:6px 10px;border-bottom:1px solid rgba(42,42,48,0.5);font-size:12px;">' + c.trim() + '</td>'; }).join('');
          return '<tr>' + tds + '</tr>';
        }).join('');
        return '<table style="width:100%;border-collapse:collapse;margin:8px 0;"><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table>';
      })
      // Bullet lists
      .replace(/^- (.+)$/gm, '<li style="padding:2px 0;">$1</li>')
      .replace(/(<li[^>]*>[\s\S]+?<\/li>)+/g, function (match) {
        return '<ul style="padding-left:16px;margin:6px 0;list-style:disc;">' + match + '</ul>';
      })
      // Numbered lists
      .replace(/^\d+\. (.+)$/gm, '<li style="padding:2px 0;">$1</li>')
      // Line breaks
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  function trackQuestion(question, matched) {
    try {
      // context_mode: 'ctx' = connection selected + health check data attached;
      //               'kb'  = no connection, knowledge-base fallback answers
      var contextMode = (tbContext && tbContext.activeConnection) ? 'ctx' : 'kb';
      var payload = { context_mode: contextMode, matched: !!matched };
      if (window.tvTrack) {
        window.tvTrack('tunebot_query', payload);
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/ec', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ event: 'tunebot_query', properties: payload, page_path: location.pathname }));
      }
    } catch (e) { /* analytics is best-effort */ }
  }

  function trackFeedback(question, helpful) {
    try {
      var payload = { question: question, helpful: helpful, page: location.pathname };
      if (window.tvTrack) {
        window.tvTrack('tunebot_feedback', payload);
      }
    } catch (e) { /* analytics is best-effort */ }
  }

  // ── Widget State ───────────────────────────────────────────────────────────
  var isOpen = false;
  var isHidden = false;     // true = completely hidden until next page load
  var conversationHistory = [];
  var currentQuestion = '';
  var currentExpression = 'idle'; // idle | happy | concerned | worried | thinking | celebrate | wave
  var idleTimer = null;
  var hasGreeted = false;

  // Context state — populated from /api/tunebot/context
  var tbContext = null;       // full context object from server
  var tbContextLoading = false;
  var tbContextLoaded = false;
  var tbContextConnId = null;  // connection ID used in the last context fetch

  // Drag state — widget repositioning (desktop only)
  // Widget = FAB + panel move together as one unit anchored to a corner.
  // We track the FAB position (bottom-right by default) and derive panel pos from it.
  var tbDragState = null;   // { startX, startY, startFabLeft, startFabTop } during drag
  var tbWidgetPos = null;   // { left, top } = FAB top-left corner; null = default bottom-right

  // Restore persisted position from localStorage
  (function () {
    try {
      var stored = localStorage.getItem('tvBotPosition');
      if (stored) {
        var parsed = JSON.parse(stored);
        // Validate it's still within current viewport (guard against resolution changes)
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number' &&
            parsed.left >= 0 && parsed.left < vw - 40 &&
            parsed.top >= 0 && parsed.top < vh - 40) {
          tbWidgetPos = parsed;
        }
      }
    } catch (e) { /* localStorage unavailable */ }
  }());

  // ── Suggestions ────────────────────────────────────────────────────────────
  var SUGGESTIONS = [
    'How do I set up the proxy?',
    'What Oracle user do I need?',
    'What does a red finding mean?',
    'How is the health score calculated?',
    'What is TuneOps?',
    'Are my credentials safe?',
    'How do I troubleshoot a connection failure?'
  ];

  var CONTEXT_SUGGESTIONS = [
    'What are my top issues?',
    'What should I fix first?',
    'Explain my critical findings',
    'How is my health score calculated?',
    'What do my open tickets mean?',
    'What EBS risks do I have?',
    'How do I resolve my biggest finding?'
  ];

  // ── Expression SVG Faces ───────────────────────────────────────────────────
  // Each expression returns SVG inner content for the robot face viewport
  // Face is 40x40 viewport inside the robot head
  function getFaceForExpression(expr) {
    // All faces share the same robot head shell — only eyes/mouth change
    switch (expr) {
      case 'happy':
        // Wide happy eyes + big smile
        return [
          // Eyes: bright wide ovals
          '<ellipse cx="14" cy="18" rx="4" ry="4.5" fill="#0a0a0c"/>',
          '<ellipse cx="26" cy="18" rx="4" ry="4.5" fill="#0a0a0c"/>',
          // Eye shine
          '<circle cx="16" cy="16" r="1.5" fill="white" opacity="0.9"/>',
          '<circle cx="28" cy="16" r="1.5" fill="white" opacity="0.9"/>',
          // Big curved smile
          '<path d="M 12 26 Q 20 33 28 26" stroke="#0a0a0c" stroke-width="2" fill="none" stroke-linecap="round"/>',
          // Rosy cheeks
          '<ellipse cx="10" cy="26" rx="3.5" ry="2" fill="#f87171" opacity="0.35"/>',
          '<ellipse cx="30" cy="26" rx="3.5" ry="2" fill="#f87171" opacity="0.35"/>'
        ].join('');

      case 'celebrate':
        // Star eyes + huge grin
        return [
          // Star-burst eyes
          '<text x="10" y="22" font-size="10" fill="#f0a830">★</text>',
          '<text x="22" y="22" font-size="10" fill="#f0a830">★</text>',
          // Big grin
          '<path d="M 11 27 Q 20 35 29 27" stroke="#0a0a0c" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
          // Sparkles
          '<text x="3" y="14" font-size="7" fill="#f0a830" opacity="0.8">✦</text>',
          '<text x="31" y="12" font-size="6" fill="#f0a830" opacity="0.8">✦</text>'
        ].join('');

      case 'concerned':
        // Slightly worried eyes + small frown
        return [
          // Eyes: slightly squinted
          '<ellipse cx="14" cy="18" rx="3.5" ry="3" fill="#0a0a0c"/>',
          '<ellipse cx="26" cy="18" rx="3.5" ry="3" fill="#0a0a0c"/>',
          // Eye shine (smaller)
          '<circle cx="15.5" cy="16.5" r="1.2" fill="white" opacity="0.8"/>',
          '<circle cx="27.5" cy="16.5" r="1.2" fill="white" opacity="0.8"/>',
          // Slight frown
          '<path d="M 13 27 Q 20 24 27 27" stroke="#0a0a0c" stroke-width="2" fill="none" stroke-linecap="round"/>',
          // Raised inner brows (concern lines)
          '<line x1="11" y1="13" x2="17" y2="11" stroke="#0a0a0c" stroke-width="1.5" stroke-linecap="round"/>',
          '<line x1="23" y1="11" x2="29" y2="13" stroke="#0a0a0c" stroke-width="1.5" stroke-linecap="round"/>'
        ].join('');

      case 'worried':
        // Big worried eyes + strong frown
        return [
          // Big anxious eyes
          '<ellipse cx="14" cy="19" rx="4.5" ry="5" fill="#0a0a0c"/>',
          '<ellipse cx="26" cy="19" rx="4.5" ry="5" fill="#0a0a0c"/>',
          // Smaller eye shines (nervous)
          '<circle cx="15.5" cy="17" r="1.2" fill="white" opacity="0.7"/>',
          '<circle cx="27.5" cy="17" r="1.2" fill="white" opacity="0.7"/>',
          // Strong frown
          '<path d="M 12 28 Q 20 22 28 28" stroke="#0a0a0c" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
          // Sweat drop
          '<ellipse cx="32" cy="15" rx="2" ry="3" fill="#60a5fa" opacity="0.7"/>',
          '<circle cx="32" cy="12" r="1.2" fill="#60a5fa" opacity="0.7"/>',
          // Worry brows
          '<line x1="10" y1="12" x2="18" y2="14" stroke="#0a0a0c" stroke-width="1.5" stroke-linecap="round"/>',
          '<line x1="22" y1="14" x2="30" y2="12" stroke="#0a0a0c" stroke-width="1.5" stroke-linecap="round"/>'
        ].join('');

      case 'thinking':
        // Thinking face — one eye narrowed, look upward, thought bubble dots
        return [
          // Right eye normal, left eye squinted
          '<ellipse cx="14" cy="18" rx="3.5" ry="2.5" fill="#0a0a0c"/>',
          '<ellipse cx="26" cy="18" rx="4" ry="4" fill="#0a0a0c"/>',
          '<circle cx="27" cy="16.5" r="1.3" fill="white" opacity="0.8"/>',
          // Sideways mouth (thinking)
          '<path d="M 13 27 Q 17 26 22 27 Q 24 27.5 26 26" stroke="#0a0a0c" stroke-width="2" fill="none" stroke-linecap="round"/>',
          // Thought dots in top-right
          '<circle cx="30" cy="8" r="1.2" fill="#0a0a0c" opacity="0.5"/>',
          '<circle cx="33" cy="5" r="1.5" fill="#0a0a0c" opacity="0.4"/>',
          '<circle cx="36" cy="2" r="2" fill="#0a0a0c" opacity="0.3"/>'
        ].join('');

      case 'wave':
        // Friendly waving expression — big smile, sparkle eye
        return [
          // Eyes: one squinting happy, one round
          '<ellipse cx="14" cy="18" rx="4" ry="2.5" fill="#0a0a0c"/>',
          '<ellipse cx="26" cy="18" rx="4" ry="4" fill="#0a0a0c"/>',
          '<circle cx="27" cy="16.5" r="1.3" fill="white" opacity="0.9"/>',
          // Warm smile
          '<path d="M 12 25 Q 20 32 28 25" stroke="#0a0a0c" stroke-width="2" fill="none" stroke-linecap="round"/>',
          // Pink cheeks
          '<ellipse cx="10" cy="25" rx="3" ry="2" fill="#f87171" opacity="0.3"/>',
          '<ellipse cx="30" cy="25" rx="3" ry="2" fill="#f87171" opacity="0.3"/>'
        ].join('');

      case 'idle':
      default:
        // Neutral friendly face — resting but professional
        return [
          // Standard round eyes
          '<ellipse cx="14" cy="18" rx="3.8" ry="4" fill="#0a0a0c"/>',
          '<ellipse cx="26" cy="18" rx="3.8" ry="4" fill="#0a0a0c"/>',
          // Eye shine
          '<circle cx="15.5" cy="16.5" r="1.3" fill="white" opacity="0.85"/>',
          '<circle cx="27.5" cy="16.5" r="1.3" fill="white" opacity="0.85"/>',
          // Gentle neutral smile
          '<path d="M 13 27 Q 20 30 27 27" stroke="#0a0a0c" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
        ].join('');
    }
  }

  // ── Mascot SVG Builder ─────────────────────────────────────────────────────
  // Renders the full robot character as inline SVG (~56x72px visual)
  function buildMascotSVG(expression, size) {
    size = size || 56;
    var scale = size / 56;
    var expr = expression || 'idle';

    return [
      '<svg id="tb-mascot-svg" width="' + size + '" height="' + Math.round(72 * scale) + '"',
      '  viewBox="0 0 56 72" fill="none" xmlns="http://www.w3.org/2000/svg"',
      '  aria-hidden="true">',

      // ── Antenna ──
      '<line x1="28" y1="2" x2="28" y2="10" stroke="#14b8a6" stroke-width="2.5" stroke-linecap="round"/>',
      '<circle cx="28" cy="2" r="3" fill="#f0a830"/>',
      '<circle cx="28" cy="2" r="1.5" fill="#ffc85c"/>',

      // ── Head ──
      '<rect x="8" y="10" width="40" height="34" rx="10" ry="10" fill="url(#headGrad)"/>',
      // Head highlight
      '<rect x="10" y="11" width="36" height="10" rx="5" fill="white" opacity="0.08"/>',
      // Head border
      '<rect x="8" y="10" width="40" height="34" rx="10" ry="10" stroke="#0d7a70" stroke-width="1"/>',

      // ── Ear bolts ──
      '<circle cx="8" cy="25" r="4" fill="#0f9488" stroke="#0d7a70" stroke-width="1"/>',
      '<circle cx="8" cy="25" r="2" fill="#0a5550"/>',
      '<circle cx="48" cy="25" r="4" fill="#0f9488" stroke="#0d7a70" stroke-width="1"/>',
      '<circle cx="48" cy="25" r="2" fill="#0a5550"/>',

      // ── Face viewport (clipped to head area) ──
      '<clipPath id="faceClip"><rect x="10" y="12" width="36" height="30" rx="6"/></clipPath>',
      '<g clip-path="url(#faceClip)" id="tb-face-group">',
        getFaceForExpression(expr),
      '</g>',

      // ── Mouth/chin area sensor strip ──
      '<rect x="18" y="40" width="20" height="3" rx="1.5" fill="#0a5550" stroke="#0d7a70" stroke-width="0.8"/>',
      '<rect x="20" y="40.5" width="4" height="2" rx="1" fill="#f0a830" opacity="0.6"/>',
      '<rect x="26" y="40.5" width="4" height="2" rx="1" fill="#f0a830" opacity="0.3"/>',

      // ── Neck ──
      '<rect x="22" y="44" width="12" height="5" rx="3" fill="#0f9488"/>',

      // ── Body ──
      '<rect x="10" y="49" width="36" height="22" rx="8" fill="url(#bodyGrad)"/>',
      '<rect x="10" y="49" width="36" height="22" rx="8" stroke="#0d7a70" stroke-width="1"/>',
      // Body highlight
      '<rect x="12" y="50" width="32" height="7" rx="4" fill="white" opacity="0.06"/>',

      // ── Chest panel ──
      '<rect x="18" y="55" width="20" height="10" rx="3" fill="#0a5550" stroke="#0d7a70" stroke-width="0.8"/>',
      // Chest indicator lights
      '<circle cx="23" cy="60" r="2.5" fill="#34d399" opacity="0.9"/>',
      '<circle cx="28" cy="60" r="2.5" fill="#f0a830" opacity="0.9"/>',
      '<circle cx="33" cy="60" r="2.5" fill="#60a5fa" opacity="0.9"/>',

      // ── Gradient defs ──
      '<defs>',
        '<linearGradient id="headGrad" x1="0" y1="0" x2="0" y2="1">',
          '<stop offset="0%" stop-color="#14b8a6"/>',
          '<stop offset="100%" stop-color="#0f9488"/>',
        '</linearGradient>',
        '<linearGradient id="bodyGrad" x1="0" y1="0" x2="0" y2="1">',
          '<stop offset="0%" stop-color="#0f9488"/>',
          '<stop offset="100%" stop-color="#0a5550"/>',
        '</linearGradient>',
      '</defs>',

      '</svg>'
    ].join('');
  }

  // ── CSS Keyframe Animations ─────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tb-styles')) return;
    var style = document.createElement('style');
    style.id = 'tb-styles';
    style.textContent = [
      // Respect prefers-reduced-motion
      '@media (prefers-reduced-motion: reduce) {',
        '#tunebot-fab, #tunebot-panel, #tb-mascot-svg, .tb-mascot-wrap { animation: none !important; transition: none !important; }',
      '}',

      // Idle bobbing animation — subtle float
      '@keyframes tb-bob {',
        '0%, 100% { transform: translateY(0px); }',
        '50% { transform: translateY(-3px); }',
      '}',

      // Wave animation — arm-like bob with slight rotation
      '@keyframes tb-wave {',
        '0%   { transform: translateY(0) rotate(0deg); }',
        '15%  { transform: translateY(-4px) rotate(-4deg); }',
        '30%  { transform: translateY(-2px) rotate(3deg); }',
        '45%  { transform: translateY(-5px) rotate(-5deg); }',
        '60%  { transform: translateY(-2px) rotate(2deg); }',
        '75%  { transform: translateY(-4px) rotate(-3deg); }',
        '100% { transform: translateY(0) rotate(0deg); }',
      '}',

      // Celebrate bounce — excited jumping
      '@keyframes tb-celebrate {',
        '0%   { transform: translateY(0) scale(1); }',
        '20%  { transform: translateY(-8px) scale(1.05); }',
        '40%  { transform: translateY(-2px) scale(0.98); }',
        '60%  { transform: translateY(-6px) scale(1.04); }',
        '80%  { transform: translateY(-1px) scale(0.99); }',
        '100% { transform: translateY(0) scale(1); }',
      '}',

      // Worried shake — horizontal tremble
      '@keyframes tb-worried {',
        '0%   { transform: translateX(0); }',
        '15%  { transform: translateX(-3px); }',
        '30%  { transform: translateX(3px); }',
        '45%  { transform: translateX(-2px); }',
        '60%  { transform: translateX(2px); }',
        '75%  { transform: translateX(-1px); }',
        '100% { transform: translateX(0); }',
      '}',

      // Thinking pulse — gentle scale breathe
      '@keyframes tb-think {',
        '0%, 100% { transform: scale(1); }',
        '50% { transform: scale(1.04); }',
      '}',

      // Antenna ping on celebrate
      '@keyframes tb-antenna-ping {',
        '0%, 100% { opacity: 1; transform: scale(1); }',
        '50% { opacity: 0.5; transform: scale(1.8); }',
      '}',

      // Expression transition
      '@keyframes tb-expression-pop {',
        '0%  { opacity: 0.3; transform: scale(0.92); }',
        '60% { transform: scale(1.05); }',
        '100%{ opacity: 1; transform: scale(1); }',
      '}',

      // Typing indicator dots
      '@keyframes tb-typing-dot {',
        '0%, 80%, 100% { transform: translateY(0); opacity: 0.3; }',
        '40% { transform: translateY(-5px); opacity: 1; }',
      '}',

      // Panel entrance animation
      '@keyframes tb-panel-in {',
        '0% { opacity: 0; transform: translateY(20px) scale(0.95); }',
        '100% { opacity: 1; transform: translateY(0) scale(1); }',
      '}',

      // FAB mascot container
      '.tb-mascot-wrap {',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1);',
      '}',

      // Animation state classes applied to wrapper
      '.tb-mascot-wrap.anim-bob    { animation: tb-bob 2.8s ease-in-out infinite; }',
      '.tb-mascot-wrap.anim-wave   { animation: tb-wave 1.4s ease-in-out; }',
      '.tb-mascot-wrap.anim-celebrate { animation: tb-celebrate 0.9s cubic-bezier(0.36,0.07,0.19,0.97); }',
      '.tb-mascot-wrap.anim-worried   { animation: tb-worried 0.5s ease-in-out; }',
      '.tb-mascot-wrap.anim-think     { animation: tb-think 2s ease-in-out infinite; }',

      // Face group transition
      '#tb-face-group { transition: opacity 0.2s ease; }',
      '#tb-face-group.tb-face-changing { animation: tb-expression-pop 0.3s ease forwards; }',

      // Typing indicator
      '.tb-typing-indicator { display: flex; align-items: center; gap: 4px; padding: 10px 14px; }',
      '.tb-typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #f0a830; opacity: 0.3; }',
      '.tb-typing-dot:nth-child(1) { animation: tb-typing-dot 1.2s 0s infinite; }',
      '.tb-typing-dot:nth-child(2) { animation: tb-typing-dot 1.2s 0.2s infinite; }',
      '.tb-typing-dot:nth-child(3) { animation: tb-typing-dot 1.2s 0.4s infinite; }',

      // Glass-morph panel
      '#tunebot-panel {',
        'backdrop-filter: blur(20px);',
        '-webkit-backdrop-filter: blur(20px);',
      '}',

      // Suggestion pill hover
      '.tb-suggestion:hover { border-color: #f0a830 !important; color: #f0a830 !important; }',

      // ── Voice styles ────────────────────────────────────────────────────
      // Mic button
      '#tb-mic { outline:none; }',
      '#tb-mic.tb-mic-listening { background: rgba(240,168,48,0.18) !important; border-color: rgba(240,168,48,0.5) !important; }',
      '#tb-mic.tb-mic-listening svg { color: #f0a830; }',
      '#tb-mic:hover svg { color: #e0e0f0 !important; }',

      // State badge
      '#tb-voice-badge {',
        'height: 20px;',
        'display: flex;',
        'align-items: center;',
        'gap: 5px;',
        'font-size: 11px;',
        'font-weight: 600;',
        'letter-spacing: 0.2px;',
        'color: #f0a830;',
        'opacity: 0;',
        'transition: opacity 0.2s ease;',
        'pointer-events: none;',
      '}',
      '#tb-voice-badge.tb-badge-visible { opacity: 1; }',

      // Pulsing dot for listening state
      '@keyframes tb-pulse-dot {',
        '0%, 100% { opacity: 1; transform: scale(1); }',
        '50% { opacity: 0.4; transform: scale(0.7); }',
      '}',
      '.tb-badge-dot { width:6px; height:6px; border-radius:50%; background:#f0a830; display:inline-block; animation:tb-pulse-dot 1s ease-in-out infinite; }',

      // Thinking dots animation — 3 dots that appear sequentially
      '@keyframes tb-think-dot-1 {',
        '0%, 20% { opacity: 0.2; transform: scale(0.6); }',
        '30%, 50% { opacity: 1; transform: scale(1); }',
        '60%, 100% { opacity: 0.2; transform: scale(0.6); }',
      '}',
      '@keyframes tb-think-dot-2 {',
        '0%, 30% { opacity: 0.2; transform: scale(0.6); }',
        '40%, 60% { opacity: 1; transform: scale(1); }',
        '70%, 100% { opacity: 0.2; transform: scale(0.6); }',
      '}',
      '@keyframes tb-think-dot-3 {',
        '0%, 40% { opacity: 0.2; transform: scale(0.6); }',
        '50%, 70% { opacity: 1; transform: scale(1); }',
        '80%, 100% { opacity: 0.2; transform: scale(0.6); }',
      '}',
      '.tb-think-dots { display: inline-flex; gap: 3px; align-items: center; margin-left: 2px; vertical-align: middle; }',
      '.tb-think-dots span { width: 5px; height: 5px; border-radius: 50%; background: #f0a830; display: inline-block; opacity: 0.2; }',
      '.tb-think-dots span:nth-child(1) { animation: tb-think-dot-1 1.4s ease-in-out infinite; }',
      '.tb-think-dots span:nth-child(2) { animation: tb-think-dot-2 1.4s ease-in-out infinite; }',
      '.tb-think-dots span:nth-child(3) { animation: tb-think-dot-3 1.4s ease-in-out infinite; }',

      // Thinking badge glow pulse
      '@keyframes tb-think-glow {',
        '0%, 100% { background: rgba(240,168,48,0.06); }',
        '50% { background: rgba(240,168,48,0.15); }',
      '}',
      '#tb-voice-badge.tb-badge-thinking {',
        'background: rgba(240,168,48,0.06);',
        'border-radius: 10px;',
        'padding: 2px 8px;',
        'animation: tb-think-glow 2s ease-in-out infinite;',
      '}',

      // Thinking status dot pulse (for the mascot status area)
      '@keyframes tb-status-pulse {',
        '0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(240,168,48,0.4); }',
        '50% { opacity: 0.7; box-shadow: 0 0 6px 2px rgba(240,168,48,0.3); }',
      '}',
      '.tb-status-thinking { animation: tb-status-pulse 1.5s ease-in-out infinite; }',

      // Voice toggle button
      '#tb-voice-toggle { outline:none; }',
      '#tb-voice-toggle.tb-voice-on svg { color: #f0a830 !important; }',

      // ── Header speaking badge waveform animation ─────────────────────
      '@keyframes tb-wave-bar {',
        '0%, 100% { transform: scaleY(0.4); }',
        '50% { transform: scaleY(1); }',
      '}',
      '.tb-wave-bars { display:inline-flex; align-items:center; gap:2px; height:12px; }',
      '.tb-wave-bars span {',
        'display:block; width:2px; border-radius:1px; background:#60a5fa; height:100%;',
        'transform-origin:center;',
      '}',
      '.tb-wave-bars span:nth-child(1) { animation: tb-wave-bar 0.7s 0.0s ease-in-out infinite; }',
      '.tb-wave-bars span:nth-child(2) { animation: tb-wave-bar 0.7s 0.15s ease-in-out infinite; }',
      '.tb-wave-bars span:nth-child(3) { animation: tb-wave-bar 0.7s 0.30s ease-in-out infinite; }',
      '.tb-wave-bars span:nth-child(4) { animation: tb-wave-bar 0.7s 0.45s ease-in-out infinite; }',
      '#tb-header-speaking:hover { background: rgba(96,165,250,0.2) !important; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── Expression Manager ──────────────────────────────────────────────────────
  // Detects health score on the current page and sets initial expression
  function detectPageHealthScore() {
    // Look for score elements — TuneVault displays scores in various formats
    // Common patterns: data-score attribute, .health-score text, score badge
    var scoreEl = (
      document.querySelector('[data-score]') ||
      document.querySelector('.health-score-value') ||
      document.querySelector('.score-number') ||
      document.querySelector('[class*="score-badge"]')
    );
    if (scoreEl) {
      var raw = scoreEl.getAttribute('data-score') || scoreEl.textContent;
      var num = parseInt(raw, 10);
      if (!isNaN(num)) return num;
    }
    // Also check for score in page text patterns like "Score: 87"
    var bodyText = document.body.innerText || '';
    var match = bodyText.match(/(?:score|health)[\s:]+(\d{1,3})/i);
    if (match) {
      var n = parseInt(match[1], 10);
      if (n >= 0 && n <= 100) return n;
    }
    return null;
  }

  function expressionForScore(score) {
    if (score === null) return 'idle';
    if (score >= 80) return 'happy';
    if (score >= 50) return 'concerned';
    return 'worried';
  }

  function setExpression(expr, animClass) {
    if (expr === currentExpression && !animClass) return;
    currentExpression = expr;

    // Update the face SVG content
    var faceGroup = document.getElementById('tb-face-group');
    if (faceGroup) {
      faceGroup.classList.remove('tb-face-changing');
      // Force reflow
      void faceGroup.offsetWidth;
      faceGroup.innerHTML = getFaceForExpression(expr);
      faceGroup.classList.add('tb-face-changing');
      setTimeout(function () {
        if (faceGroup) faceGroup.classList.remove('tb-face-changing');
      }, 300);
    }

    // Update animation class on mascot wrapper
    var wrap = document.getElementById('tb-mascot-wrap');
    if (wrap) {
      wrap.className = 'tb-mascot-wrap';
      if (animClass) {
        wrap.classList.add('anim-' + animClass);
        // Remove one-shot animations after they finish
        if (animClass !== 'bob' && animClass !== 'think') {
          setTimeout(function () {
            if (wrap) wrap.classList.remove('anim-' + animClass);
            // Return to default idle animation
            if (wrap && (currentExpression === 'idle' || currentExpression === 'happy' || currentExpression === 'wave')) {
              wrap.classList.add('anim-bob');
            }
          }, animClass === 'celebrate' ? 900 : animClass === 'wave' ? 1400 : 500);
        }
      } else {
        // Default: happy/idle bobs, thinking pulses, worried nothing
        if (expr === 'thinking') {
          wrap.classList.add('anim-think');
        } else if (expr !== 'worried') {
          wrap.classList.add('anim-bob');
        }
      }
    }
  }

  // ── Idle + First-Visit Greeting ─────────────────────────────────────────────
  function startIdleGreeting() {
    clearTimeout(idleTimer);
    // If never greeted, wave after 4 seconds on page
    if (!hasGreeted) {
      idleTimer = setTimeout(function () {
        if (!isOpen) {
          setExpression('wave', 'wave');
          hasGreeted = true;
          // After wave, return to score-based expression
          setTimeout(function () {
            var score = detectPageHealthScore();
            setExpression(expressionForScore(score));
          }, 1600);
        }
      }, 4000);
    }
  }

  // ── UI Building ─────────────────────────────────────────────────────────────
  function buildWidget() {
    // Guard against double initialisation (script loaded twice, etc.)
    if (document.getElementById('tunebot-fab')) return;

    injectStyles();

    // Inject Google Fonts
    if (!document.querySelector('link[href*="JetBrains+Mono"]')) {
      var fontLink = document.createElement('link');
      fontLink.rel = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
      document.head.appendChild(fontLink);
    }

    // Determine initial expression from page health score
    var initScore = detectPageHealthScore();
    var initExpr = expressionForScore(initScore);
    currentExpression = initExpr;

    // ── FAB: the mascot character itself ──────────────────────────────────────
    var fab = document.createElement('button');
    fab.id = 'tunebot-fab';
    fab.setAttribute('data-testid', 'tunebot-widget');
    fab.setAttribute('aria-label', 'Ask TuneBot');
    fab.setAttribute('title', 'TuneBot — Ask anything');
    // Always use top/left anchoring for reliable drag behaviour — never bottom/right.
    // If a stored position exists, apply it directly; otherwise default to bottom-right
    // equivalent which we compute after the element is in the DOM (see normalizeFabPos below).
    var fabBaseStyle = [
      'position:fixed',
      'z-index:9990',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:4px',
      'padding:0',
      'background:transparent',
      'border:none',
      'cursor:pointer',
      'user-select:none',
      'outline:none',
    ];
    // On /pricing the default bottom-right position overlaps the Enterprise card.
    // Use bottom-left instead when no stored position exists.
    var isPricingPage = window.location.pathname === '/pricing';
    if (tbWidgetPos) {
      fabBaseStyle.push('left:' + tbWidgetPos.left + 'px');
      fabBaseStyle.push('top:' + tbWidgetPos.top + 'px');
    } else if (isPricingPage) {
      fabBaseStyle.push('bottom:24px');
      fabBaseStyle.push('left:24px');
    } else {
      // Temporary anchor — will be normalised to top/left after DOM insertion
      fabBaseStyle.push('bottom:24px');
      fabBaseStyle.push('right:24px');
    }
    fab.style.cssText = fabBaseStyle.join(';');

    // The mascot wrapper (animated)
    var mascotWrap = document.createElement('div');
    mascotWrap.id = 'tb-mascot-wrap';
    mascotWrap.className = 'tb-mascot-wrap';
    if (initExpr === 'thinking') {
      mascotWrap.classList.add('anim-think');
    } else if (initExpr !== 'worried') {
      mascotWrap.classList.add('anim-bob');
    }
    mascotWrap.innerHTML = buildMascotSVG(initExpr, 56);

    // Label badge below mascot
    var label = document.createElement('div');
    label.id = 'tunebot-fab-label';
    label.style.cssText = [
      'background:linear-gradient(135deg,#f0a830 0%,#e09820 100%)',
      'color:#0a0a0c',
      'border-radius:20px',
      'padding:3px 10px',
      'font-family:"Space Grotesk",-apple-system,BlinkMacSystemFont,sans-serif',
      'font-size:11px',
      'font-weight:700',
      'letter-spacing:0.3px',
      'box-shadow:0 2px 12px rgba(240,168,48,0.4)',
      'transition:all 0.2s ease',
      'pointer-events:none',
    ].join(';');
    label.textContent = 'TuneBot';

    fab.appendChild(mascotWrap);
    fab.appendChild(label);

    // Hover: scale up + shadow
    fab.addEventListener('mouseenter', function () {
      mascotWrap.style.transform = 'scale(1.1)';
      label.style.boxShadow = '0 4px 20px rgba(240,168,48,0.6)';
    });
    fab.addEventListener('mouseleave', function () {
      mascotWrap.style.transform = '';
      label.style.boxShadow = '0 2px 12px rgba(240,168,48,0.4)';
    });
    fab.addEventListener('click', togglePanel);

    // ── Chat Panel ─────────────────────────────────────────────────────────
    var panel = document.createElement('div');
    panel.id = 'tunebot-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'TuneBot Help Assistant');
    var isMobile = window.innerWidth < 768;
    var panelStyles = [
      'position:fixed',
      'z-index:9991',
      'background:rgba(14,14,20,0.96)',
      'border:1px solid rgba(255,255,255,0.08)',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      'box-shadow:0 20px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(240,168,48,0.06)',
      'opacity:0',
      'pointer-events:none',
      'font-family:"Space Grotesk",-apple-system,BlinkMacSystemFont,sans-serif',
    ];
    if (isMobile) {
      // Mobile: full-width drawer from bottom
      panelStyles.push('left:0', 'right:0', 'bottom:0');
      panelStyles.push('width:100%', 'max-width:100%', 'max-height:85vh');
      panelStyles.push('border-radius:20px 20px 0 0');
      panelStyles.push('transform:translateY(100%)');
      panelStyles.push('transition:opacity 0.3s ease,transform 0.3s cubic-bezier(0.32,0.72,0,1)');
    } else {
      // Desktop: floating panel anchored near the FAB
      panelStyles.push('width:390px', 'max-width:calc(100vw - 28px)', 'max-height:72vh');
      panelStyles.push('border-radius:20px');
      panelStyles.push('transform:translateY(20px) scale(0.95)');
      panelStyles.push('transition:opacity 0.25s ease,transform 0.25s cubic-bezier(0.34,1.56,0.64,1)');
      // Position relative to FAB
      if (tbWidgetPos) {
        // Stored position — panel appears above/beside FAB at the same left
        var panelLeft = Math.min(tbWidgetPos.left, window.innerWidth - 400);
        var panelTop = Math.max(8, tbWidgetPos.top - 570);
        panelStyles.push('left:' + panelLeft + 'px', 'top:' + panelTop + 'px');
      } else if (isPricingPage) {
        // On /pricing FAB is bottom-left — panel opens above it on the left side
        panelStyles.push('bottom:120px', 'left:20px');
      } else {
        panelStyles.push('bottom:120px', 'right:20px');
      }
    }
    panel.style.cssText = panelStyles.join(';');

    panel.innerHTML = buildPanelHTML(initExpr);

    // Mobile backdrop: semi-transparent overlay behind drawer
    var backdrop = document.createElement('div');
    backdrop.id = 'tunebot-backdrop';
    backdrop.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9989',
      'background:rgba(0,0,0,0.5)', 'opacity:0', 'pointer-events:none',
      'transition:opacity 0.3s ease',
    ].join(';');
    backdrop.addEventListener('click', function () { closePanel(); });

    document.body.appendChild(backdrop);
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    // Normalise FAB to top/left positioning immediately so drag code never
    // has to deal with competing bottom/right constraints mid-mousemove.
    // The FAB may have been initialised with bottom/right defaults (no stored pos).
    // We resolve them to absolute top/left now while the element is in the DOM.
    // Use removeProperty to fully purge bottom/right from the inline style —
    // setting 'auto' via style.bottom can leave ghost values in some browsers.
    if (!tbWidgetPos && window.innerWidth >= 768) {
      var r = fab.getBoundingClientRect();
      fab.style.removeProperty('bottom');
      fab.style.removeProperty('right');
      fab.style.removeProperty('left');
      fab.style.top = r.top + 'px';
      fab.style.left = r.left + 'px';
    }

    // On mobile, override openPanel/closePanel to also control backdrop
    if (isMobile) {
      var _origOpen = openPanel;
      openPanel = function () {
        _origOpen();
        backdrop.style.opacity = '1';
        backdrop.style.pointerEvents = 'auto';
      };
      var _origClose = closePanel;
      closePanel = function () {
        _origClose();
        backdrop.style.opacity = '0';
        backdrop.style.pointerEvents = 'none';
      };
    }

    wirePanel();
    wireVoice();
    wireVoiceInputHooks();
    startIdleGreeting();
  }

  function buildPanelHTML(expr) {
    var miniSvg = buildMascotSVG(expr || 'idle', 36);

    var suggHtml = SUGGESTIONS.map(function (s) {
      return '<button class="tb-suggestion" style="' +
        'display:inline-block;padding:5px 12px;background:rgba(255,255,255,0.04);' +
        'border:1px solid rgba(255,255,255,0.08);border-radius:20px;color:#9090a8;' +
        'font-size:12px;cursor:pointer;transition:all 0.15s;font-family:inherit;' +
        'white-space:nowrap;flex-shrink:0;letter-spacing:-0.1px;">' +
        escHtml(s) + '</button>';
    }).join('');

    return [
      // ── Header (drag handle on desktop) ──
      '<div id="tb-header" style="display:flex;flex-direction:column;',
        'border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;',
        'background:rgba(240,168,48,0.04);user-select:none;">',
        // Grip dots row — visual drag handle hint (hidden on mobile via JS)
        '<div id="tb-grip" style="display:flex;justify-content:center;gap:3px;padding:5px 0 0;opacity:0.25;">',
          '<span style="width:3px;height:3px;border-radius:50%;background:#a0a0b8;display:block;"></span>',
          '<span style="width:3px;height:3px;border-radius:50%;background:#a0a0b8;display:block;"></span>',
          '<span style="width:3px;height:3px;border-radius:50%;background:#a0a0b8;display:block;"></span>',
          '<span style="width:3px;height:3px;border-radius:50%;background:#a0a0b8;display:block;"></span>',
          '<span style="width:3px;height:3px;border-radius:50%;background:#a0a0b8;display:block;"></span>',
          '<span style="width:3px;height:3px;border-radius:50%;background:#a0a0b8;display:block;"></span>',
        '</div>',
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px 12px;">',
        '<div style="display:flex;align-items:center;gap:10px;">',
          '<div id="tb-panel-mascot" style="flex-shrink:0;display:flex;align-items:center;">' + miniSvg + '</div>',
          '<div>',
            '<div style="display:flex;align-items:center;gap:8px;">',
              '<div style="font-size:14px;font-weight:700;color:#f0f0f8;letter-spacing:-0.4px;">TuneBot</div>',
              // Speaking badge — visible in header while TTS is active; click to stop
              '<div id="tb-header-speaking" title="Speaking — click to stop" style="display:none;',
                'align-items:center;gap:4px;padding:2px 7px;border-radius:20px;',
                'background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.3);',
                'cursor:pointer;',
                'font-size:10px;font-weight:700;color:#60a5fa;letter-spacing:0.3px;',
                'transition:opacity 0.2s ease;">',
                '<span class="tb-wave-bars">',
                  '<span></span><span></span><span></span><span></span>',
                '</span>',
                'speaking\u2026',
              '</div>',
            '</div>',
            '<div style="font-size:11px;color:#505060;margin-top:1px;letter-spacing:0.1px;">',
              '<span id="tb-status-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#34d399;margin-right:4px;vertical-align:middle;"></span>',
              '<span id="tb-status-text">Ready to help</span>',
            '</div>',
            // Context badge — hidden until context loads
            '<div id="tb-context-badge" style="display:none;margin-top:4px;font-size:10px;',
              'font-weight:600;letter-spacing:0.2px;border-radius:20px;',
              'padding:2px 8px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">',
            '</div>',
            '<select id="tb-conn-select" style="display:none;margin-top:6px;font-size:11px;background:rgba(255,255,255,0.06);border:1px solid rgba(240,168,48,0.3);color:#e8e8ed;border-radius:6px;padding:3px 6px;cursor:pointer;font-family:inherit;max-width:210px;" onchange="tbSwitchConnection(this.value)">',
            '</select>',
          '</div>',
        '</div>',
        '<div style="display:flex;align-items:center;gap:6px;">',
          '<button id="tb-clear" title="New conversation" style="background:rgba(255,255,255,0.04);',
            'border:1px solid rgba(240,168,48,0.4);cursor:pointer;color:#9898a8;padding:5px 6px;',
            'border-radius:6px;transition:all 0.15s;display:none;font-size:10px;font-weight:600;',
            'font-family:inherit;letter-spacing:0.2px;" ',
            'onmouseover="this.style.background=\'rgba(240,168,48,0.12)\';this.style.color=\'#f0a830\';this.style.borderColor=\'rgba(240,168,48,0.7)\'" ',
            'onmouseout="this.style.background=\'rgba(255,255,255,0.04)\';this.style.color=\'#9898a8\';this.style.borderColor=\'rgba(240,168,48,0.4)\'">',
            'NEW',
          '</button>',
          // Voice toggle — prominent ON/OFF pill (only shown when TTS is supported)
          '<button id="tb-voice-toggle" style="display:none;',
            'align-items:center;gap:5px;padding:4px 9px;border-radius:20px;',
            'cursor:pointer;font-size:10px;font-weight:700;letter-spacing:0.3px;',
            'font-family:inherit;transition:all 0.2s;border:1px solid rgba(255,255,255,0.1);',
            'background:rgba(255,255,255,0.05);color:#505068;">',
            '<svg id="tb-voice-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
              // Speaker icon (paths swapped via setVoiceEnabled)
              '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>',
              '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
              '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
            '</svg>',
            '<span id="tb-voice-label">Voice</span>',
          '</button>',
          // Minimize — collapses panel back to FAB bubble
          '<button id="tb-minimize" title="Minimize" style="background:rgba(255,255,255,0.04);',
            'border:1px solid rgba(240,168,48,0.4);cursor:pointer;color:#9898a8;padding:5px;',
            'border-radius:6px;transition:all 0.15s;display:flex;align-items:center;justify-content:center;" ',
            'onmouseover="this.style.background=\'rgba(240,168,48,0.12)\';this.style.color=\'#f0a830\';this.style.borderColor=\'rgba(240,168,48,0.7)\'" ',
            'onmouseout="this.style.background=\'rgba(255,255,255,0.04)\';this.style.color=\'#9898a8\';this.style.borderColor=\'rgba(240,168,48,0.4)\'">',
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
              '<line x1="5" y1="12" x2="19" y2="12"/>',
            '</svg>',
          '</button>',
          // Close — hides widget entirely until next page load
          '<button id="tb-close" title="Hide TuneBot" style="background:rgba(255,255,255,0.04);',
            'border:1px solid rgba(240,168,48,0.4);cursor:pointer;color:#9898a8;padding:5px;',
            'border-radius:6px;transition:all 0.15s;display:flex;align-items:center;justify-content:center;" ',
            'onmouseover="this.style.background=\'rgba(240,168,48,0.12)\';this.style.color=\'#f0a830\';this.style.borderColor=\'rgba(240,168,48,0.7)\'" ',
            'onmouseout="this.style.background=\'rgba(255,255,255,0.04)\';this.style.color=\'#9898a8\';this.style.borderColor=\'rgba(240,168,48,0.4)\'">',
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
              '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
            '</svg>',
          '</button>',
        '</div>',
      '</div>',
      '</div>',  // close #tb-header

      // ── Messages ──
      '<div id="tb-messages" style="flex:1;overflow-y:auto;padding:16px 14px 8px;',
        'display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;',
        'scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.08) transparent;">',
        // Welcome state
        '<div id="tb-welcome" style="text-align:center;padding:16px 12px 4px;">',
          '<div style="font-size:13px;font-weight:600;color:#d0d0e8;margin-bottom:6px;letter-spacing:-0.3px;">Hi, I\'m TuneBot</div>',
          '<div style="font-size:12px;color:#50505e;line-height:1.6;">',
            'Ask me about setup, health checks, EBS, pricing, or anything TuneVault.',
          '</div>',
        '</div>',
        // Suggestions
        '<div id="tb-suggestions" style="display:flex;flex-wrap:wrap;gap:5px;padding-bottom:4px;">',
          suggHtml,
        '</div>',
      '</div>',

      // ── Input area ──
      '<div style="padding:10px 14px 13px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;',
        'background:rgba(0,0,0,0.2);">',
        // Voice state badge — shown above input when voice is active
        '<div id="tb-voice-badge" style="margin-bottom:6px;padding-left:2px;">',
          '<span class="tb-badge-dot"></span>',
          '<span id="tb-voice-badge-text">Listening…</span>',
        '</div>',
        '<div style="display:flex;gap:8px;align-items:flex-end;">',
          // Mic button — only shown when SpeechRecognition is supported
          '<button id="tb-mic" title="Click to speak" style="display:none;',
            'width:36px;height:36px;background:rgba(255,255,255,0.05);',
            'border:1px solid rgba(255,255,255,0.1);border-radius:9px;cursor:pointer;',
            'align-items:center;justify-content:center;transition:all 0.2s;flex-shrink:0;">',
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:#6060a0;">',
              '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>',
              '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>',
              '<line x1="12" y1="19" x2="12" y2="23"/>',
              '<line x1="8" y1="23" x2="16" y2="23"/>',
            '</svg>',
          '</button>',
          '<textarea id="tb-input" rows="1" placeholder="Ask TuneBot anything..." style="',
            'flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);',
            'border-radius:10px;padding:9px 12px;color:#e0e0f0;font-size:13px;font-family:inherit;',
            'resize:none;outline:none;transition:border-color 0.15s,background 0.15s;',
            'min-height:38px;max-height:100px;line-height:1.5;overflow-y:auto;',
            'letter-spacing:-0.1px;',
          '"></textarea>',
          '<button id="tb-send" style="',
            'width:36px;height:36px;background:linear-gradient(135deg,#f0a830,#e09820);',
            'border:none;border-radius:9px;cursor:pointer;display:flex;align-items:center;',
            'justify-content:center;transition:all 0.15s;flex-shrink:0;',
            'box-shadow:0 2px 10px rgba(240,168,48,0.3);',
          '" title="Send" ',
          'onmouseover="this.style.transform=\'scale(1.08)\';this.style.boxShadow=\'0 4px 16px rgba(240,168,48,0.5)\'" ',
          'onmouseout="this.style.transform=\'scale(1)\';this.style.boxShadow=\'0 2px 10px rgba(240,168,48,0.3)\'">',
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0a0a0c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
              '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
            '</svg>',
          '</button>',
        '</div>',
        '<div style="margin-top:7px;text-align:center;font-size:10px;color:#2c2c3a;letter-spacing:0.1px;">',
          'AI · context-aware · ',
          '<a href="mailto:support@tunevault.app" style="color:#383848;text-decoration:none;" ',
            'onmouseover="this.style.color=\'#f0a830\'" onmouseout="this.style.color=\'#383848\'">',
            'Email support</a>',
        '</div>',
      '</div>',
    ].join('');
  }

  // ── Panel wiring ────────────────────────────────────────────────────────────
  function wirePanel() {
    var panel = document.getElementById('tunebot-panel');
    var input = document.getElementById('tb-input');
    var sendBtn = document.getElementById('tb-send');
    var closeBtn = document.getElementById('tb-close');
    var minimizeBtn = document.getElementById('tb-minimize');
    var clearBtn = document.getElementById('tb-clear');
    var messages = document.getElementById('tb-messages');

    // Minimize: collapse panel back to FAB bubble (same as clicking FAB again)
    minimizeBtn.addEventListener('click', function () { closePanel(); });

    // Close: collapse panel back to FAB (same as minimize — FAB stays visible)
    closeBtn.addEventListener('click', function () { closePanel(); });

    clearBtn.addEventListener('click', function () {
      conversationHistory = [];
      var defaultSuggs = SUGGESTIONS;
      messages.innerHTML = [
        '<div id="tb-welcome" style="text-align:center;padding:16px 12px 4px;">',
          '<div style="font-size:13px;font-weight:600;color:#d0d0e8;margin-bottom:6px;letter-spacing:-0.3px;">Hi, I\'m TuneBot</div>',
          '<div style="font-size:12px;color:#50505e;line-height:1.6;">Ask me about setup, health checks, EBS, pricing, or anything TuneVault.</div>',
        '</div>',
        '<div id="tb-suggestions" style="display:flex;flex-wrap:wrap;gap:5px;padding-bottom:4px;">',
          defaultSuggs.map(function (s) {
            return '<button class="tb-suggestion" style="display:inline-block;padding:5px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;color:#9090a8;font-size:12px;cursor:pointer;transition:all 0.15s;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:-0.1px;">' + escHtml(s) + '</button>';
          }).join(''),
        '</div>'
      ].join('');
      clearBtn.style.display = 'none';
      wireSuggestions();
      // Re-populate welcome with context if available
      if (tbContext && tbContextLoaded) updateWelcomeForContext();
      // Back to idle expression
      var score = detectPageHealthScore();
      setExpression(expressionForScore(score));
      setStatus('Ready to help', 'green');
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitQuestion();
      }
    });

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });

    input.addEventListener('focus', function () {
      input.style.borderColor = 'rgba(240,168,48,0.4)';
      input.style.background = 'rgba(255,255,255,0.07)';
    });
    input.addEventListener('blur', function () {
      input.style.borderColor = 'rgba(255,255,255,0.09)';
      input.style.background = 'rgba(255,255,255,0.05)';
    });

    sendBtn.addEventListener('click', submitQuestion);
    wireSuggestions();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) closePanel();
    });

    // ── Drag-to-reposition (desktop only, ≥768px) ────────────────────────────
    // FAB and panel are a unified widget. Drag is possible via:
    //   (a) panel header — when panel is open
    //   (b) FAB itself   — when panel is collapsed
    // Position persists in localStorage (tvBotPosition). Mobile uses a
    // bottom-drawer; drag is disabled there.
    if (window.innerWidth >= 768) {
      var header = document.getElementById('tb-header');
      var grip   = document.getElementById('tb-grip');
      var fabDragEl = document.getElementById('tunebot-fab');

      // startWidgetDrag: capture starting positions for panel+FAB.
      // panelKnown=true when called from header drag (panel is visible);
      // panelKnown=false when called from FAB drag (panel is hidden).
      function startWidgetDrag(clientX, clientY, panelKnown) {
        var panelEl = document.getElementById('tunebot-panel');
        var fabEl   = document.getElementById('tunebot-fab');
        if (!fabEl) return;

        var fabRect   = fabEl.getBoundingClientRect();
        var panelRect = panelKnown && panelEl ? panelEl.getBoundingClientRect() : null;

        tbDragState = {
          startX:       clientX,
          startY:       clientY,
          startFabLeft: fabRect.left,
          startFabTop:  fabRect.top,
          startPanelLeft: panelRect ? panelRect.left : 0,
          startPanelTop:  panelRect ? panelRect.top  : 0,
          panelKnown: !!panelKnown
        };
      }

      // Header drag (panel open)
      if (header) {
        header.style.cursor = 'grab';
        header.addEventListener('mouseenter', function () {
          if (grip) grip.style.opacity = '0.55';
        });
        header.addEventListener('mouseleave', function () {
          if (grip && !tbDragState) grip.style.opacity = '0.25';
        });
        header.addEventListener('mousedown', function (e) {
          if (e.target.closest('button')) return;
          e.preventDefault();
          header.style.cursor = 'grabbing';
          if (grip) grip.style.opacity = '0.7';
          startWidgetDrag(e.clientX, e.clientY, true);
        });
      }

      // FAB drag (collapsed mode) — track whether mouse moved so we can
      // suppress the click→togglePanel if this was actually a drag.
      var fabDragMoved = false;
      if (fabDragEl) {
        fabDragEl.addEventListener('mousedown', function (e) {
          if (isOpen) return; // panel open — header handles dragging
          e.preventDefault();
          fabDragMoved = false;
          fabDragEl.style.cursor = 'grabbing';
          startWidgetDrag(e.clientX, e.clientY, false);
        });
      }

      document.addEventListener('mousemove', function (e) {
        if (!tbDragState) return;
        var panelEl = document.getElementById('tunebot-panel');
        var fabEl   = document.getElementById('tunebot-fab');
        if (!fabEl) return;

        var dx = e.clientX - tbDragState.startX;
        var dy = e.clientY - tbDragState.startY;

        // Suppress toggle-click if the mouse has travelled > 4px
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) fabDragMoved = true;

        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var margin = 8;

        // Move FAB — purge any residual bottom/right anchors so left/top take effect
        var fw = fabEl.offsetWidth;
        var fh = fabEl.offsetHeight;
        var newFabLeft = Math.max(margin, Math.min(tbDragState.startFabLeft + dx, vw - fw - margin));
        var newFabTop  = Math.max(margin, Math.min(tbDragState.startFabTop  + dy, vh - fh - margin));
        fabEl.style.removeProperty('bottom');
        fabEl.style.removeProperty('right');
        fabEl.style.left = newFabLeft + 'px';
        fabEl.style.top  = newFabTop  + 'px';
        fabEl.style.transition = 'none';

        // Move panel in sync (only when it was visible at drag start)
        if (tbDragState.panelKnown && panelEl) {
          var pw = panelEl.offsetWidth;
          var ph = panelEl.offsetHeight;
          var newPanelLeft = Math.max(margin, Math.min(tbDragState.startPanelLeft + dx, vw - pw - margin));
          var newPanelTop  = Math.max(margin, Math.min(tbDragState.startPanelTop  + dy, vh - ph - margin));
          panelEl.style.removeProperty('bottom');
          panelEl.style.removeProperty('right');
          panelEl.style.left = newPanelLeft + 'px';
          panelEl.style.top  = newPanelTop  + 'px';
          panelEl.style.transition = 'opacity 0.25s ease';
        }
      });

      document.addEventListener('mouseup', function () {
        if (!tbDragState) return;
        var panelEl = document.getElementById('tunebot-panel');
        var fabEl   = document.getElementById('tunebot-fab');

        if (panelEl) {
          panelEl.style.transition = 'opacity 0.25s ease,transform 0.25s cubic-bezier(0.34,1.56,0.64,1)';
        }
        if (fabEl) {
          fabEl.style.transition = '';
          fabEl.style.cursor = '';
          // Persist FAB anchor; openPanel() uses this to place the panel correctly
          var fabRect = fabEl.getBoundingClientRect();
          tbWidgetPos = { left: fabRect.left, top: fabRect.top };
          try { localStorage.setItem('tvBotPosition', JSON.stringify(tbWidgetPos)); } catch (e) {}
        }

        tbDragState = null;
        if (header) header.style.cursor = 'grab';
        if (grip)   grip.style.opacity = '0.25';
      });

      // Suppress FAB click-to-toggle when the mouse actually dragged
      if (fabDragEl) {
        fabDragEl.addEventListener('click', function (e) {
          if (fabDragMoved) {
            e.stopImmediatePropagation();
            fabDragMoved = false;
          }
        }, true); // capture phase so it fires before the togglePanel listener
      }

    } else {
      // Mobile: hide grip dots — drawer slides up from bottom, no drag
      var grip = document.getElementById('tb-grip');
      if (grip) grip.style.display = 'none';
    }
  }

  function setStatus(text, color) {
    var dot = document.getElementById('tb-status-dot');
    var txt = document.getElementById('tb-status-text');
    if (dot) {
      var colors = { green: '#34d399', amber: '#f0a830', blue: '#60a5fa' };
      dot.style.background = colors[color] || '#34d399';
      // Add pulse animation to status dot when thinking
      if (text === 'Thinking\u2026' || text === 'Listening\u2026') {
        dot.classList.add('tb-status-thinking');
      } else {
        dot.classList.remove('tb-status-thinking');
      }
    }
    if (txt) {
      // Animated dots for thinking state in the mascot status area
      if (text === 'Thinking\u2026') {
        txt.innerHTML = 'Thinking<span class="tb-think-dots"><span></span><span></span><span></span></span>';
      } else {
        txt.textContent = text;
      }
    }
  }

  function wireSuggestions() {
    var suggestions = document.querySelectorAll('.tb-suggestion');
    suggestions.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var q = btn.textContent;
        document.getElementById('tb-input').value = q;
        submitQuestion();
      });
    });
  }

  function submitQuestion() {
    var input = document.getElementById('tb-input');
    var q = input.value.trim();
    if (!q) return;
    input.value = '';
    input.style.height = 'auto';
    currentQuestion = q;
    addUserBubble(q);

    setExpression('thinking');
    setStatus('Thinking…', 'amber');

    trackQuestion(q, null);

    // If we have context loaded, use AI chat. Otherwise fall back to KB.
    if (tbContext && !tbContext.noConnections) {
      askAI(q);
    } else {
      // KB fallback (no context or not logged in)
      var entry = findAnswer(q);
      setTimeout(function () {
        addBotBubble(entry, q);
        if (entry) {
          setExpression('happy');
          setStatus('Ready to help', 'green');
        } else {
          setExpression('concerned');
          setStatus('Hmm, not sure', 'amber');
          setTimeout(function () {
            setExpression(expressionForScore(detectPageHealthScore()));
            setStatus('Ready to help', 'green');
          }, 3000);
        }
        var clearBtn = document.getElementById('tb-clear');
        if (clearBtn) clearBtn.style.display = 'inline-flex';
      }, 220);
    }
  }

  // ── AI chat via /api/tunebot/chat ────────────────────────────────────────
  function askAI(question) {
    // Build compact conversation history for the request
    var historyPayload = conversationHistory.slice(-8).map(function (t) {
      return { role: t.role, content: t.text };
    });

    fetch('/api/tunebot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: question,
        context: tbContext,
        history: historyPayload
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          // API error — try KB fallback
          var entry = findAnswer(question);
          addBotBubble(entry, question);
          setExpression('concerned');
          setStatus('Ready to help', 'green');
        } else {
          addAIBubble(data.reply);
          conversationHistory.push({ role: 'assistant', text: data.reply });
          setExpression('happy');
          setStatus('Ready to help', 'green');
        }
        var clearBtn = document.getElementById('tb-clear');
        if (clearBtn) clearBtn.style.display = 'inline-flex';
      })
      .catch(function () {
        // Network error — KB fallback
        var entry = findAnswer(question);
        addBotBubble(entry, question);
        setExpression('concerned');
        setStatus('Ready to help', 'green');
        var clearBtn = document.getElementById('tb-clear');
        if (clearBtn) clearBtn.style.display = 'inline-flex';
      });
  }

  // ── Context loading ───────────────────────────────────────────────────────
  function detectConnectionIdFromPage() {
    // Try URL params (e.g. /dashboard?connection=42)
    var params = new URLSearchParams(window.location.search);
    var fromParam = parseInt(params.get('connection') || params.get('connectionId') || params.get('conn'), 10);
    if (!isNaN(fromParam)) return fromParam;
    // Try data attribute on page (pages can set window.tuneBotConnectionId)
    if (window.tuneBotConnectionId) return parseInt(window.tuneBotConnectionId, 10);
    // Read from shared connection state (localStorage — set by dashboard, db-ops, patches, etc.)
    // This is the primary source on most pages since tvConn persists the user's last selection.
    if (window.tvConn && typeof window.tvConn.load === 'function') {
      var stored = window.tvConn.load();
      if (stored) {
        var parsed = parseInt(stored, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
    // URL path: only match /connection(s)/ID — NOT /report/ID (report URLs contain health check IDs, not connection IDs)
    var pathMatch = window.location.pathname.match(/\/(?:connection|connections)\/(\d+)/);
    if (pathMatch) return parseInt(pathMatch[1], 10);
    return null;
  }

  function fetchContext(connectionId) {
    tbContextLoading = true;
    var url = '/api/tunebot/context';
    // If no explicit connectionId, try to detect from the page
    var resolvedId = connectionId || detectConnectionIdFromPage();
    if (resolvedId) url += '?connectionId=' + resolvedId;
    // Track which connection we fetched so we can detect changes later
    tbContextConnId = resolvedId || null;

    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) return null; // Not logged in — use KB only
        return r.json();
      })
      .then(function (data) {
        tbContextLoading = false;
        tbContextLoaded = true;
        if (!data) return; // Not authenticated
        tbContext = data;
        renderContextBadge();
        updateWelcomeForContext();
      })
      .catch(function () {
        tbContextLoading = false;
        tbContextLoaded = true;
        tbContext = null;
      });
  }

  function renderContextBadge() {
    var badge = document.getElementById('tb-context-badge');
    if (!badge) return;
    if (!tbContext) {
      badge.style.display = 'none';
      return;
    }
    if (tbContext.noConnections) {
      badge.textContent = 'No connections';
      badge.style.background = 'rgba(255,255,255,0.05)';
      badge.style.color = '#9898a8';
      badge.style.display = 'inline-block';
      return;
    }
    if (tbContext.noHealthCheck) {
      var connName = tbContext.activeConnection ? tbContext.activeConnection.name : 'No health check';
      badge.textContent = '⚡ ' + connName + ' — run health check';
      badge.style.background = 'rgba(240,168,48,0.1)';
      badge.style.color = '#f0a830';
      badge.style.display = 'inline-block';
      return;
    }
    // Full context with health check
    var conn = tbContext.activeConnection || {};
    var score = tbContext.healthCheck ? tbContext.healthCheck.score : null;
    var scoreStr = score !== null && score !== undefined ? ' · ' + score + '/100' : '';
    var ebsStr = conn.is_ebs ? ' · EBS' : '';
    badge.textContent = '● ' + (conn.name || 'Connection') + scoreStr + ebsStr;
    var scoreColor = score !== null ? (score >= 80 ? 'rgba(52,211,153,0.15)' : score >= 50 ? 'rgba(240,168,48,0.1)' : 'rgba(248,113,113,0.1)') : 'rgba(255,255,255,0.05)';
    badge.style.background = scoreColor;
    badge.style.color = score !== null ? (score >= 80 ? '#34d399' : score >= 50 ? '#f0a830' : '#f87171') : '#9090a8';
    badge.style.display = 'inline-block';
    renderConnSelector();
  }

  function renderConnSelector() {
    var sel = document.getElementById('tb-conn-select');
    if (!sel || !tbContext) return;
    var conns = tbContext.connections || [];
    if (conns.length <= 1) { sel.style.display = 'none'; return; }
    var activeId = tbContext.activeConnection ? tbContext.activeConnection.id : null;
    sel.innerHTML = conns.map(function(c) {
      return '<option value="' + c.id + '"' + (c.id === activeId ? ' selected' : '') + '>' + c.name + '</option>';
    }).join('');
    sel.style.display = 'block';
  }
  function tbSwitchConnection(connId) {
    tbContext = null;
    tbContextLoaded = false;
    fetchContext(parseInt(connId, 10));
  }
  function updateWelcomeForContext() {
    if (!tbContext) return;
    var welcomeEl = document.getElementById('tb-welcome');
    var suggestEl = document.getElementById('tb-suggestions');
    if (!welcomeEl) return;

    // Only update welcome if no conversation started yet
    if (conversationHistory.length > 0) return;

    if (tbContext.noConnections) {
      welcomeEl.innerHTML = [
        '<div style="font-size:13px;font-weight:600;color:#d0d0e8;margin-bottom:6px;letter-spacing:-0.3px;">Hi, I\'m TuneBot</div>',
        '<div style="font-size:12px;color:#50505e;line-height:1.6;">No connections found. Add an Oracle connection to get personalised guidance.</div>'
      ].join('');
      return;
    }

    if (tbContext.noHealthCheck) {
      var cname = tbContext.activeConnection ? tbContext.activeConnection.name : 'your connection';
      welcomeEl.innerHTML = [
        '<div style="font-size:13px;font-weight:600;color:#d0d0e8;margin-bottom:6px;letter-spacing:-0.3px;">Hi, I\'m TuneBot</div>',
        '<div style="font-size:12px;color:#50505e;line-height:1.6;">I can see <strong style="color:#9090b8;">' + escHtml(cname) + '</strong> but no health check has been run yet. Run a health check first and I\'ll give you personalised advice.</div>'
      ].join('');
      return;
    }

    // Full context
    var conn = tbContext.activeConnection || {};
    var hc = tbContext.healthCheck || {};
    var score = hc.score;
    var scoreColor = score !== null && score !== undefined ? (score >= 80 ? '#34d399' : score >= 50 ? '#f0a830' : '#f87171') : '#9090a8';
    var ticketCount = (tbContext.tickets || []).length;
    var critCount = ((hc.findings || []).filter(function (f) { return f.status === 'red'; })).length;

    welcomeEl.innerHTML = [
      '<div style="font-size:13px;font-weight:600;color:#d0d0e8;margin-bottom:6px;letter-spacing:-0.3px;">Hi, I\'m TuneBot</div>',
      '<div style="font-size:12px;color:#50505e;line-height:1.7;">',
        'I\'m looking at <strong style="color:#9090b8;">' + escHtml(conn.name || 'your connection') + '</strong>',
        score !== null && score !== undefined ? ' — health score <strong style="color:' + scoreColor + ';">' + score + '/100</strong>' : '',
        critCount > 0 ? ', <strong style="color:#f87171;">' + critCount + ' critical finding' + (critCount > 1 ? 's' : '') + '</strong>' : '',
        ticketCount > 0 ? ', ' + ticketCount + ' open ticket' + (ticketCount > 1 ? 's' : '') : '',
        '. Ask me anything.',
      '</div>'
    ].join('');

    // Swap suggestions for context-aware ones
    if (suggestEl) {
      var suggestions = conn.is_ebs ? CONTEXT_SUGGESTIONS : CONTEXT_SUGGESTIONS.filter(function (s) { return s.indexOf('EBS') === -1; });
      suggestEl.innerHTML = suggestions.map(function (s) {
        return '<button class="tb-suggestion" style="display:inline-block;padding:5px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;color:#9090a8;font-size:12px;cursor:pointer;transition:all 0.15s;font-family:inherit;white-space:nowrap;flex-shrink:0;letter-spacing:-0.1px;">' + escHtml(s) + '</button>';
      }).join('');
      wireSuggestions();
    }
  }

  function addUserBubble(text) {
    var welcome = document.getElementById('tb-welcome');
    var suggestions = document.getElementById('tb-suggestions');
    if (welcome) welcome.style.display = 'none';
    if (suggestions) suggestions.style.display = 'none';

    var messages = document.getElementById('tb-messages');
    var bubble = document.createElement('div');
    bubble.style.cssText = 'display:flex;justify-content:flex-end;';
    bubble.innerHTML = [
      '<div style="max-width:82%;background:rgba(240,168,48,0.12);border:1px solid rgba(240,168,48,0.2);',
        'border-radius:14px 14px 3px 14px;padding:9px 13px;font-size:13px;',
        'color:#e0e0f0;line-height:1.5;letter-spacing:-0.1px;">',
        escHtml(text),
      '</div>'
    ].join('');
    messages.appendChild(bubble);
    conversationHistory.push({ role: 'user', text: text });
    scrollMessages();
  }

  function addBotBubble(entry, question) {
    var messages = document.getElementById('tb-messages');

    // Remove any typing indicator
    var typingEl = document.getElementById('tb-typing');
    if (typingEl) typingEl.parentNode.removeChild(typingEl);

    var bubble = document.createElement('div');
    bubble.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:6px;';

    var answerHtml, feedbackKey;
    if (entry) {
      answerHtml = [
        '<div style="font-size:11px;font-weight:700;color:#f0a830;margin-bottom:7px;',
          'letter-spacing:0.5px;text-transform:uppercase;opacity:0.8;">',
          escHtml(entry.q),
        '</div>',
        '<div style="font-size:13px;color:#c8c8e0;line-height:1.65;letter-spacing:-0.1px;">',
          renderMarkdown(entry.a),
        '</div>'
      ].join('');
      feedbackKey = entry.q;
    } else {
      answerHtml = [
        '<div style="font-size:13px;color:#7070a0;line-height:1.65;">',
          'I don\'t have an answer for that yet.<br><br>',
          'Email <a href="mailto:support@tunevault.app" style="color:#f0a830;text-decoration:none;">support@tunevault.app</a> ',
          'for help, or try rephrasing — I cover setup, health checks, EBS, pricing, and troubleshooting.',
        '</div>'
      ].join('');
      feedbackKey = null;
    }

    var feedbackHtml = feedbackKey ? [
      '<div class="tb-feedback" style="display:flex;align-items:center;gap:8px;margin-top:4px;padding-left:34px;">',
        '<span style="font-size:10px;color:#333344;letter-spacing:0.2px;">Helpful?</span>',
        '<button class="tb-thumb" data-val="1" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);',
          'border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px;color:#9898a8;',
          'transition:all 0.15s;font-family:inherit;" ',
          'onmouseover="this.style.borderColor=\'#34d399\';this.style.color=\'#34d399\'" ',
          'onmouseout="this.style.borderColor=\'rgba(255,255,255,0.08)\';this.style.color=\'#9898a8\'">👍</button>',
        '<button class="tb-thumb" data-val="0" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);',
          'border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px;color:#9898a8;',
          'transition:all 0.15s;font-family:inherit;" ',
          'onmouseover="this.style.borderColor=\'#f87171\';this.style.color=\'#f87171\'" ',
          'onmouseout="this.style.borderColor=\'rgba(255,255,255,0.08)\';this.style.color=\'#9898a8\'">👎</button>',
      '</div>'
    ].join('') : '';

    // KB-mode header: shown when there is no active connection context so the user
    // knows the answer is generic (not pulled from their specific database health check).
    var hasRealContext = tbContext && !tbContext.noConnections && !tbContext.noHealthCheck;
    var kbModeHeaderHtml = !hasRealContext
      ? '<div style="font-size:10px;color:#6a4a20;margin-bottom:7px;letter-spacing:0.3px;' +
          'font-weight:600;background:rgba(240,120,40,0.08);border:1px solid rgba(240,120,40,0.2);' +
          'border-radius:6px;padding:4px 8px;display:inline-block;">' +
          '⚠️ Knowledge-base mode — no connection selected' +
        '</div><br>'
      : '';

    bubble.innerHTML = [
      '<div style="display:flex;align-items:flex-start;gap:8px;width:100%;">',
        '<div style="flex-shrink:0;margin-top:2px;" id="tb-bubble-icon">',
          buildMascotSVG(entry ? 'happy' : 'concerned', 28),
        '</div>',
        '<div style="flex:1;min-width:0;background:rgba(255,255,255,0.04);',
          'border:1px solid rgba(255,255,255,0.07);border-radius:3px 14px 14px 14px;',
          'padding:11px 13px;">',
          kbModeHeaderHtml,
          answerHtml,
        '</div>',
      '</div>',
      feedbackHtml
    ].join('');

    messages.appendChild(bubble);
    // Store as 'assistant' so KB answers feed back into AI conversation history
    conversationHistory.push({ role: 'assistant', text: entry ? (entry.q + '\n' + entry.a) : 'I don\'t have an answer for that in my knowledge base.' });
    scrollMessages();
    // TTS: speak the answer text if voice responses are on; otherwise clear voice badge
    if (entry) speakResponse(entry.a);
    else clearVoiceBadge();

    // Wire feedback
    if (feedbackKey) {
      var thumbBtns = bubble.querySelectorAll('.tb-thumb');
      var feedbackDiv = bubble.querySelector('.tb-feedback');
      thumbBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var val = parseInt(btn.getAttribute('data-val'), 10);
          trackFeedback(feedbackKey, val === 1);
          if (val === 1) {
            setExpression('celebrate', 'celebrate');
            setTimeout(function () {
              setExpression(expressionForScore(detectPageHealthScore()));
            }, 1200);
          }
          feedbackDiv.innerHTML = '<span style="font-size:11px;color:#34d399;padding-left:34px;">Thanks ✓</span>';
        });
      });
    }
  }

  // Build the connection identity + health-check timestamp header for context-aware replies.
  // Returns an HTML string or empty string if context is insufficient.
  function buildContextHeader() {
    if (!tbContext || tbContext.noConnections || tbContext.noHealthCheck) return '';
    var conn = tbContext.activeConnection || {};
    var hc = tbContext.healthCheck || {};
    var connName = escHtml(conn.name || 'Unknown');
    var hostStr = conn.host ? ' · host: ' + escHtml(conn.host) : '';
    var score = hc.score !== null && hc.score !== undefined ? hc.score + '/100' : 'N/A';
    var scoreColor = hc.score !== null && hc.score !== undefined
      ? (hc.score >= 80 ? '#34d399' : hc.score >= 50 ? '#f0a830' : '#f87171')
      : '#9090a8';

    // Format timestamp — prefer completedAt, fall back to createdAt
    var tsRaw = hc.completedAt || hc.createdAt || null;
    var tsStr = 'unknown';
    if (tsRaw) {
      try {
        var d = new Date(tsRaw);
        tsStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          + ' at '
          + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
      } catch (e) { tsStr = tsRaw; }
    }

    return [
      '<div style="margin-bottom:9px;padding:7px 10px;background:rgba(48,96,122,0.15);',
        'border:1px solid rgba(48,96,122,0.3);border-radius:8px;font-size:11px;line-height:1.7;',
        'color:#7ab4cc;letter-spacing:-0.1px;">',
        '<div>📊 <strong style="color:#9dcce0;">Connection:</strong> ' + connName + hostStr + '</div>',
        '<div>🕐 <strong style="color:#9dcce0;">Last health check:</strong> ' + escHtml(tsStr) + ' · Score: <strong style="color:' + scoreColor + ';">' + escHtml(score) + '</strong></div>',
      '</div>'
    ].join('');
  }

  // AI response bubble — full markdown, no KB title header, AI badge + context identity header
  function addAIBubble(text) {
    var messages = document.getElementById('tb-messages');
    var typingEl = document.getElementById('tb-typing');
    if (typingEl) typingEl.parentNode.removeChild(typingEl);

    var contextHeaderHtml = buildContextHeader();

    var bubble = document.createElement('div');
    bubble.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:6px;';
    bubble.innerHTML = [
      '<div style="display:flex;align-items:flex-start;gap:8px;width:100%;">',
        '<div style="flex-shrink:0;margin-top:2px;">',
          buildMascotSVG('happy', 28),
        '</div>',
        '<div style="flex:1;min-width:0;background:rgba(255,255,255,0.04);',
          'border:1px solid rgba(255,255,255,0.07);border-radius:3px 14px 14px 14px;',
          'padding:11px 13px;">',
          // AI source badge
          '<div style="font-size:10px;color:#30607a;margin-bottom:6px;letter-spacing:0.3px;font-weight:600;">AI · CONTEXT-AWARE</div>',
          // Connection identity + health check timestamp header
          contextHeaderHtml,
          '<div style="font-size:13px;color:#c8c8e0;line-height:1.65;letter-spacing:-0.1px;">',
            renderMarkdown(text),
          '</div>',
        '</div>',
      '</div>'
    ].join('');

    messages.appendChild(bubble);
    scrollMessages();
    // TTS: speak the AI reply if voice responses are on (speakResponse clears badge if off)
    speakResponse(text);
  }

  function scrollMessages() {
    var messages = document.getElementById('tb-messages');
    if (messages) {
      requestAnimationFrame(function () {
        messages.scrollTop = messages.scrollHeight;
      });
    }
  }

  // ── Panel open/close ────────────────────────────────────────────────────────
  var isMobileLayout = window.innerWidth < 768;

  function getPanelAnchor() {
    // Return the top/left position for the panel based on current FAB position.
    // Panel appears above the FAB on desktop.
    var fabEl = document.getElementById('tunebot-fab');
    if (!fabEl) return null;
    var fabRect = fabEl.getBoundingClientRect();
    var panelEl = document.getElementById('tunebot-panel');
    var panelH = panelEl ? (panelEl.offsetHeight || 560) : 560;
    var panelW = panelEl ? (panelEl.offsetWidth || 390) : 390;
    var vw = window.innerWidth;
    var margin = 8;
    // Prefer same left as FAB; shift left if it would overflow right edge
    var left = Math.min(fabRect.left, vw - panelW - margin);
    left = Math.max(margin, left);
    // Appear above FAB with a small gap
    var top = Math.max(margin, fabRect.top - panelH - 12);
    return { left: left, top: top };
  }

  function openPanel() {
    isOpen = true;
    var panel = document.getElementById('tunebot-panel');
    var label = document.getElementById('tunebot-fab-label');

    if (isMobileLayout) {
      // Mobile: slide up from bottom
      panel.style.transform = 'translateY(0)';
      panel.style.opacity = '1';
    } else {
      // Desktop: always re-anchor panel relative to the FAB's current position.
      // Previous code skipped this when tbWidgetPos was set, but that broke
      // after FAB-only drags (collapsed mode) where the panel was never moved.
      var anchor = getPanelAnchor();
      if (anchor) {
        panel.style.removeProperty('bottom');
        panel.style.removeProperty('right');
        panel.style.top = anchor.top + 'px';
        panel.style.left = anchor.left + 'px';
      }
      panel.style.transform = 'translateY(0) scale(1)';
      panel.style.opacity = '1';
    }
    panel.style.pointerEvents = 'auto';

    if (label) {
      label.textContent = '– Minimize';
      label.style.background = 'rgba(255,255,255,0.08)';
      label.style.color = '#a0a0b8';
    }

    // Sync panel mascot to current expression
    var panelMascot = document.getElementById('tb-panel-mascot');
    if (panelMascot) panelMascot.innerHTML = buildMascotSVG(currentExpression, 36);

    // Load context on first open, or re-fetch if the active connection changed
    var currentConnId = detectConnectionIdFromPage();
    var connChanged = tbContextLoaded && currentConnId && currentConnId !== tbContextConnId;
    if ((!tbContextLoaded && !tbContextLoading) || connChanged) {
      fetchContext(connChanged ? currentConnId : undefined);
    }

    setTimeout(function () {
      var input = document.getElementById('tb-input');
      if (input) input.focus();
    }, 280);
  }

  function closePanel() {
    // Minimize — panel hides, FAB remains visible
    isOpen = false;
    var panel = document.getElementById('tunebot-panel');
    var label = document.getElementById('tunebot-fab-label');
    if (isMobileLayout) {
      panel.style.transform = 'translateY(100%)';
      panel.style.opacity = '0';
    } else {
      panel.style.opacity = '0';
      panel.style.transform = 'translateY(20px) scale(0.95)';
    }
    panel.style.pointerEvents = 'none';
    if (label) {
      label.textContent = 'TuneBot';
      label.style.background = 'linear-gradient(135deg,#f0a830 0%,#e09820 100%)';
      label.style.color = '#0a0a0c';
    }
    startIdleGreeting();
  }

  function hideWidget() {
    // Completely remove the widget from view until next page load (no FAB either)
    isHidden = true;
    if (isOpen) closePanel();
    var fab = document.getElementById('tunebot-fab');
    var panel = document.getElementById('tunebot-panel');
    if (fab) {
      fab.style.opacity = '0';
      fab.style.pointerEvents = 'none';
      fab.style.transform = 'scale(0.5)';
      fab.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      setTimeout(function () { if (fab) fab.style.display = 'none'; }, 220);
    }
    if (panel) {
      panel.style.display = 'none';
    }
  }

  function togglePanel() {
    if (isHidden) return;
    if (isOpen) closePanel(); else openPanel();
  }

  // ── Health score observer: watch for DOM changes that update score ──────────
  // Pages that load score asynchronously — re-check after DOM settles
  function watchForScoreUpdates() {
    if (!window.MutationObserver) return;
    var checked = false;
    var observer = new MutationObserver(function () {
      if (checked) return;
      var score = detectPageHealthScore();
      if (score !== null) {
        checked = true;
        observer.disconnect();
        var newExpr = expressionForScore(score);
        // Only update if currently idle (don't interrupt active conversation expressions)
        if (currentExpression === 'idle' || currentExpression === 'wave') {
          setExpression(newExpr);
          if (score >= 80) setExpression('happy', 'celebrate');
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Stop observing after 15s to avoid performance overhead
    setTimeout(function () { observer.disconnect(); }, 15000);
  }

  // ── Public API: pages can call window.tuneBotSetScore(85) ──────────────────
  window.tuneBotSetScore = function (score) {
    var expr = expressionForScore(score);
    if (score >= 80 && currentExpression !== 'happy' && !isOpen) {
      setExpression('happy', 'celebrate');
    } else {
      setExpression(expr);
    }
  };

  // ── Voice Module ─────────────────────────────────────────────────────────────
  // Owns: mic button interaction, SpeechRecognition, SpeechSynthesisUtterance, state badge.
  // Does NOT own: chat submission, message bubbles, context fetching.

  // Detect iOS Safari — Web Speech input is unreliable there
  var isIOSSafari = (function () {
    var ua = navigator.userAgent;
    var isIOS = /iphone|ipad|ipod/i.test(ua);
    var isSafari = /safari/i.test(ua) && !/chrome/i.test(ua);
    return isIOS && isSafari;
  }());

  // SpeechRecognition constructor
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var voiceSupported = !isIOSSafari && !!SpeechRec;
  var ttsSupported = !!window.speechSynthesis;

  // Voice state
  var voiceState = 'idle'; // idle | listening | thinking | speaking
  var recognition = null;
  var silenceTimer = null;
  var currentUtterance = null;

  // TTS preference — persisted in localStorage.
  // Default: OFF until user explicitly uses mic once (don't surprise people).
  // After first mic use: ON by default.
  var voiceEnabled = (function () {
    try {
      var stored = localStorage.getItem('tvVoiceEnabled');
      if (stored === null) return false; // not yet set — will flip on after first mic use
      return stored === '1';
    } catch (e) { return false; }
  }());

  var micUsedOnce = (function () {
    try { return localStorage.getItem('tvMicUsed') === '1'; } catch (e) { return false; }
  }());

  // ── State badge helpers ───────────────────────────────────────────────────
  function setVoiceBadge(state) {
    // state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'
    voiceState = state;

    // ── Header speaking badge ────────────────────────────────────────────
    var headerBadge = document.getElementById('tb-header-speaking');
    if (headerBadge) {
      if (state === 'speaking') {
        headerBadge.style.display = 'inline-flex';
      } else {
        headerBadge.style.display = 'none';
      }
    }

    var badge = document.getElementById('tb-voice-badge');
    var textEl = document.getElementById('tb-voice-badge-text');
    var dot = badge ? badge.querySelector('.tb-badge-dot') : null;
    if (!badge || !textEl) return;

    // Always clean up thinking-specific classes
    badge.classList.remove('tb-badge-thinking');

    if (state === 'idle') {
      badge.classList.remove('tb-badge-visible');
      return;
    }

    if (state === 'thinking') {
      // Animated thinking dots instead of static "🤔 Thinking…"
      textEl.innerHTML = 'Thinking<span class="tb-think-dots"><span></span><span></span><span></span></span>';
      badge.classList.add('tb-badge-thinking');
      if (dot) dot.style.display = 'none';
    } else {
      var labels = {
        listening: '🎙\uFE0F Listening\u2026',
        speaking: '🔊 Speaking\u2026',
        error: '❌ '
      };
      textEl.textContent = labels[state] || state;
      // Dot only pulses during listening
      if (dot) dot.style.display = state === 'listening' ? 'inline-block' : 'none';
    }

    // Color: gold for listening/thinking, blue-ish for speaking, red for error
    var colors = { listening: '#f0a830', thinking: '#f0a830', speaking: '#60a5fa', error: '#f87171' };
    badge.style.color = colors[state] || '#f0a830';
    if (dot) dot.style.background = colors[state] || '#f0a830';

    badge.classList.add('tb-badge-visible');
  }

  function clearVoiceBadge() { setVoiceBadge('idle'); }

  // ── TTS toggle ───────────────────────────────────────────────────────────
  function setVoiceEnabled(on) {
    voiceEnabled = on;
    try { localStorage.setItem('tvVoiceEnabled', on ? '1' : '0'); } catch (e) {}
    var btn = document.getElementById('tb-voice-toggle');
    var icon = document.getElementById('tb-voice-icon');
    var label = document.getElementById('tb-voice-label');
    if (!btn) return;
    if (on) {
      btn.classList.add('tb-voice-on');
      btn.title = 'Voice responses on \u2014 click to mute';
      btn.style.background = 'rgba(240,168,48,0.14)';
      btn.style.borderColor = 'rgba(240,168,48,0.55)';
      btn.style.color = '#f0a830';
      if (icon) {
        // Full speaker icon
        icon.innerHTML = [
          '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>',
          '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
          '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
        ].join('');
        icon.style.color = '#f0a830';
      }
      if (label) label.textContent = 'Voice ON';
    } else {
      btn.classList.remove('tb-voice-on');
      btn.title = 'Voice responses off \u2014 click to enable';
      btn.style.background = 'rgba(255,255,255,0.04)';
      btn.style.borderColor = 'rgba(255,255,255,0.1)';
      btn.style.color = '#3d3d52';
      if (icon) {
        // Muted: speaker + X
        icon.innerHTML = [
          '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>',
          '<line x1="23" y1="9" x2="17" y2="15"/>',
          '<line x1="17" y1="9" x2="23" y2="15"/>'
        ].join('');
        icon.style.color = '#3d3d52';
      }
      if (label) label.textContent = 'Voice OFF';
    }
  }

  // ── TTS: speak response ──────────────────────────────────────────────────
  // Sanitize markdown to natural spoken English for SpeechSynthesis.
  // The full markdown still renders on screen — only the speech path is cleaned.
  function stripMarkdown(md) {
    var s = md;

    // Code blocks → skip entirely (user can read on screen)
    s = s.replace(/```[\s\S]*?```/g, ' see the code on screen. ');
    // Inline code → keep content, strip backticks
    s = s.replace(/`([^`]+)`/g, '$1');

    // Tables → replace with spoken summary instead of reading pipes
    // Match consecutive table rows (lines starting/ending with |)
    s = s.replace(/(?:^\|.+\|$\n?){2,}/gm, ' see the table on screen. ');
    // Single leftover pipe-rows or header separators
    s = s.replace(/^\|[-:\s|]+\|$/gm, '');
    s = s.replace(/^\|.+\|$/gm, '');

    // Horizontal rules: ---, ***, ___, ────, ═══, etc.
    s = s.replace(/^[\s]*([-*_]{3,}|[─━═]{3,})\s*$/gm, '. ');

    // Blockquotes: strip leading > markers
    s = s.replace(/^\s*>\s?/gm, '');

    // Headings: strip # markers, keep text
    s = s.replace(/^#{1,6}\s+/gm, '');

    // Bold/italic/underline markers: keep inner text
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/_([^_]+)_/g, '$1');
    s = s.replace(/~~([^~]+)~~/g, '$1');

    // Links: keep link text, drop URL
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Bullet markers (-, *, +) and numbered lists (1., 2.)
    s = s.replace(/^\s*[-*+]\s+/gm, '. ');
    s = s.replace(/^\s*\d+\.\s+/gm, '. ');

    // Emoji → remove entirely (SpeechSynthesis reads them as descriptions)
    // Covers most emoji ranges including supplementary plane
    s = s.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}]/gu, '');

    // HTML tags (rare but possible)
    s = s.replace(/<[^>]+>/g, '');
    // HTML entities
    s = s.replace(/&[a-z]+;/gi, ' ');
    s = s.replace(/&#\d+;/g, ' ');

    // Stray special characters that sound bad when spoken
    s = s.replace(/[|~^`]/g, ' ');

    // Collapse whitespace, normalize sentence boundaries
    s = s.replace(/\n{2,}/g, '. ');
    s = s.replace(/\n/g, ' ');
    s = s.replace(/\.{2,}/g, '.');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/\.\s*\./g, '.');
    return s.trim();
  }

  function speakResponse(text) {
    if (!ttsSupported || !voiceEnabled) { clearVoiceBadge(); return; }
    // Cancel any current speech
    window.speechSynthesis.cancel();
    if (currentUtterance) currentUtterance = null;

    var plain = stripMarkdown(text);
    if (!plain) return;

    // Truncate very long responses for speech (first ~400 chars)
    if (plain.length > 400) plain = plain.substring(0, 397) + '…';

    var utt = new window.SpeechSynthesisUtterance(plain);
    utt.lang = 'en-IN';
    utt.rate = 1.0;
    utt.pitch = 1.0;
    utt.volume = 1.0;

    utt.onstart = function () { setVoiceBadge('speaking'); };
    utt.onend = function () { clearVoiceBadge(); };
    utt.onerror = function () { clearVoiceBadge(); };

    currentUtterance = utt;
    setVoiceBadge('speaking');
    window.speechSynthesis.speak(utt);
  }

  function stopSpeaking() {
    if (ttsSupported) window.speechSynthesis.cancel();
    currentUtterance = null;
    clearVoiceBadge();
  }

  // ── Toast helper ─────────────────────────────────────────────────────────
  function showVoiceToast(msg, duration) {
    var existing = document.getElementById('tb-voice-toast');
    if (existing) existing.parentNode.removeChild(existing);
    var toast = document.createElement('div');
    toast.id = 'tb-voice-toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:100px', 'right:24px', 'z-index:9995',
      'background:rgba(30,30,40,0.95)', 'border:1px solid rgba(255,255,255,0.1)',
      'color:#d0d0e8', 'font-size:12px', 'font-family:"Space Grotesk",-apple-system,sans-serif',
      'border-radius:10px', 'padding:9px 14px', 'max-width:280px', 'line-height:1.5',
      'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
      'animation:tb-panel-in 0.25s ease forwards'
    ].join(';');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, duration || 4000);
  }

  // ── SpeechRecognition ─────────────────────────────────────────────────────
  function startListening() {
    if (!voiceSupported) return;

    // Stop any ongoing speech before listening
    stopSpeaking();

    if (recognition) {
      try { recognition.abort(); } catch (e) {}
      recognition = null;
    }

    try {
      recognition = new SpeechRec();
    } catch (e) {
      showVoiceToast('Voice input not available in this browser.');
      return;
    }

    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // Try en-IN first; browsers fall back to en-US on failure
    recognition.lang = 'en-IN';

    var input = document.getElementById('tb-input');
    var micBtn = document.getElementById('tb-mic');
    var lastFinalTranscript = '';

    recognition.onstart = function () {
      setVoiceBadge('listening');
      setStatus('Listening…', 'amber');
      setExpression('wave');
      if (micBtn) micBtn.classList.add('tb-mic-listening');

      // Auto-stop after 8s of no speech detected at all
      silenceTimer = setTimeout(function () {
        if (voiceState === 'listening') {
          // Stop recognition — onend will fire and handle the empty-transcript case
          try { recognition.stop(); } catch (e) {}
          if (!lastFinalTranscript) {
            showVoiceToast('Didn\'t catch that — try again?');
          }
        }
      }, 8000);
    };

    recognition.onresult = function (e) {
      // Reset silence timer on any result — auto-stop 1.5s after last detected speech
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(function () {
        if (voiceState === 'listening') {
          try { recognition.stop(); } catch (e) {} // triggers onend → auto-submit
        }
      }, 1500);

      var interim = '';
      var finalText = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalText += t;
        } else {
          interim += t;
        }
      }

      lastFinalTranscript = finalText || lastFinalTranscript;

      // Stream interim into input box so user sees transcription happening
      if (input) {
        input.value = (lastFinalTranscript + interim).trim();
        // Trigger input event to auto-resize textarea
        input.dispatchEvent(new Event('input'));
      }
    };

    recognition.onerror = function (e) {
      clearTimeout(silenceTimer);
      resetMicVisuals(); // clears badge + state; recognition is already stopped on error
      if (e.error === 'not-allowed' || e.error === 'permission-denied') {
        showVoiceToast('Microphone access blocked. Enable in browser settings to use voice.');
      } else if (e.error === 'no-speech') {
        showVoiceToast('Didn\'t catch that — try again?');
      } else if (e.error !== 'aborted') {
        showVoiceToast('Voice input error: ' + e.error + '. Try again.');
      }
    };

    recognition.onend = function () {
      clearTimeout(silenceTimer);
      var wasMicActive = voiceState === 'listening'; // check before reset
      // Visual reset (don't call stopListening to avoid double-stop)
      if (micBtn) micBtn.classList.remove('tb-mic-listening');
      setStatus('Ready to help', 'green');
      setExpression(expressionForScore(detectPageHealthScore()));
      voiceState = 'idle';

      // Auto-submit if we captured a transcript
      var input2 = document.getElementById('tb-input');
      var transcript = input2 ? input2.value.trim() : '';
      if (wasMicActive && transcript) {
        setVoiceBadge('thinking');
        submitQuestion();
      } else {
        clearVoiceBadge();
      }
    };

    try {
      recognition.start();
    } catch (e) {
      showVoiceToast('Could not start voice input. Is your microphone available?');
      recognition = null;
    }
  }

  // Visual reset for mic state — does NOT call recognition.stop().
  // Callers that want to stop recognition should call recognition.stop() directly (which fires onend).
  function resetMicVisuals() {
    clearTimeout(silenceTimer);
    voiceState = 'idle';
    var micBtn = document.getElementById('tb-mic');
    if (micBtn) micBtn.classList.remove('tb-mic-listening');
    setStatus('Ready to help', 'green');
    setExpression(expressionForScore(detectPageHealthScore()));
    clearVoiceBadge();
  }

  // ── First-open voice tooltip ──────────────────────────────────────────────
  // Shows once per session when panel opens + voice is ON + TTS supported
  var voiceTipShown = (function () {
    try { return localStorage.getItem('tvVoiceTipSeen') === '1'; } catch (e) { return false; }
  }());

  function maybeShowVoiceTip() {
    if (!ttsSupported || voiceTipShown || !voiceEnabled) return;
    voiceTipShown = true;
    try { localStorage.setItem('tvVoiceTipSeen', '1'); } catch (e) {}

    var toggle = document.getElementById('tb-voice-toggle');
    if (!toggle) return;
    var rect = toggle.getBoundingClientRect();

    var tip = document.createElement('div');
    tip.id = 'tb-voice-tip';
    tip.style.cssText = [
      'position:fixed',
      'z-index:9999',
      'background:rgba(20,20,32,0.97)',
      'border:1px solid rgba(240,168,48,0.45)',
      'border-radius:10px',
      'padding:9px 13px',
      'font-size:12px',
      'color:#d0d0e8',
      'line-height:1.5',
      'max-width:230px',
      'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
      'animation:tb-panel-in 0.25s ease forwards',
      'font-family:"Space Grotesk",-apple-system,sans-serif',
    ].join(';');
    // Position below the toggle button
    tip.style.top = (rect.bottom + 8) + 'px';
    tip.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';

    tip.innerHTML = '\uD83D\uDD0A TuneBot can also reply in voice. Click <strong style="color:#f0a830;">Voice ON</strong> to mute.';

    // Dismiss button
    var dismiss = document.createElement('div');
    dismiss.style.cssText = 'margin-top:6px;text-align:right;';
    dismiss.innerHTML = '<span style="font-size:10px;color:#9898a8;cursor:pointer;' +
      'text-decoration:underline;" id="tb-voice-tip-dismiss">Got it</span>';
    tip.appendChild(dismiss);
    document.body.appendChild(tip);

    function removeTip() {
      if (tip.parentNode) tip.parentNode.removeChild(tip);
    }
    var autoTimer = setTimeout(removeTip, 5000);
    var dismissEl = document.getElementById('tb-voice-tip-dismiss');
    if (dismissEl) dismissEl.addEventListener('click', function () {
      clearTimeout(autoTimer);
      removeTip();
    });
  }

  // ── Wire voice controls into panel ───────────────────────────────────────
  // Called after wirePanel() — attaches mic + voice toggle listeners
  function wireVoice() {
    var micBtn = document.getElementById('tb-mic');
    var voiceToggle = document.getElementById('tb-voice-toggle');
    var headerSpeakingBadge = document.getElementById('tb-header-speaking');

    // Wire header speaking badge: click stops TTS
    if (headerSpeakingBadge) {
      headerSpeakingBadge.addEventListener('click', function () {
        stopSpeaking();
      });
    }

    if (!voiceSupported) {
      // Browser doesn't support Web Speech API — hide mic, optionally show tooltip
      if (micBtn) {
        micBtn.style.display = 'none';
      }
      // Hide voice toggle only if TTS is also unsupported
      if (!ttsSupported && voiceToggle) voiceToggle.style.display = 'none';
      // If TTS is supported but mic isn't, still show the voice toggle
    }

    // Show mic button (only when voice input is supported)
    if (voiceSupported && micBtn) {
      micBtn.style.display = 'flex';
      micBtn.addEventListener('click', function () {
        if (voiceState === 'listening') {
          // Second click = stop; recognition.stop() will fire onend which resets badge
          if (recognition) {
            try { recognition.stop(); } catch (e) { resetMicVisuals(); }
          } else {
            resetMicVisuals();
          }
        } else {
          // Enable TTS default-ON after first mic use
          if (!micUsedOnce) {
            micUsedOnce = true;
            try { localStorage.setItem('tvMicUsed', '1'); } catch (e) {}
            if (!localStorage.getItem('tvVoiceEnabled')) {
              setVoiceEnabled(true);
            }
          }
          startListening();
        }
      });
    }

    // Show voice toggle (TTS on/off) — always visible when TTS is supported
    if (ttsSupported && voiceToggle) {
      voiceToggle.style.display = 'flex';
      setVoiceEnabled(voiceEnabled); // apply initial visual state

      voiceToggle.addEventListener('click', function () {
        setVoiceEnabled(!voiceEnabled);
        if (!voiceEnabled) stopSpeaking(); // stop if we just muted
      });

      // First-open tip: show after a short delay so panel has settled
      setTimeout(maybeShowVoiceTip, 600);
    }
  }

  // ── iOS Safari tooltip ───────────────────────────────────────────────────
  // Mic is hidden on iOS Safari; show an informational tooltip if user taps the area
  // (No action needed — mic is simply not rendered)

  // ── Intercept submitQuestion to set badge state ────────────────────────────
  // Wrap submitQuestion to set Thinking badge when voice is in use
  var _origSubmitQuestion = submitQuestion;
  submitQuestion = function () {
    if (voiceState === 'listening') {
      setVoiceBadge('thinking');
    }
    _origSubmitQuestion();
    // Reset voice badge to idle when response arrives via the addBotBubble/addAIBubble hooks
  };

  // ── Stop speaking when user starts typing ────────────────────────────────
  // Wired after DOM is ready in wireVoiceInputHooks()
  function wireVoiceInputHooks() {
    var inp = document.getElementById('tb-input');
    if (inp) {
      inp.addEventListener('input', function () {
        if (voiceState === 'speaking') stopSpeaking();
      });
    }
    // Reset badge once response is done (the addBotBubble/addAIBubble calls speakResponse
    // which sets badge=speaking then clears on end — no extra hook needed here)
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById('tunebot-fab')) return;
    var skip = ['/login', '/signup', '/signin', '/mfa-challenge', '/invite'];
    var path = location.pathname;
    for (var i = 0; i < skip.length; i++) {
      if (path.indexOf(skip[i]) === 0) return;
    }
    buildWidget();
    watchForScoreUpdates();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.tbRefreshContext = function(connectionId) { fetchContext(connectionId); };

})();
