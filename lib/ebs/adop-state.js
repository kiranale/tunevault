/**
 * lib/ebs/adop-state.js — ADOP (AD Online Patching) state detector.
 *
 * Owns: probing V$ACTIVE_SERVICES + AD_ADOP_SESSIONS to determine if an ADOP
 *       patch cycle is currently in flight, returning a structured state object.
 * Does NOT own: executing Oracle queries (caller provides queryFn), persisting
 *               state (db/ebs-adop-state.js), or rendering UI (routes/adop-state.js).
 */

'use strict';

/**
 * SQL: check V$ACTIVE_SERVICES for any _ebs_patch service name.
 * Works regardless of whether APPS access is available.
 */
const SQL_ACTIVE_PATCH_SERVICES = `
  SELECT name, network_name
  FROM   V$ACTIVE_SERVICES
  WHERE  LOWER(name) LIKE '%_ebs_patch'
  ORDER  BY name
`;

/**
 * SQL: pull ADOP session detail from AD_ADOP_SESSIONS.
 * Requires APPS schema visibility (or SELECT_CATALOG_ROLE on the view).
 * Falls back gracefully when unavailable.
 */
const SQL_ADOP_SESSION = `
  SELECT
    s.adop_session_id,
    s.status,
    s.prepare_date,
    s.apply_date,
    s.finalize_date,
    s.cutover_date,
    s.cleanup_date,
    s.abandon_date,
    s.node_name,
    (SELECT MAX(sp.patch_series)
     FROM   AD_ADOP_SESSION_PATCHES sp
     WHERE  sp.adop_session_id = s.adop_session_id
     AND    ROWNUM = 1) AS latest_patch
  FROM   AD_ADOP_SESSIONS s
  WHERE  s.status NOT IN ('completed', 'abandoned')
  ORDER  BY s.adop_session_id DESC
  FETCH  FIRST 1 ROWS ONLY
`;

/** Phase ordering — last non-null phase is the "current" phase. */
const PHASE_FIELDS = [
  { field: 'prepare_date',  phase: 'prepare'  },
  { field: 'apply_date',    phase: 'apply'    },
  { field: 'finalize_date', phase: 'finalize' },
  { field: 'cutover_date',  phase: 'cutover'  },
  { field: 'cleanup_date',  phase: 'cleanup'  },
  { field: 'abandon_date',  phase: 'abort'    },
];

/**
 * detectAdopState(queryFn) — main entry point.
 *
 * @param {Function} queryFn   async (sql, params?) => { rows: [] }
 *                             Caller wires this to their Oracle connection.
 * @returns {Promise<AdopState>}
 *
 * AdopState shape:
 * {
 *   patching: boolean,
 *   phase: string|null,         // 'prepare'|'apply'|'finalize'|'cutover'|'cleanup'|'abort'|null
 *   session_id: number|null,
 *   started_at: Date|null,      // prepare_date of the active session
 *   services_in_patch_mode: string[],
 *   source: 'vactive_services+adop_sessions'|'vactive_services_only',
 *   checked_at: Date,
 * }
 */
async function detectAdopState(queryFn) {
  const checkedAt = new Date();

  // ── Step 1: probe V$ACTIVE_SERVICES (always available, no APPS needed) ──────
  let servicesInPatchMode = [];
  try {
    const result = await queryFn(SQL_ACTIVE_PATCH_SERVICES, []);
    servicesInPatchMode = (result.rows || []).map(r => r.name || r.NAME || '').filter(Boolean);
  } catch (err) {
    // V$ACTIVE_SERVICES query failed — system-level access issue, treat as not patching
    return _notPatching(checkedAt, 'error:vactive_services_unavailable');
  }

  if (servicesInPatchMode.length === 0) {
    return _notPatching(checkedAt, 'vactive_services_only');
  }

  // ── Step 2: try to enrich from AD_ADOP_SESSIONS ───────────────────────────
  let sessionRow = null;
  let source = 'vactive_services_only';
  try {
    const result = await queryFn(SQL_ADOP_SESSION, []);
    sessionRow = (result.rows && result.rows[0]) ? result.rows[0] : null;
    if (sessionRow) source = 'vactive_services+adop_sessions';
  } catch (_) {
    // AD_ADOP_SESSIONS not accessible — fall back to service-name-only inference
    source = 'vactive_services_only';
  }

  if (!sessionRow) {
    // Services confirm patching but ADOP views aren't accessible (non-APPS connect)
    return {
      patching:               true,
      phase:                  null,
      session_id:             null,
      started_at:             null,
      services_in_patch_mode: servicesInPatchMode,
      source,
      checked_at:             checkedAt,
    };
  }

  // ── Step 3: derive current phase from which date columns are populated ──────
  const phase = _derivePhase(sessionRow);

  return {
    patching:               true,
    phase,
    session_id:             sessionRow.adop_session_id ?? sessionRow.ADOP_SESSION_ID ?? null,
    started_at:             sessionRow.prepare_date ?? sessionRow.PREPARE_DATE ?? null,
    services_in_patch_mode: servicesInPatchMode,
    source,
    checked_at:             checkedAt,
  };
}

/**
 * Derive the "most advanced" phase reached in this session.
 * The last non-null date in PHASE_FIELDS order is the current phase.
 */
function _derivePhase(row) {
  let lastPhase = null;
  for (const { field, phase } of PHASE_FIELDS) {
    // Oracle driver may return snake_case or UPPER_CASE keys depending on config
    const val = row[field] ?? row[field.toUpperCase()];
    if (val !== null && val !== undefined) {
      lastPhase = phase;
    }
  }
  return lastPhase;
}

/** Convenience: return a "not patching" state object. */
function _notPatching(checkedAt, source) {
  return {
    patching:               false,
    phase:                  null,
    session_id:             null,
    started_at:             null,
    services_in_patch_mode: [],
    source,
    checked_at:             checkedAt,
  };
}

/**
 * Format a human-readable banner message from an AdopState object.
 *
 * @param {AdopState} state
 * @returns {string}
 */
function formatBannerMessage(state) {
  if (!state.patching) return '';

  const phasePart = state.phase
    ? `phase: ${state.phase.toUpperCase()}`
    : 'phase unknown';

  let agoPart = '';
  if (state.started_at) {
    const ms = Date.now() - new Date(state.started_at).getTime();
    const hours = Math.floor(ms / 3_600_000);
    const mins  = Math.floor((ms % 3_600_000) / 60_000);
    agoPart = hours > 0
      ? `, started ${hours}h ${mins}m ago`
      : `, started ${mins}m ago`;
  }

  const sessionPart = state.session_id ? ` (session ${state.session_id})` : '';

  return `ADOP patch cycle in progress — ${phasePart}${agoPart}${sessionPart}. ` +
    `Health metrics reflect the patch edition, not production.`;
}

/**
 * Returns true if the given DB Ops / EBS Ops action key should be blocked.
 * Called by route handlers to gate destructive ops when patching is active.
 *
 * @param {string}   opKey   e.g. 'bounce_cm', 'kill_session', 'restart_wf_mailer'
 * @returns {boolean}
 */
const BLOCKED_OPS = new Set([
  // Concurrent Manager
  'bounce_cm',
  'start_cm',
  'stop_cm',
  'restart_cm',
  // Workflow
  'restart_wf_mailer',
  'wf_mailer_start',
  'wf_mailer_stop',
  // Sessions
  'kill_session',
  'kill_blocking_session',
  // DB parameter changes
  'set_parameter',
  'alter_parameter',
  // EBS control
  'cm_bounce',
  'cm_start',
  'cm_stop',
  'apps_password_reset',
  'wf_notification_mailer',
  // Rolling bounces
  'rolling_bounce',
  'wls_bounce',
  'apache_restart',
]);

function isOpBlockedDuringAdop(opKey) {
  if (!opKey) return false;
  const key = opKey.toLowerCase().replace(/[-\s]/g, '_');
  return BLOCKED_OPS.has(key);
}

module.exports = {
  detectAdopState,
  formatBannerMessage,
  isOpBlockedDuringAdop,
  BLOCKED_OPS,
  // SQL exported for tests
  SQL_ACTIVE_PATCH_SERVICES,
  SQL_ADOP_SESSION,
};
