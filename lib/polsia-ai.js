/**
 * lib/polsia-ai.js — Polsia AI proxy client.
 *
 * Owns: Thin wrapper around the Polsia AI proxy endpoint.
 *       All AI inference in TuneVault must go through this module.
 * Does NOT own: model selection (Polsia handles it), rate limiting (proxy handles it).
 *
 * Env vars: POLSIA_API_KEY, POLSIA_API_URL (auto-injected by Polsia infra).
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  baseURL: process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai',
  apiKey:  process.env.POLSIA_API_KEY,
});

/**
 * One-shot chat completion via Polsia proxy.
 * @param {string} message          — user turn
 * @param {{ system?: string, maxTokens?: number }} [opts]
 * @returns {Promise<string>}
 */
async function chat(message, opts = {}) {
  const response = await anthropic.messages.create({
    max_tokens: opts.maxTokens || 512,
    messages:   [{ role: 'user', content: message }],
    system:     opts.system,
  });
  return response.content[0].text;
}

module.exports = { chat };
