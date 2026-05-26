/**
 * adop-banner.js — ADOP patch-cycle red banner + op-gating client.
 *
 * Drop-in script for any page that wants to surface the ADOP alert.
 *
 * Usage:
 *   <script src="/adop-banner.js"></script>
 *   AdopBanner.init({ connectionId: 42 });      // per-connection page
 *   AdopBanner.init({ fleet: true });            // fleet / connections list
 *   AdopBanner.refresh();                        // manual re-check
 *   AdopBanner.checkOp(connId, opKey)            // → Promise<{blocked,reason,...}>
 *   AdopBanner.onPatching(cb)                    // subscribe to state changes
 */
(function (window) {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let _state = {
    patching: false,
    phase: null,
    session_id: null,
    started_at: null,
    services_in_patch_mode: [],
    banner_message: '',
    checked_at: null,
    fleet_patching_count: 0,
  };
  let _listeners = [];
  let _pollTimer = null;
  let _config = {};
  const POLL_MS = 60_000; // 1 minute

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initialize the banner.
   * @param {object} opts
   *   opts.connectionId  — single connection ID (ebs-deep, ebs-ops, connection detail)
   *   opts.fleet         — true for connections list / fleet page (polls all connections)
   *   opts.bannerId      — DOM ID to inject banner into (default: 'adopBannerRoot')
   *   opts.mountBefore   — CSS selector: insert banner before this element
   */
  function init(opts) {
    _config = opts || {};
    _ensureBannerDom();
    refresh();
    _pollTimer = setInterval(refresh, POLL_MS);
  }

  /**
   * Manually re-check (e.g. after connection selector changes).
   */
  function refresh() {
    const connId = _config.connectionId;
    if (connId) {
      _fetchConnectionState(connId);
    } else if (_config.fleet) {
      _fetchFleetState();
    }
  }

  /**
   * Subscribe to patching state changes.
   * @param {Function} cb  called with (state) whenever patching changes
   */
  function onPatching(cb) {
    _listeners.push(cb);
  }

  /**
   * Check if an op should be blocked.
   * @param {number} connectionId
   * @param {string} opKey
   * @param {string} [adopSessionId]  — override: type the ADOP session ID
   * @returns {Promise<{blocked:boolean, reason?:string, override_hint?:string}>}
   */
  async function checkOp(connectionId, opKey, adopSessionId) {
    try {
      const resp = await fetch('/api/adop-state/check-op', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId, op_key: opKey, adop_session_id: adopSessionId || null }),
      });
      if (!resp.ok) return { blocked: false };
      return await resp.json();
    } catch (_) {
      return { blocked: false };
    }
  }

  /**
   * Destroy the banner and stop polling.
   */
  function destroy() {
    if (_pollTimer) clearInterval(_pollTimer);
    const el = document.getElementById(_bannerId());
    if (el) el.remove();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  function _bannerId() {
    return _config.bannerId || 'adopBannerRoot';
  }

  function _ensureBannerDom() {
    if (document.getElementById(_bannerId())) return;
    const div = document.createElement('div');
    div.id = _bannerId();
    div.setAttribute('aria-live', 'polite');

    // Inject before a target element, or prepend to page-wrapper, or prepend to body
    const target = _config.mountBefore
      ? document.querySelector(_config.mountBefore)
      : (document.querySelector('.page-wrapper') || document.body);
    if (target) {
      target.insertBefore(div, target.firstChild);
    }
  }

  async function _fetchConnectionState(connectionId) {
    try {
      const resp = await fetch(`/api/connections/${connectionId}/adop-state`, {
        credentials: 'include',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      _applyState({
        patching:               data.patching || false,
        phase:                  data.phase || null,
        session_id:             data.session_id || null,
        started_at:             data.started_at || null,
        services_in_patch_mode: data.services_in_patch_mode || [],
        banner_message:         data.banner_message || '',
        checked_at:             data.checked_at || null,
        fleet_patching_count:   0,
      });
    } catch (_) { /* silently ignore */ }
  }

  async function _fetchFleetState() {
    try {
      const resp = await fetch('/api/adop-state/fleet', { credentials: 'include' });
      if (!resp.ok) return;
      const data = await resp.json();
      const patchingConns = (data.states || []).filter(s => s.patching);
      if (patchingConns.length === 0) {
        _applyState({ patching: false, phase: null, session_id: null, started_at: null,
          services_in_patch_mode: [], banner_message: '', checked_at: null,
          fleet_patching_count: 0 });
        return;
      }
      // Surface the most alarming (cutover > apply > prepare > unknown)
      const PHASE_RANK = { cutover: 5, cleanup: 4, apply: 3, finalize: 2, prepare: 1, abort: 0 };
      patchingConns.sort((a, b) => (PHASE_RANK[b.phase] || 0) - (PHASE_RANK[a.phase] || 0));
      const top = patchingConns[0];
      const count = patchingConns.length;
      const plural = count > 1 ? ` (${count} connections in patch mode)` : '';
      _applyState({
        patching:               true,
        phase:                  top.phase,
        session_id:             top.session_id,
        started_at:             top.started_at,
        services_in_patch_mode: top.services_in_patch_mode || [],
        banner_message:         top.banner_message + plural,
        checked_at:             top.checked_at,
        fleet_patching_count:   count,
      });
    } catch (_) { /* silently ignore */ }
  }

  function _applyState(newState) {
    const changed = newState.patching !== _state.patching || newState.phase !== _state.phase;
    _state = newState;
    _renderBanner();
    if (changed) {
      _listeners.forEach(cb => { try { cb(_state); } catch (_) {} });
    }
  }

  function _renderBanner() {
    const root = document.getElementById(_bannerId());
    if (!root) return;

    if (!_state.patching) {
      root.innerHTML = '';
      root.style.display = 'none';
      return;
    }

    root.style.display = '';
    const phaseLabel = _state.phase ? _state.phase.toUpperCase() : 'UNKNOWN PHASE';
    const sessionPart = _state.session_id ? ` &bull; Session ${_state.session_id}` : '';
    const msg = _state.banner_message || `ADOP patch cycle in progress — ${phaseLabel}.`;

    root.innerHTML = `
      <div id="adopBanner" style="
        background: linear-gradient(90deg, rgba(220,38,38,0.18) 0%, rgba(185,28,28,0.12) 100%);
        border: 1.5px solid rgba(248,113,113,0.45);
        border-radius: 10px;
        padding: 14px 20px;
        margin: 0 0 20px;
        display: flex;
        align-items: flex-start;
        gap: 14px;
      ">
        <span style="font-size:20px;flex-shrink:0;margin-top:1px;">🔴</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;color:#fca5a5;font-size:14px;margin-bottom:4px;">
            ADOP Patch Cycle Active${sessionPart}
          </div>
          <div style="color:#fecaca;font-size:13px;line-height:1.5;">
            ${_escapeHtml(msg)}
            &nbsp;<a href="/docs/adop-during-patching" target="_blank" rel="noopener"
              style="color:#fca5a5;text-decoration:underline;font-size:12px;">What this means</a>
          </div>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            <span style="
              background:rgba(248,113,113,0.18);border:1px solid rgba(248,113,113,0.35);
              border-radius:6px;padding:3px 10px;font-size:11px;color:#fca5a5;font-weight:600;
            ">Phase: ${phaseLabel}</span>
            ${_state.services_in_patch_mode.length > 0 ? `
            <span style="
              background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.25);
              border-radius:6px;padding:3px 10px;font-size:11px;color:#fca5a5;
            ">${_state.services_in_patch_mode.join(', ')}</span>` : ''}
          </div>
        </div>
        <button onclick="AdopBanner.refresh()" style="
          background:transparent;border:1px solid rgba(248,113,113,0.4);border-radius:6px;
          color:#fca5a5;font-size:11px;padding:4px 10px;cursor:pointer;white-space:nowrap;flex-shrink:0;
        " title="Re-check ADOP state">↻ Refresh</button>
      </div>`;
  }

  function _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Export ────────────────────────────────────────────────────────────────
  window.AdopBanner = { init, refresh, onPatching, checkOp, destroy, getState: () => _state };

})(window);
