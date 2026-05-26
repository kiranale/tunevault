/**
 * Centralized authentication & authorization middleware.
 * Owns: token verification, user lookup, admin gate, connection ownership checks,
 *       team RBAC role enforcement (requireRole, requirePermission, requireBranch).
 * Does NOT own: session creation, OAuth flows, user upsert — those live in server.js auth routes.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'tv_session';

// Admin emails from env (comma-separated)
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

// --- Token helpers ---

function getTokenFromRequest(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function verifyToken(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return null;
  }
}

// --- Middleware: requireAuth ---
// Verifies token and attaches req.user = { id, email, name, company_domain, google_id }

async function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const result = await pool.query(
      'SELECT id, email, name, company_domain, google_id FROM users WHERE id = $1',
      [payload.userId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error('[auth] requireAuth DB error:', err.message);
    return res.status(500).json({ error: 'Auth error' });
  }
}

// --- Middleware: requireAdmin ---
// Must come after requireAuth (or performs its own auth check).
// Verifies the authenticated user's email is in ADMIN_EMAILS.

async function requireAdmin(req, res, next) {
  // If requireAuth hasn't run yet, do inline auth
  if (!req.user) {
    const token = getTokenFromRequest(req);
    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const result = await pool.query(
        'SELECT id, email, name, company_domain, google_id FROM users WHERE id = $1',
        [payload.userId]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'User not found' });
      }
      req.user = result.rows[0];
    } catch (err) {
      console.error('[auth] requireAdmin DB error:', err.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  }

  const email = (req.user.email || '').toLowerCase();
  if (!ADMIN_EMAILS.has(email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// --- Middleware: requireConnectionOwner ---
// Ensures the authenticated user owns the connection referenced by :id param.
// Legacy connections (user_id IS NULL) are allowed through for backward compatibility.
// Must come after requireAuth.

async function requireConnectionOwner(req, res, next) {
  const connectionId = req.params.id || req.params.connectionId;
  if (!connectionId) {
    return res.status(400).json({ error: 'Connection ID required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, user_id FROM oracle_connections WHERE id = $1',
      [connectionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    const conn = result.rows[0];
    // Legacy connections without user_id — allow (backward compat)
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: you do not own this connection' });
    }
    next();
  } catch (err) {
    console.error('[auth] requireConnectionOwner DB error:', err.message);
    return res.status(500).json({ error: 'Auth error' });
  }
}

// --- RBAC: Role hierarchy ---
// Individual accounts (no team) are treated as admin — full access, backward-compatible.
// Team members are restricted to their assigned role.

const ROLE_HIERARCHY = ['viewer', 'junior_dba', 'senior_dba', 'admin'];

function roleRank(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  return idx === -1 ? -1 : idx;
}

// --- Middleware: requireRole(minRole) ---
// Factory that returns middleware checking req.user has at least minRole.
// Must come after requireAuth.
// Individual accounts (not on any team) always pass — treated as admin.
// Returns 403 with { error, required_role } on denial.
// Logs denied attempts to rbac_audit_log (non-fatal if table missing).

function requireRole(minRole) {
  return async function rbacMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      // Look up team membership for this user
      const result = await pool.query(
        `SELECT tm.role
         FROM team_members tm
         JOIN users u ON u.team_id = tm.team_id
         WHERE u.id = $1 AND tm.user_id = $1
         LIMIT 1`,
        [req.user.id]
      );

      // Not on any team → individual account → full access (backward compat)
      if (result.rows.length === 0) {
        return next();
      }

      const userRole = result.rows[0].role;
      const userRank = roleRank(userRole);
      const requiredRank = roleRank(minRole);

      if (userRank >= requiredRank) {
        // Attach role to request for downstream use
        req.userTeamRole = userRole;
        return next();
      }

      // Denied — log attempt (non-fatal)
      logRbacDenial(req.user.id, req.method, req.originalUrl, minRole, userRole).catch(() => {});

      return res.status(403).json({
        error: 'Insufficient permissions',
        required_role: minRole,
        your_role: userRole,
      });
    } catch (err) {
      console.error('[auth] requireRole DB error:', err.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  };
}

// --- Helper: log RBAC denial to audit table (best-effort) ---

async function logRbacDenial(userId, method, path, requiredRole, actualRole) {
  try {
    await pool.query(
      `INSERT INTO rbac_audit_log (user_id, method, path, required_role, actual_role, denied_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, method, path.substring(0, 500), requiredRole, actualRole]
    );
  } catch {
    // Table may not exist yet or insert failed — non-fatal
  }
}

// --- RBAC: Permission-based middleware (new role system) ---
// Checks req.user has a specific permission key in their roles.permissions JSONB.
// Falls back to legacy role hierarchy if role_id is not assigned.
// Individual accounts (not on any team) always pass.

function requirePermission(permissionKey) {
  return async function permissionMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      // Check if user is on a team with the new role system
      const result = await pool.query(
        `SELECT tm.role, tm.role_id, r.permissions, r.branch
         FROM team_members tm
         LEFT JOIN roles r ON r.id = tm.role_id
         JOIN users u ON u.team_id = tm.team_id
         WHERE u.id = $1 AND tm.user_id = $1
         LIMIT 1`,
        [req.user.id]
      );

      // Not on any team → individual account → full access
      if (result.rows.length === 0) return next();

      const member = result.rows[0];
      req.userTeamRole = member.role;
      req.userBranch = member.branch;

      // New role system: check JSONB permissions
      if (member.role_id && member.permissions) {
        const perm = member.permissions[permissionKey];
        if (!perm) {
          logRbacDenial(req.user.id, req.method, req.originalUrl, permissionKey, member.role).catch(() => {});
          return res.status(403).json({
            error: 'Insufficient permissions',
            required_permission: permissionKey,
            your_role: member.role,
          });
        }
        return next();
      }

      // Fallback: legacy role hierarchy — treat admin as having all permissions
      if (member.role === 'admin' || member.role === 'senior_dba') return next();

      logRbacDenial(req.user.id, req.method, req.originalUrl, permissionKey, member.role).catch(() => {});
      return res.status(403).json({
        error: 'Insufficient permissions',
        required_permission: permissionKey,
        your_role: member.role,
      });
    } catch (err) {
      console.error('[auth] requirePermission DB error:', err.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  };
}

// --- RBAC: Branch-based middleware ---
// Restricts access to users in a specific branch (dba, functional, dev, management).
// Individual accounts (not on any team) always pass.

function requireBranch(...allowedBranches) {
  return async function branchMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const result = await pool.query(
        `SELECT tm.role, tm.role_id, r.branch, r.permissions
         FROM team_members tm
         LEFT JOIN roles r ON r.id = tm.role_id
         JOIN users u ON u.team_id = tm.team_id
         WHERE u.id = $1 AND tm.user_id = $1
         LIMIT 1`,
        [req.user.id]
      );

      // Not on any team → individual account → full access
      if (result.rows.length === 0) return next();

      const member = result.rows[0];
      req.userTeamRole = member.role;
      req.userBranch = member.branch;

      // Admin always passes branch checks
      if (member.role === 'admin') return next();

      if (member.branch && allowedBranches.includes(member.branch)) {
        return next();
      }

      // Legacy role mapping: senior_dba/junior_dba → dba branch
      const legacyBranchMap = {
        senior_dba: 'dba',
        junior_dba: 'dba',
        admin: 'management',
        viewer: null,
      };
      const legacyBranch = legacyBranchMap[member.role];
      if (legacyBranch && allowedBranches.includes(legacyBranch)) {
        return next();
      }

      logRbacDenial(req.user.id, req.method, req.originalUrl, allowedBranches.join('|'), member.role).catch(() => {});
      return res.status(403).json({
        error: 'Access restricted to specific teams',
        required_branch: allowedBranches,
        your_branch: member.branch || legacyBranch || null,
      });
    } catch (err) {
      console.error('[auth] requireBranch DB error:', err.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  };
}

// --- Middleware: requireAdminPage ---
// Like requireAdmin, but for HTML page routes.
// Unauthenticated → redirect to /signin?next=<path> (better UX than 401 for admin coming back from email).
// Authenticated non-admin → redirect to /dashboard with 403 status.
// Must be used on GET routes that serve admin HTML shells.

async function requireAdminPage(req, res, next) {
  const token = getTokenFromRequest(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl)}`);
  }
  try {
    const result = await pool.query(
      'SELECT id, email, name, company_domain, google_id FROM users WHERE id = $1',
      [payload.userId]
    );
    if (result.rows.length === 0) {
      return res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl)}`);
    }
    req.user = result.rows[0];
  } catch (err) {
    console.error('[auth] requireAdminPage DB error:', err.message);
    return res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl)}`);
  }

  const email = (req.user.email || '').toLowerCase();
  if (!ADMIN_EMAILS.has(email)) {
    return res.status(403).redirect('/dashboard');
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireAdminPage,
  requireConnectionOwner,
  requireRole,
  requirePermission,
  requireBranch,
  getTokenFromRequest,
  verifyToken,
  ADMIN_EMAILS,
  ROLE_HIERARCHY,
};
