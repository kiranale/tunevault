/**
 * services/mfa.js — TOTP secret generation, verification, QR code rendering, recovery codes.
 * Owns: all TOTP crypto operations, recovery code generation/hashing/verification.
 * Does NOT own: DB persistence (db/mfa.js), HTTP routing (routes/mfa.js),
 *               credential encryption (crypto-utils.js handles that via encrypt/decrypt).
 *
 * TOTP implemented directly per RFC 6238 to avoid otplib v13 plugin complexity.
 */

'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('../crypto-utils');

const APP_NAME = 'TuneVault';
const RECOVERY_CODE_COUNT = 10;
const BCRYPT_ROUNDS = 10;
const LOCKOUT_THRESHOLD = 5; // failed attempts before lockout

// ============================================================
// TOTP — RFC 6238 implementation using Node.js crypto
// ============================================================

// Decode base32 string to Buffer (RFC 4648 base32 alphabet, no padding required)
function base32Decode(base32str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const str = base32str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of str) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// Encode random bytes as base32 string (RFC 4648, no padding)
function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

// TOTP: compute 6-digit code for a given time step
function computeTotp(secretBase32, timeStep) {
  const key = base32Decode(secretBase32);
  const time = Buffer.alloc(8);
  // Write 64-bit big-endian time counter
  const high = Math.floor(timeStep / 0x100000000);
  const low = timeStep >>> 0;
  time.writeUInt32BE(high, 0);
  time.writeUInt32BE(low, 4);
  const hmac = crypto.createHmac('sha1', key).update(time).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function generateSecret() {
  // 20 bytes = 160 bits (recommended for TOTP)
  return base32Encode(crypto.randomBytes(20));
}

function generateOtpauthUri(email, secret) {
  const label = encodeURIComponent(`${APP_NAME}:${email}`);
  const issuer = encodeURIComponent(APP_NAME);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

async function generateQrDataUrl(otpauthUri) {
  return QRCode.toDataURL(otpauthUri, {
    width: 240,
    margin: 1,
    color: { dark: '#f0a830', light: '#111114' }
  });
}

// Verify a 6-digit token — allows ±1 time step (30s window) for clock drift
function verifyTotp(token, encryptedSecret) {
  try {
    const secret = decrypt(encryptedSecret);
    const now = Math.floor(Date.now() / 1000);
    const step = 30;
    const currentStep = Math.floor(now / step);
    const normalizedToken = String(token).replace(/\s/g, '').padStart(6, '0');
    // Check current step and ±1 for clock drift
    for (let delta = -1; delta <= 1; delta++) {
      const expected = computeTotp(secret, currentStep + delta);
      if (crypto.timingSafeEqual(Buffer.from(normalizedToken), Buffer.from(expected))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================
// Recovery codes
// ============================================================

// Generates 10 codes in XXXX-XXXX-XXXX format; returns plaintext array (shown once to user)
function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

async function hashRecoveryCodes(plaintextCodes) {
  return Promise.all(
    plaintextCodes.map(async (code) => ({
      code: await bcrypt.hash(normalizeCode(code), BCRYPT_ROUNDS),
      used: false,
      used_at: null,
    }))
  );
}

// Returns { matched: boolean, index: number } — caller must mark as used
async function verifyRecoveryCode(inputCode, hashedCodes) {
  const normalized = normalizeCode(inputCode);
  for (let i = 0; i < hashedCodes.length; i++) {
    const entry = hashedCodes[i];
    if (entry.used) continue;
    const match = await bcrypt.compare(normalized, entry.code);
    if (match) return { matched: true, index: i };
  }
  return { matched: false, index: -1 };
}

function normalizeCode(code) {
  return String(code).replace(/[-\s]/g, '').toUpperCase();
}

function unusedRecoveryCodeCount(hashedCodes) {
  return hashedCodes.filter((c) => !c.used).length;
}

// ============================================================
// Lockout
// ============================================================

function isLockedOut(failedCount) {
  return failedCount >= LOCKOUT_THRESHOLD;
}

// ============================================================
// Encrypted secret helpers
// ============================================================

function encryptSecret(secret) {
  return encrypt(secret);
}

function decryptSecret(encryptedSecret) {
  return decrypt(encryptedSecret);
}

module.exports = {
  generateSecret,
  generateOtpauthUri,
  generateQrDataUrl,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCodes,
  verifyRecoveryCode,
  unusedRecoveryCodeCount,
  isLockedOut,
  encryptSecret,
  decryptSecret,
  LOCKOUT_THRESHOLD,
};
