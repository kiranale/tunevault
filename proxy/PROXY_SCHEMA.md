# TuneVault Oracle Proxy — JSON Payload Schema

`oracle-proxy.py` v3.2.1+

## HTTP Contract

**Endpoint:** `POST /api/healthcheck`
**Auth:** `X-API-Key: <TUNEVAULT_API_KEY>`
**Request body:**

```json
{
  "service_name": "ORCL",
  "username": "SYSTEM",
  "password": "...",
  "host": "localhost",
  "port": 1521
}
```

**Response envelope:**

```json
{
  "success": true,
  "metrics": { ... }   // see schema below
}
```

Error response: `{ "success": false, "error": "message" }`

---

## Top-Level `metrics` Keys

| Key | Type | Description |
|-----|------|-------------|
| `instance` | object | `v$instance` — db_name, version, status, uptime_days |
| `tablespaces` | array | Tablespace name, used_pct, status |
| `wait_events` | array | Top wait events from `v$system_event` |
| `top_sql` | array | Top SQL by elapsed time (v$sql) |
| `index_analysis` | array | Unusable/bloated index findings |
| `sga_stats` | object | SGA component sizes |
| `pga_stats` | object | PGA aggregate stats |
| `redo_stats` | object | Redo log sizing + switch rate |
| `os_stats` | object | OS CPU/memory (if available) |
| `undo_stats` | object | Undo retention + usage |
| `temp_stats` | object | Temp segment usage |
| `alert_log` | object | Recent ORA- errors from alert log |
| `resource_limits` | object | `v$resource_limit` near-limit items |
| `sga_pga_history` | array | Historical SGA/PGA snapshots |
| `backup_stats` | object | RMAN backup status |
| `ebs_detected` | boolean | **Bug 1 fix** — true when APPS schema probes succeed |
| `ebs_operations` | object\|null | **Bug 1 fix** — EBS check data; null when `ebs_detected=false` |
| `apps_health` | object\|null | Raw proxy EBS data (diagnostics only; not consumed by server checks) |
| `ebs_probe_error` | string\|null | **Bug 5** — non-null when APPS schema reached but FND grants missing |
| `db_objects` | object | Invalid objects, recyclebin |
| `session_stats` | object | Active sessions, blocked sessions |
| `security_stats` | object | Profile, audit, role findings |
| `schema_stats` | object | Schema object counts |
| `proxy_version` | string | Proxy version (e.g. `"3.2.1"`) |
| `snapshot_info` | object | Logical AWR snapshot window (proxy-synthetic) |
| `query_errors` | array | Non-fatal query failures (optional; omitted when empty) |

---

## `ebs_operations` Structure

Only present when `ebs_detected = true`.

```json
{
  "concurrent_managers": {
    "cm01": { "name": "Internal Manager", "max_processes": 1, "running_processes": 1, "control_code": "", "status": "ok" },
    "cm02": { "pending_requests": 18 },
    "cm03": { "name": "Output Post Processor", "max_processes": 2, "running_processes": 2, "status": "ok", "recommendation": "..." },
    "cm05": { "completed_24h": 3842, "avg_runtime_secs": 14.3 },
    "cm06": [ { "name": "Standard Manager", "max_processes": 10, "running_processes": 8, "target_processes": 10 } ],
    "cm09": [],
    "cm10": null
  },
  "workflow": {
    "wf01": [],
    "wf02": { "error_count": 23 },
    "wf03": { "mailer_running": true, "status": "RUNNING", "startup_mode": "AUTOMATIC", "deferred_ready": 0 },
    "wf07": [],
    "wf08": { "pending_over_2h": 87, "pending_over_8h": 31 },
    "wf09": [
      { "name": "Workflow Agent Listener", "status": "RUNNING", "startup_mode": "AUTOMATIC", "enabled": true }
    ],
    "status": "ok",
    "mailer_running": true
  },
  "security": {
    "sc12": { "signon_audit_level": "FORM", "audit_enabled": true },
    "sc14": [ { "user_name": "SYSADMIN", "responsibility": "System Administrator" } ]
  },
  "functional": {
    "fb01": [],
    "fb03": { "pending_over_7d": 14 },
    "fb04": { "active_users_24h": 312 }
  },
  "observability": { "ot05": null },
  "config_drift": { "cd07": null },
  "_adop_status": {
    "check_id": "ADOP_STATUS",
    "status": "ok",
    "severity": "info",
    "message": "No active ADOP sessions.",
    "sessions": [],
    "active_sessions": 0,
    "failed_sessions": 0
  },
  "_apps_env": {},
  "_overall_status": "ok"
}
```

---

## EBS Detection Probe Chain (Bug 2 fix)

The proxy runs up to 4 probes in order. Any success → `ebs_detected = true`. All fail → non-EBS.

| Step | Query | Rationale |
|------|-------|-----------|
| 1 | `SELECT RELEASE_NAME FROM APPS.FND_PRODUCT_GROUPS WHERE ROWNUM=1` | Canonical EBS sentinel; most reliable |
| 2 | `SELECT 1 FROM APPS.FND_CONCURRENT_QUEUES WHERE ROWNUM=1` | Present on all running EBS instances |
| 3 | `SELECT 1 FROM APPS.FND_PRODUCT_INSTALLATIONS WHERE ROWNUM=1` | Present on all EBS 11i/12.x installs |
| 4 | `SELECT 1 FROM ALL_TABLES WHERE OWNER='APPS' AND ROWNUM=1` | Schema-level probe; no FND grants needed |

Non-ORA-942 errors on step 1 (schema unreachable) → immediately return `(False, None)`.

---

## check_id Reference (EBS `check_results` rows)

| check_id | Source key | Description |
|----------|-----------|-------------|
| `EBS_CM01_INTERNAL_MANAGER` | `ebs_operations.concurrent_managers.cm01` | ICM up/down |
| `EBS_CM02_PENDING_REQUESTS` | `cm02` | Standard Manager queue depth |
| `EBS_CM03_OPP_STATUS` | `cm03` | Output Post Processor (Bug 3) |
| `EBS_CM05_REQUEST_RUNTIME` | `cm05` | Avg concurrent request runtime |
| `EBS_CM10_ERROR_REQUESTS` | `cm10` | Error requests last 24h |
| `EBS_WF02_WORKFLOW_ERRORS` | `wf02` | WF items in ERROR state |
| `EBS_WF03_DEFERRED_QUEUE` | `wf03.deferred_ready` | Deferred WF queue depth |
| `EBS_WF08_NOTIFICATION_BACKLOG` | `wf08` | Stuck notifications |
| `EBS_WF09_SERVICE_COMPONENTS` | `wf09` | Workflow Agent Listener / Mailer (Bug 5) |
| `EBS_ADOP_SESSIONS` | `_adop_status` | Active/failed ADOP patching cycles (Bug 5) |
| `EBS_SC12_SIGNON_AUDIT` | `security.sc12` | Sign-on audit level |
| `EBS_SC14_SYSADMIN_USERS` | `security.sc14` | SYSADMIN responsibility count |
| `EBS_FB03_NOTIFICATION_AGING` | `functional.fb03` | WF notifications >7d |
| `EBS_FB04_ACTIVE_USERS` | `functional.fb04` | Active EBS users 24h |
