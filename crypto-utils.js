/**
 * AES-256-GCM encryption for Oracle connection passwords.
 * ENCRYPTION_KEY env var REQUIRED in production (64 hex chars = 32 bytes).
 * Does NOT own: session tokens, OAuth tokens — those are separate concerns.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// Validate encryption key at module load.
// In production: crash if ENCRYPTION_KEY is unset — falling back to DATABASE_URL or a
// hardcoded string means anyone who knows the URL can decrypt every stored credential.
// In development: allow derivation from DATABASE_URL for local convenience.
function getEncryptionKey() {
  if (process.env.ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (key.length === 32) return key;
    // Invalid length — crash immediately with clear message
    console.error('FATAL: ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Got', process.env.ENCRYPTION_KEY.length, 'chars.');
    process.exit(1);
  }

  // No ENCRYPTION_KEY set
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.error('FATAL: ENCRYPTION_KEY environment variable is required in production.');
    console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  // Development fallback — derive from DATABASE_URL (never acceptable in prod)
  const source = process.env.DATABASE_URL || 'tunevault-dev-only-key';
  return crypto.createHash('sha256').update(source).digest();
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

function decrypt(encryptedStr) {
  const key = getEncryptionKey();
  const parts = encryptedStr.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { encrypt, decrypt };
