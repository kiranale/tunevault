/**
 * lib/oracle/service-classifier.js — CDB/PDB-aware Oracle service classifier.
 *
 * Owns: classifying raw V$SERVICES + V$PDBS rows into annotated service objects
 *       with recommendation and blocked flags.
 * Does NOT own: executing SQL queries against Oracle, storing results, UI rendering.
 */

'use strict';

/**
 * Service classification types.
 * Order matters: higher priority classifications are preferred in recommendation.
 */
const CLASSIFICATIONS = {
  EBS_DEFAULT:   'EBS_DEFAULT',    // ebs_* service mapped to a READ WRITE PDB — best EBS target
  PDB_DEFAULT:   'PDB_DEFAULT',    // plain PDB service (short, non-ebs name) — good default
  EBS_PATCH_MODE:'EBS_PATCH_MODE', // *_ebs_patch suffix — ADOP cutover in flight, BLOCKED
  CDB_ROOT:      'CDB_ROOT',       // CON_ID=1 — container root, BLOCKED for EBS work
  XDB:           'XDB',            // *XDB suffix — XML DB endpoint, not useful for health checks
  BACKGROUND:    'BACKGROUND',     // SYS$* — Oracle internal, never user-facing
  OTHER:         'OTHER',          // anything else
};

/**
 * Classify a list of Oracle services into annotated service objects.
 *
 * @param {Array<{con_id: number, name: string, network_name: string}>} services
 *   Rows from SELECT con_id, name, network_name FROM V$SERVICES or V$ACTIVE_SERVICES
 * @param {Array<{con_id: number, name: string, open_mode: string}>} pdbs
 *   Rows from SELECT con_id, name, open_mode FROM V$PDBS (empty array if non-CDB)
 * @returns {Array<ServiceResult>} Classified services, sorted by recommendation (best first)
 */
function classifyServices(services, pdbs) {
  // Build a PDB lookup: con_id → { name, open_mode }
  const pdbMap = new Map();
  for (const pdb of (pdbs || [])) {
    pdbMap.set(Number(pdb.con_id), {
      name:      (pdb.name || '').toUpperCase(),
      open_mode: (pdb.open_mode || '').toUpperCase(),
    });
  }

  const results = [];

  for (const svc of (services || [])) {
    const conId       = Number(svc.con_id);
    const name        = (svc.name || '').trim();
    const networkName = (svc.network_name || svc.name || '').trim();
    const nameLower   = name.toLowerCase();

    // Resolve PDB info for this service
    const pdbInfo   = pdbMap.get(conId) || null;
    const pdbName   = pdbInfo ? pdbInfo.name : null;
    const openMode  = pdbInfo ? pdbInfo.open_mode : (conId === 1 ? 'CDB_ROOT' : null);

    const classification = _classify(nameLower, conId, pdbInfo);
    const { blocked, reason } = _blockRule(classification, nameLower);

    results.push({
      network_name:   networkName,
      name,
      con_id:         conId,
      pdb_name:       pdbName,
      open_mode:      openMode,
      classification,
      recommended:    false,  // set below
      blocked,
      reason,
    });
  }

  // Deduplicate by network_name (V$ACTIVE_SERVICES + V$SERVICES can overlap)
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.network_name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: EBS_DEFAULT > PDB_DEFAULT > OTHER > XDB > BACKGROUND > EBS_PATCH_MODE > CDB_ROOT
  const ORDER = [
    CLASSIFICATIONS.EBS_DEFAULT,
    CLASSIFICATIONS.PDB_DEFAULT,
    CLASSIFICATIONS.OTHER,
    CLASSIFICATIONS.XDB,
    CLASSIFICATIONS.BACKGROUND,
    CLASSIFICATIONS.EBS_PATCH_MODE,
    CLASSIFICATIONS.CDB_ROOT,
  ];
  deduped.sort((a, b) => {
    const ai = ORDER.indexOf(a.classification);
    const bi = ORDER.indexOf(b.classification);
    return ai - bi;
  });

  // Mark top non-blocked service as recommended
  const top = deduped.find(s => !s.blocked);
  if (top) top.recommended = true;

  return deduped;
}

/**
 * Determine classification for a single service.
 * @private
 */
function _classify(nameLower, conId, pdbInfo) {
  // SYS$* → background internal services
  if (nameLower.startsWith('sys$')) return CLASSIFICATIONS.BACKGROUND;

  // XDB suffix
  if (nameLower.endsWith('xdb')) return CLASSIFICATIONS.XDB;

  // ADOP patch-mode services: name ends with _ebs_patch
  if (nameLower.endsWith('_ebs_patch')) return CLASSIFICATIONS.EBS_PATCH_MODE;

  // CDB root (CON_ID = 1 is always CDB$ROOT in a CDB; in a non-CDB it's 0 or absent)
  if (conId === 1) return CLASSIFICATIONS.CDB_ROOT;

  // EBS default service: starts with ebs_ and maps to a READ WRITE PDB
  const openMode = pdbInfo ? pdbInfo.open_mode : '';
  if (nameLower.startsWith('ebs_') && openMode.includes('READ WRITE')) {
    return CLASSIFICATIONS.EBS_DEFAULT;
  }

  // PDB default: non-CDB, non-EBS, non-blocked, PDB with readable name
  if (conId > 1 && pdbInfo && openMode.includes('READ WRITE')) {
    return CLASSIFICATIONS.PDB_DEFAULT;
  }

  return CLASSIFICATIONS.OTHER;
}

/**
 * Determine if a service should be blocked and why.
 * @private
 */
function _blockRule(classification, nameLower) {
  if (classification === CLASSIFICATIONS.CDB_ROOT) {
    return {
      blocked: true,
      reason: 'CDB root has no application schemas (APPS, etc.). Health checks will fail silently. Connect to a PDB instead.',
    };
  }

  if (classification === CLASSIFICATIONS.EBS_PATCH_MODE) {
    return {
      blocked: true,
      reason: `ADOP patch cycle active (service name ends in _ebs_patch). Connecting here shows a frozen filesystem view. Wait for cutover to complete, then use the EBS_DEFAULT service.`,
    };
  }

  return { blocked: false, reason: null };
}

/**
 * Convenience: classify from raw proxy response rows.
 * Accepts the shape returned by the oracle-proxy V$SERVICES query.
 *
 * @param {object} raw — { services: [], pdbs: [] }
 * @returns {Array<ServiceResult>}
 */
function classifyFromProxy(raw) {
  const services = (raw && raw.services) ? raw.services : [];
  const pdbs     = (raw && raw.pdbs)     ? raw.pdbs     : [];
  return classifyServices(services, pdbs);
}

/**
 * Get a human-readable label for a classification.
 */
function classificationLabel(classification) {
  const labels = {
    [CLASSIFICATIONS.EBS_DEFAULT]:    'EBS Service',
    [CLASSIFICATIONS.PDB_DEFAULT]:    'PDB Service',
    [CLASSIFICATIONS.EBS_PATCH_MODE]: 'ADOP Patch Mode',
    [CLASSIFICATIONS.CDB_ROOT]:       'CDB Root',
    [CLASSIFICATIONS.XDB]:            'XDB',
    [CLASSIFICATIONS.BACKGROUND]:     'Background',
    [CLASSIFICATIONS.OTHER]:          'Other',
  };
  return labels[classification] || classification;
}

/**
 * Get the CSS color key for a classification (matches frontend badge classes).
 */
function classificationColor(classification) {
  const colors = {
    [CLASSIFICATIONS.EBS_DEFAULT]:    'green',
    [CLASSIFICATIONS.PDB_DEFAULT]:    'blue',
    [CLASSIFICATIONS.EBS_PATCH_MODE]: 'red',
    [CLASSIFICATIONS.CDB_ROOT]:       'red',
    [CLASSIFICATIONS.XDB]:            'grey',
    [CLASSIFICATIONS.BACKGROUND]:     'grey',
    [CLASSIFICATIONS.OTHER]:          'grey',
  };
  return colors[classification] || 'grey';
}

module.exports = {
  classifyServices,
  classifyFromProxy,
  classificationLabel,
  classificationColor,
  CLASSIFICATIONS,
};
