// Prevent browser scroll restoration so every page load starts at the top
if ('scrollRestoration' in history) { history.scrollRestoration = 'manual'; }
window.scrollTo(0, 0);

/**
 * TuneVault Navigation Component
 * Single source of truth for nav across all pages.
 *
 * Auth app nav:   Dashboard · Connections ▾ · DB Ops · EBS Ops · Fleet · Activity · [Account]
 * Public nav:     Features ▾ · Pricing · Trust · Resources ▾ · About · [Sign in] [Start Free]
 * Resources ▾:    Blog · Compare Tools · TuneVault vs OEM · Setup Guide
 * Post-login:     Pricing link stays visible; button labels change dynamically based on plan
 * EBS Ops link is always clickable; the /ebs-ops page shows an empty state when no EBS exists.
 * Mobile: hamburger collapses all links into a stacked menu.
 *
 * Usage:
 * 1. Add <nav id="nav-root"></nav> to your page
 * 2. Call window.tvNav.init(type) where type is one of:
 *    'main' | 'pricing' | 'features' | 'auth' | 'dashboard' | 'admin' | 'report' |
 *    'ebs-deep' | 'ebs-middleware' | 'fleet' | 'sql-tuning' | 'security' | 'db-ops' | 'ebs-ops'
 * 3. Nav updates automatically based on auth state via /api/auth/me
 * 4. For report pages, register a callback with tvNav.onReady(fn) — fires after every auth-driven rebuild
 */

window.tvNav = (function() {

  var _readyCallbacks = [];

  // RBAC state — populated after auth via /api/me/role
  var _permissions = null;  // null = not yet loaded
  var _teamRole    = null;  // null = individual account (full access)

  // --- Reusable inline style fragments ---
  var linkStyle = 'font-size:13px;color:var(--text);text-decoration:none;padding:6px 12px;border-radius:6px;transition:all 0.2s;white-space:nowrap;';
  var linkStyleCompact = 'font-size:11px;color:var(--text);text-decoration:none;padding:4px 10px;border-radius:6px;transition:all 0.2s;white-space:nowrap;';
  var linkHover = "this.style.color='var(--accent)'";
  var linkOut   = "this.style.color='var(--text)'";

  var btnStyle = 'font-size:13px;color:var(--text);text-decoration:none;padding:6px 14px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;transition:all 0.2s;white-space:nowrap;';
  var btnStyleCompact = 'font-size:11px;color:var(--text);text-decoration:none;padding:4px 10px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;transition:all 0.2s;white-space:nowrap;';
  var btnHover = "this.style.color='var(--accent)';this.style.borderColor='var(--accent)'";
  var btnOut   = "this.style.color='var(--text)';this.style.borderColor='rgba(255,255,255,0.15)'";

  var goldOutlineStyle = 'font-size:13px;color:var(--accent);text-decoration:none;padding:6px 16px;border:1px solid var(--accent);border-radius:6px;font-weight:500;transition:all 0.2s;white-space:nowrap;';
  var goldOutlineHover = "this.style.background='var(--accent)';this.style.color='#0a0a0c'";
  var goldOutlineOut   = "this.style.background='transparent';this.style.color='var(--accent)'";

  var ctaStyle = 'display:inline-flex;align-items:center;gap:6px;padding:8px 20px;background:var(--accent);color:#0a0a0c;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;transition:all 0.2s;white-space:nowrap;';
  var ctaHover = "this.style.background='#e09820';this.style.transform='translateY(-1px)'";
  var ctaOut   = "this.style.background='var(--accent)';this.style.transform='translateY(0)'";

  var reportBtnStyle = 'font-size:13px;color:var(--text);text-decoration:none;padding:6px 14px;border:1px solid var(--accent);border-radius:6px;transition:all 0.2s;white-space:nowrap;';
  var reportBtnHover = "this.style.background='var(--accent)';this.style.color='#0a0a0c'";
  var reportBtnOut   = "this.style.background='transparent';this.style.color='var(--text)'";

  // Dropdown container shared styles
  var dropdownWrapStyle = 'position:relative;display:inline-block;';
  // z-index:9999 beats the grain overlay (999), tunebot panel (9991), and any
  // backdrop-filter stacking context created by sticky nav wrappers on app pages.
  var dropdownMenuStyle = 'position:absolute;top:calc(100% + 6px);left:0;min-width:220px;background:#111114;border:1px solid #2a2a30;border-radius:8px;padding:6px 0;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.5);';

  function buildDropdownItem(href, label, desc) {
    var d = desc ? '<div style="font-size:11px;color:#9898a8;margin-top:2px;line-height:1.3;">' + desc + '</div>' : '';
    return '<a href="' + href + '" style="display:block;padding:10px 16px;text-decoration:none;color:#e8e8ed;transition:background 0.15s;" ' +
      'onmouseover="this.style.background=\'rgba(240,168,48,0.08)\'" onmouseout="this.style.background=\'transparent\'">' +
      '<div style="font-size:13px;font-weight:500;">' + label + '</div>' + d +
      '</a>';
  }

  // Builds the Connections dropdown — DB Connections list + Connection Targets (agent management)
  function buildConnectionsDropdown(currentType, compact) {
    var lStyle = compact ? linkStyleCompact : linkStyle;
    var isActive = (currentType === 'connections' || currentType === 'connection-targets');
    var activeColor = isActive ? 'color:var(--accent);border-color:var(--accent);' : '';
    return '<div style="' + dropdownWrapStyle + '" class="tv-dropdown">' +
      '<button style="background:none;border:none;cursor:pointer;' + lStyle + activeColor + 'display:inline-flex;align-items:center;gap:4px;" ' +
        'onclick="tvNavToggleDropdown(this)" ' +
        'onmouseover="this.style.color=\'var(--accent)\'" ' +
        'onmouseout="this.style.color=\'' + (isActive ? 'var(--accent)' : 'var(--text)') + '\'">' +
        'Connections &#9662;' +
      '</button>' +
      '<div class="tv-dropdown-menu" role="menu" style="' + dropdownMenuStyle + '">' +
        buildDropdownItem('/connections', '🗄️ DB Connections', 'All connected Oracle databases with health status') +
        buildDropdownItem('/connections/new', '＋ Add Connection', 'Connect a new Oracle database via agent or direct') +
      '</div>' +
    '</div>';
  }

  // Builds the DB Ops nav link (single link → /db-ops hub page)
  function buildDbOpsLink(currentType, compact) {
    var lStyle = compact ? linkStyleCompact : linkStyle;
    var isActive = (currentType === 'db-ops');
    var activeColor = isActive ? 'color:var(--accent);' : '';
    var hoverIn  = isActive ? "this.style.opacity='0.75'" : linkHover;
    var hoverOut = isActive ? "this.style.opacity='1'"   : linkOut;
    return '<a href="/db-ops" style="' + lStyle + activeColor + '" onmouseover="' + hoverIn + '" onmouseout="' + hoverOut + '">DB Ops</a>';
  }

  // Builds the EBS Ops nav link (single link → /ebs-ops hub page)
  // Always clickable — the /ebs-ops page shows an empty state when no EBS connections exist.
  function buildEbsLink(currentType, hasEbs, compact) {
    var lStyle = compact ? linkStyleCompact : linkStyle;
    var isActive = (currentType === 'ebs-ops' || currentType === 'ebs-deep' || currentType === 'ebs-middleware' || currentType === 'ebs-concurrent' || currentType === 'sanity-check' || currentType === 'ebs-12-2-checks');
    var activeColor = isActive ? 'color:var(--accent);' : '';
    var hoverIn  = isActive ? "this.style.opacity='0.75'" : linkHover;
    var hoverOut = isActive ? "this.style.opacity='1'"   : linkOut;
    return '<a href="/ebs-ops" style="' + lStyle + activeColor + '" onmouseover="' + hoverIn + '" onmouseout="' + hoverOut + '">EBS Ops</a>';
  }

  // Builds the Admin ▾ dropdown for admin-only nav entries.
  // Contains all /admin/* pages reachable from the top nav.
  // Used in both the authenticated app nav (isAdmin block) and the dedicated admin nav.
  function buildAdminDropdown(compact) {
    var bStyle = compact ? btnStyleCompact : btnStyle;
    return '<div style="' + dropdownWrapStyle + '" class="tv-dropdown">' +
      '<button style="background:none;border:1px solid rgba(255,255,255,0.15);cursor:pointer;' + bStyle + 'display:inline-flex;align-items:center;gap:4px;" ' +
        'onclick="tvNavToggleDropdown(this)" ' +
        'onmouseover="this.style.color=\'var(--accent)\';this.style.borderColor=\'var(--accent)\'" ' +
        'onmouseout="this.style.color=\'var(--text)\';this.style.borderColor=\'rgba(255,255,255,0.15)\'">' +
        'Admin &#9662;' +
      '</button>' +
      '<div class="tv-dropdown-menu" role="menu" style="' + dropdownMenuStyle + '">' +
        buildDropdownItem('/admin/agents', '🤖 Agents', 'Live agent fleet and installer health') +
        buildDropdownItem('/admin/users', '👤 Users', 'Manage user accounts') +
        buildDropdownItem('/admin/requests', '📋 Requests', 'Pending access requests') +
        buildDropdownItem('/admin/outreach-lock', '🔒 Outreach Lock', 'Hard-lock control panel') +
        buildDropdownItem('/admin/proxy-self-test', '🧪 Proxy Self-Test', 'Synthetic EBS pipeline validator') +
        buildDropdownItem('/admin/ebs-validation', '✅ EBS Validation', 'EBS smoke tests') +
        buildDropdownItem('/admin/schedules', '📅 Schedules', 'Monitoring schedule overview') +
        buildDropdownItem('/admin/funnel', '📊 Funnel', 'Conversion funnel analytics dashboard') +
      '</div>' +
    '</div>';
  }

  // Builds the Resources dropdown for public nav — Blog, Compare, vs OEM, Setup Guide, Runbooks
  function buildResourcesDropdown() {
    return '<div style="' + dropdownWrapStyle + '" class="tv-dropdown">' +
      '<button style="background:none;border:none;cursor:pointer;' + linkStyle + '" ' +
        'onclick="tvNavToggleDropdown(this)">' +
        'Resources &#9662;' +
      '</button>' +
      '<div class="tv-dropdown-menu" style="' + dropdownMenuStyle + '">' +
        buildDropdownItem('/blog', '📝 Blog', 'Oracle DBA field notes — 20 years of production lessons') +
        buildDropdownItem('/resources/runbooks', '🛠️ Runbooks', 'Step-by-step Oracle emergency recovery guides') +
        buildDropdownItem('/compare', '⚖️ Compare Tools', 'TuneVault vs Datadog, OEM, Grafana & more') +
        buildDropdownItem('/vs-oem', '🔄 TuneVault vs OEM', 'Head-to-head with Oracle Enterprise Manager') +
        buildDropdownItem('https://tunevault.app/docs/oracle-setup', '📖 Setup Guide', 'Get your Oracle DB connected in minutes') +
      '</div>' +
    '</div>';
  }

  // Builds the Features dropdown for public nav.
  // isLoggedIn: when true, Fleet and SQL Tuning link directly to the in-app dashboards
  // (/fleet, /sql-tuning) so logged-in users skip the marketing landing pages.
  function buildProductDropdown(isLoggedIn) {
    var fleetHref = isLoggedIn ? '/fleet'        : '/features/fleet-management';
    var sqlHref   = isLoggedIn ? '/sql-tuning'   : '/features/sql-tuning';
    var fleetDesc = isLoggedIn ? 'Go to your fleet dashboard' : 'Multi-instance overview';
    var sqlDesc   = isLoggedIn ? 'Go to your SQL tuning dashboard' : 'AI-powered query analysis';
    return '<div style="' + dropdownWrapStyle + '" class="tv-dropdown">' +
      '<button style="background:none;border:none;cursor:pointer;' + linkStyle + '" ' +
        'onclick="tvNavToggleDropdown(this)">' +
        'Features &#9662;' +
      '</button>' +
      '<div class="tv-dropdown-menu" style="' + dropdownMenuStyle + '">' +
        buildDropdownItem('/features', 'Oracle DB Monitoring', '200+ health checks, AI analysis') +
        buildDropdownItem('/features#ebs-wrapper', 'Oracle EBS Operations', 'CM, Workflow, ADOP, Deep EBS') +
        buildDropdownItem(sqlHref,   'SQL Tuning',       sqlDesc) +
        buildDropdownItem(fleetHref, 'Fleet Management', fleetDesc) +
        buildDropdownItem('/architecture', 'How It Works', 'Proxy, polling, SSE — full technical explainer') +
      '</div>' +
    '</div>';
  }

  function buildLogo(type) {
    var logoSize = '18px';
    var iconSize = '28px';
    var iconFs   = '13px';
    var gap      = '10px';
    return '<a href="/" class="nav-logo" style="display:flex;align-items:center;gap:' + gap + ';text-decoration:none;color:var(--text);font-weight:700;font-size:' + logoSize + ';flex-shrink:0;">' +
      '<div class="logo-icon" style="width:' + iconSize + ';height:' + iconSize + ';background:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:\'JetBrains Mono\',monospace;font-size:' + iconFs + ';color:var(--bg);font-weight:700;">TV</div>' +
      '<span>TuneVault</span>' +
    '</a>';
  }

  function buildHamburger() {
    return '<button id="tv-hamburger" aria-label="Menu" style="display:none;background:none;border:none;cursor:pointer;padding:6px;color:var(--text);flex-shrink:0;" onclick="tvNavToggleMobile()">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
    '</button>';
  }

  function buildMobileMenuStyle() {
    return '<style>' +
      '/* Dropdown visibility — desktop: shown by class, hidden by default */' +
      '.tv-dropdown-menu{display:none;}' +
      '.tv-dropdown-menu.tv-open{display:block;}' +
      /* Hamburger collapse at 1200px: catches 1024-1280px viewports where the
         authenticated nav overflows. Matches existing mobile-collapse pattern. */
      '@media(max-width:1200px){' +
        '#tv-hamburger{display:block!important;}' +
        '.nav-right{display:none!important;flex-direction:column!important;position:absolute!important;top:100%!important;left:0!important;right:0!important;background:#111114!important;border-bottom:1px solid #2a2a30!important;padding:16px 24px!important;gap:4px!important;z-index:999!important;}' +
        '.nav-right.tv-mobile-open{display:flex!important;}' +
        '.tv-dropdown-menu{position:static!important;box-shadow:none!important;border:none!important;background:transparent!important;padding-left:12px!important;}' +
        '.tv-dropdown-menu.tv-mobile-open{display:block!important;}' +
      '}' +
    '</style>';
  }

  function buildNav(type, user, isAdmin, hasEbs) {
    var isLoggedIn = !!user;
    var isReportPage = (type === 'report');
    var currentLinkStyle = linkStyle;
    var currentBtnStyle  = btnStyle;
    var currentGoldStyle = goldOutlineStyle;
    var itemGap = '12px';

    var html = buildMobileMenuStyle() + buildLogo(type) + buildHamburger();

    // Auth-only: minimal nav
    if (type === 'auth') return html;

    // Admin: dedicated nav
    if (type === 'admin') {
      html += '<div class="nav-right" style="display:flex;align-items:center;gap:8px;">' +
        '<a href="/" style="' + btnStyle + '" onmouseover="' + btnHover + '" onmouseout="' + btnOut + '">&#8592; Back</a>' +
        buildAdminDropdown(false) +
        '<span style="width:1px;height:18px;background:rgba(255,255,255,0.12);margin:0 4px;"></span>' +
        (isLoggedIn
          ? '<span style="font-size:12px;color:var(--text-dim);">' + (user.name || user.email || '') + '</span>' +
            '<button onclick="window.tvNav.signOut()" style="background:none;' + btnStyle + 'cursor:pointer;" onmouseover="' + btnHover + '" onmouseout="' + btnOut + '">Sign out</button>'
          : '<a href="/login?redirect=' + encodeURIComponent(window.location.pathname) + '" style="' + goldOutlineStyle + '" onmouseover="' + goldOutlineHover + '" onmouseout="' + goldOutlineOut + '">Sign in</a>'
        ) +
        '</div>';
      return html;
    }

    var rightHtml = '';

    // ── AUTHENTICATED APP NAV ──────────────────────────────────────────────────
    var AUTH_TYPES = { dashboard:1, 'ebs-deep':1, fleet:1, 'sql-tuning':1, report:1, 'db-ops':1, 'ebs-ops':1, 'ebs-concurrent':1, 'sanity-check':1, activity:1, manager:1, pricing:1, connections:1, settings:1, billing:1, 'connection-targets':1, 'ebs-clone':1, 'ebs-control-exec':1, security:1, 'ebs-middleware':1, 'ebs-patches':1, 'ebs-status-sources':1, 'os-diagnostics':1, 'ebs-log-tail':1, fndload:1 };
    if (isLoggedIn && AUTH_TYPES[type]) {
      if (type === 'report') {
        rightHtml += '<span id="navActions" style="display:inline-flex;align-items:center;gap:8px;"></span>';
        rightHtml += '<a href="/dashboard" style="' + reportBtnStyle + '" onmouseover="' + reportBtnHover + '" onmouseout="' + reportBtnOut + '">New Check</a>';
        rightHtml += '<a href="/dashboard#history" style="' + reportBtnStyle + '" onmouseover="' + reportBtnHover + '" onmouseout="' + reportBtnOut + '">All Reports</a>';
        rightHtml += '<span style="width:1px;height:16px;background:rgba(255,255,255,0.12);margin:0 4px;"></span>';
      }

      // Dashboard
      rightHtml += '<a href="/dashboard" style="' + currentLinkStyle + (type === 'dashboard' ? 'color:var(--accent);' : '') + '" onmouseover="' + (type === 'dashboard' ? "this.style.opacity='0.75'" : linkHover) + '" onmouseout="' + (type === 'dashboard' ? "this.style.opacity='1'" : linkOut) + '">Dashboard</a>';

      // Connections dropdown — DB Connections + Connection Targets + Add Connection
      rightHtml += buildConnectionsDropdown(type, false);

      // DB Ops link
      rightHtml += buildDbOpsLink(type, false);

      // EBS Ops link
      rightHtml += buildEbsLink(type, hasEbs, false);

      // SQL Tuning — accessed via DB Ops tab, not top-level nav

      // Fleet
      rightHtml += '<a href="/fleet" id="nav-fleet" style="' + currentLinkStyle + (type === 'fleet' ? 'color:var(--accent);' : '') + '" onmouseover="' + (type === 'fleet' ? "this.style.opacity='0.75'" : linkHover) + '" onmouseout="' + (type === 'fleet' ? "this.style.opacity='1'" : linkOut) + '">Fleet</a>';

      // Activity and Manager moved to Admin dropdown

      // User email + admin links
      if (isAdmin) {
        rightHtml += buildAdminDropdown(true);
      }
      // User account dropdown — replaces scattered Billing/Pricing/Security/SSO/Sign out buttons
      rightHtml += '<div style="' + dropdownWrapStyle + '" class="tv-dropdown">' +
        '<button id="nav-user-btn" style="background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim);padding:4px 8px;border:1px solid rgba(255,255,255,0.15);border-radius:5px;white-space:nowrap;flex-shrink:0;transition:all 0.2s;" ' +
          'onclick="tvNavToggleDropdown(this)" ' +
          'onmouseover="this.style.color=\'var(--accent)\';this.style.borderColor=\'var(--accent)\'" ' +
          'onmouseout="this.style.color=\'var(--text-dim)\';this.style.borderColor=\'rgba(255,255,255,0.15)\'">' +
          '<span id="nav-user-email" style="font-size:13px;">Account</span> &#9662;' +
        '</button>' +
        '<div class="tv-dropdown-menu" role="menu" style="' + dropdownMenuStyle + 'right:0;left:auto;">' +
          buildDropdownItem('/settings/billing', '💳 Billing', 'Subscription and usage') +
          buildDropdownItem('/pricing', '📋 Pricing', 'Plans and features') +
          buildDropdownItem('/settings/security', '🔒 Security', 'Password and 2FA') +
          buildDropdownItem('/settings/sso', '🔑 SSO', 'Single sign-on settings') +
          '<div style="border-top:1px solid rgba(255,255,255,0.1);margin:4px 0;"></div>' +
          '<button id="nav-signout-btn" onclick="window.tvNav.signOut()" style="width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:10px 16px;font-size:13px;color:var(--text-dim);display:flex;align-items:center;gap:10px;transition:background 0.15s;" onmouseover="this.style.background=\'rgba(255,255,255,0.05)\'" onmouseout="this.style.background=\'none\'">🚪 Sign out</button>' +
        '</div>' +
      '</div>';

    } else if (isLoggedIn) {
      // Authenticated user on public/marketing pages — Pricing stays visible (dynamic buttons)
      // Pass true so Fleet + SQL Tuning links go directly to the in-app dashboards
      rightHtml += buildProductDropdown(true);
      rightHtml += '<a href="/pricing" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">Pricing</a>';
      rightHtml += buildResourcesDropdown();
      rightHtml += '<a href="/trust" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">Trust</a>';
      rightHtml += '<a href="/about" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">About</a>';
      rightHtml += '<a href="/sample-report" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">Sample Report</a>';
      rightHtml += '<a href="/dashboard" style="' + currentGoldStyle + '" onmouseover="' + goldOutlineHover + '" onmouseout="' + goldOutlineOut + '">Dashboard</a>';
      rightHtml += '<button id="nav-signout-btn" onclick="window.tvNav.signOut()" style="background:none;' + currentBtnStyle + 'cursor:pointer;" onmouseover="' + btnHover + '" onmouseout="' + btnOut + '">Sign out</button>';

    } else {
      // ── PUBLIC/MARKETING NAV ──────────────────────────────────────────────────
      if (type !== 'auth') {
        // Product dropdown — pass false (not logged in) so links go to marketing pages
        rightHtml += buildProductDropdown(false);

        // Core marketing links
        rightHtml += '<a href="/pricing" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">Pricing</a>';
        rightHtml += '<a href="/trust" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">Trust</a>';
        rightHtml += buildResourcesDropdown();
        rightHtml += '<a href="/about" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">About</a>';
        rightHtml += '<a href="/sample-report" style="' + currentLinkStyle + '" onmouseover="' + linkHover + '" onmouseout="' + linkOut + '">Sample Report</a>';

        // Auth CTAs
        // Preserve current page as redirect target so user returns here after auth
        var returnPath = encodeURIComponent(window.location.pathname + window.location.search);
        rightHtml += '<a href="/signin?redirect=' + returnPath + '" style="' + currentGoldStyle + '" id="nav-signin" onmouseover="' + goldOutlineHover + '" onmouseout="' + goldOutlineOut + '" data-track="nav_signin">Sign in</a>';
        rightHtml += '<a href="/signup?path=health-check&redirect=/dashboard" class="nav-cta" id="nav-cta" style="' + ctaStyle + '" onmouseover="' + ctaHover + '" onmouseout="' + ctaOut + '" data-track="nav_signup">Start Free</a>';
      }
    }

    html += '<div class="nav-right" style="display:flex;align-items:center;gap:' + itemGap + ';flex-wrap:wrap;row-gap:8px;overflow:visible;">' + rightHtml + '</div>';
    return html;
  }

  function signOut() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      .finally(function() { window.location.href = '/'; });
  }

  function fireReadyCallbacks() {
    for (var i = 0; i < _readyCallbacks.length; i++) {
      try { _readyCallbacks[i](); } catch (e) { /* silent */ }
    }
  }

  function revealNav(navRoot) {
    var navRight = navRoot && navRoot.querySelector('.nav-right');
    if (navRight) { navRight.style.opacity = '1'; }
  }

  // Checks if any connection has is_ebs=true; returns promise<boolean>
  function checkHasEbs() {
    return fetch('/api/connections', { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(rows) { return rows.some(function(c) { return c.is_ebs; }); })
      .catch(function() { return false; });
  }

  function updateNavForAuth(type) {
    var navRoot = document.getElementById('nav-root');
    var authReq = fetch('/api/auth/me', { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : null; });

    Promise.all([authReq]).then(function(results) {
      var data = results[0];
      var user = data ? data.user : null;
      var isAdmin = user ? user.is_admin : false;
      var managerRole = user ? user.manager_role : null;

      // Only fetch EBS state when authenticated (avoid 401s on public nav)
      var ebsCheck = user
        ? checkHasEbs()
        : Promise.resolve(false);

      // Fetch RBAC permissions for logged-in users (non-blocking, best-effort)
      var roleReq = user
        ? fetch('/api/me/role', { credentials: 'include' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .catch(function() { return null; })
        : Promise.resolve(null);

      Promise.all([ebsCheck, roleReq]).then(function(ebsRoleResults) {
        var hasEbs = ebsRoleResults[0];
        var roleData = ebsRoleResults[1];

        // Store permissions globally — null = full access (individual account or load failure)
        if (roleData) {
          _permissions = roleData.permissions || null;
          _teamRole = roleData.role;  // null = individual account
        } else {
          _permissions = null;
          _teamRole = null;
        }

        if (navRoot) {
          navRoot.innerHTML = buildNav(type, user, isAdmin, hasEbs);
          revealNav(navRoot);
        }

        // Show Manager link for users with manager/sdm/admin role
        var managerRoles = { manager: true, sdm: true, admin: true };
        if (user && (isAdmin || managerRoles[managerRole])) {
          var mgrLink = document.getElementById('nav-manager');
          if (mgrLink) mgrLink.style.display = '';
        }

        // Apply RBAC gating to all elements with data-rbac-require attribute.
        // Disabled buttons get a tooltip and reduced opacity; they remain visible.
        applyRbacGating();

        if (user) {
          var emailEl = document.getElementById('nav-user-email');
          if (emailEl) {
            var displayName = user.name || user.email || '';
            // Show role badge in nav using already-fetched role data
            var role = _teamRole;
            if (role) {
              var roleColors = {
                admin: 'background:rgba(240,168,48,.15);color:#f0a830;border:1px solid rgba(240,168,48,.25);',
                senior_dba: 'background:rgba(96,165,250,.12);color:#60a5fa;border:1px solid rgba(96,165,250,.2);',
                junior_dba: 'background:rgba(52,211,153,.1);color:#34d399;border:1px solid rgba(52,211,153,.2);',
                viewer: 'background:rgba(255,255,255,.06);color:#9898a8;border:1px solid #2a2a30;'
              };
              var roleLabels = { admin: 'Admin', senior_dba: 'Senior DBA', junior_dba: 'Junior DBA', viewer: 'Viewer' };
              var badgeStyle = roleColors[role] || roleColors.viewer;
              emailEl.innerHTML = displayName +
                ' <span style="display:inline-flex;align-items:center;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.04em;margin-left:4px;' + badgeStyle + '">' +
                (roleLabels[role] || role) + '</span>';
            } else {
              emailEl.textContent = displayName;
            }
          }

          // Update hero CTAs for logged-in users
          document.querySelectorAll('a.hero-cta').forEach(function(a) {
            if (a.href && a.href.includes('signup')) {
              if (a.href.includes('demo=1')) {
                a.href = '/dashboard';
                a.innerHTML = 'Open Dashboard \u2192';
              } else {
                a.href = '/dashboard';
                a.innerHTML = 'Run Health Check \u2192';
              }
            }
          });
          // demo-preview-cta links (View Sample Report, View Sample EBS Report) intentionally
          // keep their original href — they should go to the sample pages for all users.
          document.querySelectorAll('a.statement-cta').forEach(function(a) {
            if (a.href && a.href.includes('signup')) {
              a.href = '/dashboard';
              a.innerHTML = 'Open Dashboard \u2192';
              // Fix contrast: strip inline color overrides and hover handlers
              // that cause gold-on-gold text (invisible on hover)
              a.removeAttribute('onmouseover');
              a.removeAttribute('onmouseout');
              if (a.classList.contains('hero-cta-text')) {
                // Hero-level button: swap to .hero-cta to match sibling CTAs
                a.removeAttribute('style');
                a.className = 'hero-cta';
              }
            }
          });
        }

        document.querySelectorAll('[data-auth-guard]').forEach(function(el) {
          el.style.opacity = '1';
          el.style.transition = 'opacity 0.15s ease';
        });

        fireReadyCallbacks();
      });
    }).catch(function() {
      revealNav(navRoot);
      document.querySelectorAll('[data-auth-guard]').forEach(function(el) {
        el.style.opacity = '1';
      });
      fireReadyCallbacks();
    });
  }

  // Applies RBAC gating to elements with data-rbac-require="<permission>" attribute.
  // Disables buttons/links and shows tooltip for permissions the user lacks.
  // Safe to call multiple times — idempotent (checks already-disabled state).
  function applyRbacGating() {
    if (_permissions === null) return; // still loading or individual account — no gating needed
    document.querySelectorAll('[data-rbac-require]').forEach(function(el) {
      var perm = el.getAttribute('data-rbac-require');
      var allowed = _permissions[perm];
      if (allowed === false) {
        // Disable the element
        el.setAttribute('disabled', 'disabled');
        el.style.opacity = '0.4';
        el.style.cursor = 'not-allowed';
        el.style.pointerEvents = 'none';
        // Wrap in a span with a tooltip if not already wrapped
        if (!el.parentElement || !el.parentElement.classList.contains('tv-rbac-wrap')) {
          var roleNeeded = { run_health_checks: 'Junior DBA', export_reports: 'Junior DBA', run_sql_tuning: 'Junior DBA',
            execute_db_ops_read: 'Junior DBA', execute_db_ops_write: 'Senior DBA', execute_ebs_control: 'Senior DBA',
            kill_sessions: 'Senior DBA', execute_ssh: 'Senior DBA', manage_connections: 'Senior DBA',
            delete_connections: 'Admin', manage_ssh_targets: 'Senior DBA', configure_monitoring: 'Senior DBA',
            manage_team: 'Admin', manage_billing: 'Admin' };
          var needed = roleNeeded[perm] || 'higher';
          var wrap = document.createElement('span');
          wrap.className = 'tv-rbac-wrap';
          wrap.title = 'Requires ' + needed + ' role or above';
          wrap.style.cssText = 'display:inline-block;cursor:not-allowed;';
          el.parentNode.insertBefore(wrap, el);
          wrap.appendChild(el);
        }
      }
    });
  }

  return {
    init: function(type) {
      var navRoot = document.getElementById('nav-root');
      if (!navRoot) return;

      // Render logged-out shell first (prevents auth flash)
      navRoot.innerHTML = buildNav(type, null, false, false);
      navRoot.style.display = 'flex';
      navRoot.style.justifyContent = 'space-between';
      navRoot.style.alignItems = 'center';
      navRoot.style.position = 'relative';
      var hPad = window.innerWidth < 600 ? '16px' : window.innerWidth < 900 ? '24px' : '48px';
      var vPad = '16px';
      navRoot.style.padding = vPad + ' ' + hPad;
      navRoot.style.maxWidth = '1400px';
      navRoot.style.margin = '0 auto';

      var navRight = navRoot.querySelector('.nav-right');
      if (navRight) {
        navRight.style.opacity = '0';
        navRight.style.transition = 'opacity 0.15s ease';
      }

      updateNavForAuth(type);
    },
    signOut: signOut,
    onReady: function(fn) {
      if (typeof fn === 'function') _readyCallbacks.push(fn);
    },
    // Check if current user has a permission. Returns true for individual accounts (no team).
    can: function(permission) {
      if (_permissions === null) return true; // individual account = full access
      return _permissions[permission] === true;
    },
    // Returns the current user's team role. null = individual (full access).
    getRole: function() { return _teamRole; },
    // Re-run RBAC gating — call this after dynamically adding [data-rbac-require] elements
    refreshRbac: function() { applyRbacGating(); },
  };
})();

// ── Global helpers (outside the module so onclick attributes work) ──────────

function tvNavToggleDropdown(btn) {
  var wrap = btn.parentElement;
  var menu = wrap ? wrap.querySelector('.tv-dropdown-menu') : null;
  if (!menu) return;
  var isOpen = menu.classList.contains('tv-open');

  // Close all open dropdowns first
  document.querySelectorAll('.tv-dropdown-menu').forEach(function(m) {
    m.classList.remove('tv-open');
  });

  if (!isOpen) {
    menu.classList.add('tv-open');
  }
}

function tvNavToggleMobile() {
  var navRight = document.querySelector('#nav-root .nav-right');
  if (!navRight) return;
  navRight.classList.toggle('tv-mobile-open');
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.tv-dropdown')) {
    document.querySelectorAll('.tv-dropdown-menu').forEach(function(m) {
      m.classList.remove('tv-open');
    });
  }
});

// Keyboard navigation: Escape closes open dropdown; arrow keys + Enter navigate items.
document.addEventListener('keydown', function(e) {
  var openMenu = document.querySelector('.tv-dropdown-menu.tv-open');

  if (e.key === 'Escape') {
    document.querySelectorAll('.tv-dropdown-menu').forEach(function(m) { m.classList.remove('tv-open'); });
    return;
  }

  if (!openMenu) return;

  var items = Array.prototype.slice.call(openMenu.querySelectorAll('a'));
  if (!items.length) return;

  var focused = document.activeElement;
  var idx = items.indexOf(focused);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    var next = items[idx + 1] || items[0];
    next.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    var prev = items[idx - 1] || items[items.length - 1];
    prev.focus();
  } else if (e.key === 'Enter' && idx >= 0) {
    // Let the default link navigation happen (no preventDefault)
  }
});
