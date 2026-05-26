// What this module owns: security middleware — helmet headers, rate limiters, zod input validators.
// Does NOT own: authentication/session logic (middleware/auth.js), business logic, DB access.

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

// ============================================================
// Helmet — security response headers
// ============================================================
// 'unsafe-inline' for scripts/styles is required because the vanilla JS frontend
// uses inline event handlers and inline <script> blocks. Nonces are future work.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://apis.google.com', 'https://checkout.razorpay.com'],
      // Helmet 8.x defaults script-src-attr to 'none', which blocks inline onclick/onchange/etc.
      // Must explicitly allow since our vanilla JS frontend uses inline event handlers everywhere.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      // Razorpay checkout opens an iframe on checkout.razorpay.com; connectSrc covers fetch/XHR calls.
      connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
      frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // HSTS: 1 year, include subdomains
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  // Block clickjacking
  frameguard: { action: 'deny' },
  // Prevent MIME sniffing
  noSniff: true,
  // Disable X-Powered-By (already off by default in helmet, explicit here)
  hidePoweredBy: true,
});

// ============================================================
// Rate limiters
// ============================================================

// Standard rate limit response
function rateLimitHandler(req, res) {
  res.status(429).json({
    error: 'Too many requests. Please slow down and try again shortly.',
    retryAfter: res.getHeader('Retry-After'),
  });
}

// Auth routes: magic-link requests, Google OAuth — 10 req/min per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => process.env.NODE_ENV === 'test',
});

// Connection CRUD — 30 req/min per IP
const connectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => process.env.NODE_ENV === 'test',
});

// Admin routes — 20 req/min per IP
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => process.env.NODE_ENV === 'test',
});

// General API — 100 req/min per IP (catch-all)
const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => process.env.NODE_ENV === 'test',
});

// ============================================================
// Input validation helpers (zod)
// ============================================================

// Middleware factory: validate req.body against a zod schema
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    // Replace req.body with the parsed (type-safe) data
    req.body = result.data;
    next();
  };
}

// ---- Schemas ----

// POST /api/auth/magic-link/request
const magicLinkSchema = z.object({
  email: z.string().email('Valid email required').max(254),
  redirect: z.string().max(500).optional(),
});

// POST /api/connections
const createConnectionSchema = z.object({
  name: z.string().max(255).optional(),
  host: z.string().max(253).optional(),
  port: z
    .union([z.string(), z.number()])
    .transform((v) => parseInt(String(v), 10))
    .refine((v) => v >= 1 && v <= 65535, { message: 'port must be between 1 and 65535' })
    .optional(),
  service_name: z.string().min(1, 'service_name is required').max(128),
  username: z.string().min(1, 'username is required').max(128),
  password: z.string().min(1, 'password is required').max(1024),
  connection_type: z.enum(['direct', 'proxy']).optional(),
  proxy_url: z.string().url('proxy_url must be a valid URL').max(512).optional(),
  proxy_api_key: z.string().max(512).optional(),
});

// PUT /api/connections/:id
const updateConnectionSchema = z.object({
  name: z.string().max(255).optional(),
  host: z.string().max(253).optional(),
  port: z
    .union([z.string(), z.number()])
    .transform((v) => parseInt(String(v), 10))
    .refine((v) => v >= 1 && v <= 65535, { message: 'port must be between 1 and 65535' })
    .optional(),
  service_name: z.string().max(128).optional(),
  username: z.string().max(128).optional(),
  password: z.string().max(1024).optional(),
  connection_type: z.enum(['direct', 'proxy']).optional(),
  proxy_url: z.string().url('proxy_url must be a valid URL').max(512).optional().nullable(),
  proxy_api_key: z.string().max(512).optional().nullable(),
  privilege_model: z.enum(['reader', 'sysdba']).optional(),
});

// PATCH /api/connections/:id — edit name + Oracle credentials only (host/port/service locked)
const editConnectionSchema = z.object({
  name:     z.string().max(255).optional(),
  username: z.string().max(128).optional(),
  password: z.string().max(1024).optional(),
}).refine(data => data.name !== undefined || data.username !== undefined || data.password !== undefined, {
  message: 'At least one field (name, username, or password) is required',
});

module.exports = {
  helmetMiddleware,
  authLimiter,
  connectionLimiter,
  adminLimiter,
  generalApiLimiter,
  validateBody,
  magicLinkSchema,
  createConnectionSchema,
  updateConnectionSchema,
  editConnectionSchema,
};
