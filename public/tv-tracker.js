/**
 * tv-tracker.js — lightweight client-side event tracker.
 *
 * Usage: include <script src="/tv-tracker.js"></script> in any public page.
 * Automatically fires page_view on load with UTM params and session ID.
 * Exposes window.tvTrack(eventName, properties) for manual events.
 *
 * Uses /api/ec (ad-blocker-safe path) for funnel events.
 * Uses /api/events for landing page CTA click tracking (data-track attributes).
 * Sets tv_sid cookie so server can correlate anonymous sessions.
 * Captures UTM params on first visit; persists via localStorage.
 */
(function () {
  'use strict';

  var EC_ENDPOINT  = '/api/ec';
  var EVENTS_ENDPOINT = '/api/events';
  var SESSION_KEY  = 'tv_sid';
  var UTM_KEY      = 'tv_utm';
  var SESSION_COOKIE_DAYS = 30;

  // ── Session ID ────────────────────────────────────────────────────────────
  // Generate or read a random session ID; persist in localStorage + cookie
  // so the server can correlate anonymous events without auth.
  function getOrCreateSession() {
    var sid = null;
    try { sid = localStorage.getItem(SESSION_KEY); } catch (e) {}
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      try { localStorage.setItem(SESSION_KEY, sid); } catch (e) {}
    }
    // Sync to cookie so server-side req.cookies.tv_sid works
    var expires = new Date(Date.now() + SESSION_COOKIE_DAYS * 86400000).toUTCString();
    document.cookie = SESSION_KEY + '=' + sid + '; path=/; expires=' + expires + '; SameSite=Lax';
    return sid;
  }

  // ── UTM Capture ───────────────────────────────────────────────────────────
  // Capture UTM params on first visit (when present in URL) and persist them
  // for the session so subsequent pages report attribution correctly.
  function captureUtm() {
    try {
      var search = location.search;
      if (search) {
        var params = {};
        search.slice(1).split('&').forEach(function (part) {
          var kv = part.split('=');
          var k = decodeURIComponent(kv[0] || '');
          var v = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
          if (k.indexOf('utm_') === 0 || k === 'ref' || k === 'gclid' || k === 'fbclid') {
            params[k] = v;
          }
        });
        if (Object.keys(params).length > 0) {
          try { localStorage.setItem(UTM_KEY, JSON.stringify(params)); } catch (e) {}
          return params;
        }
      }
      // Fall back to stored UTMs from a previous page on this session
      try {
        var raw = localStorage.getItem(UTM_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) { return {}; }
    } catch (e) { return {}; }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  var utm = captureUtm();
  getOrCreateSession(); // Sets cookie; return value unused (cookie is authoritative)

  // ── Event send ────────────────────────────────────────────────────────────
  function send(event, extra) {
    try {
      var body = {
        event: event,
        page_path: location.pathname,
        referrer: document.referrer || null,
      };
      // Merge caller-supplied properties
      var props = (extra && extra.properties) ? Object.assign({}, extra.properties) : {};
      // Attach UTM params on page_view so first-visit attribution is recorded
      if (event === 'page_view' && Object.keys(utm).length > 0) {
        Object.assign(props, utm);
      }
      if (Object.keys(props).length > 0) body.properties = props;
      // Copy any extra top-level keys (e.g. plan, check_id) directly onto body
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          if (k !== 'properties') body[k] = extra[k];
        });
      }
      // navigator.sendBeacon survives page unload; fetch is the fallback
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(EC_ENDPOINT, blob);
      } else {
        fetch(EC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* never throw */ }
  }

  // ── Auto-fire: page_view (with UTM if present) ────────────────────────────
  send('page_view');

  // ── Auto-fire: signup_started ─────────────────────────────────────────────
  if (location.pathname === '/login' || location.pathname === '/signup' || location.pathname === '/signin') {
    send('signup_started');
  }

  // ── Delegate click handler: ai_analysis_viewed + cta_click ────────────────
  document.addEventListener('click', function (e) {
    var target = e.target;
    for (var i = 0; i < 3; i++) {
      if (!target || !target.getAttribute) break;

      // AI Summary tab click
      if (target.getAttribute('data-tab') === 'ai-summary' ||
          target.getAttribute('data-tab') === 'summary') {
        send('ai_analysis_viewed');
        break;
      }

      // CTA clicks — any element with data-cta-id attribute
      // Wire CTAs by adding data-cta-id="hero-demo" etc. in HTML
      var ctaId = target.getAttribute('data-cta-id');
      if (ctaId) {
        send('cta_click', { properties: { cta_id: ctaId } });
        break;
      }

      // Landing page CTA tracking — data-track attribute → /api/events (page_events)
      var trackName = target.getAttribute('data-track');
      if (trackName) {
        sendPageEvent('cta_click', trackName);
        break;
      }

      target = target.parentElement;
    }
  }, false);

  // ── Fire to /api/events (page_events table — landing page CTA tracking) ─
  function sendPageEvent(eventType, eventName) {
    try {
      var body = {
        event_type: eventType,
        event_name: eventName,
        page_url  : location.pathname,
        referrer  : document.referrer || null,
      };
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(EVENTS_ENDPOINT, blob);
      } else {
        fetch(EVENTS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* never throw */ }
  }

  // ── Expose for manual calls ───────────────────────────────────────────────
  // Used by: checkout_failed (Razorpay callbacks), tunebot_query, demo events
  // Usage: window.tvTrack('checkout_failed', { plan_tier, reason })
  //        window.tvTrack('tunebot_query', { context_mode: 'ctx' })
  window.tvTrack = function (eventName, properties) {
    send(eventName, properties ? { properties: properties } : undefined);
  };

})();
