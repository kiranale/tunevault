/**
 * services/saml.js — SAML 2.0 assertion validation and SP metadata generation.
 * Owns: SAML strategy construction, assertion parsing, SP metadata XML, group→role mapping.
 * Does NOT own: SSO config persistence (db/sso.js), session creation (server.js), user upsert (server.js).
 *
 * Uses passport-saml for SAML 2.0 protocol handling (signature verification, XML parsing).
 */

'use strict';

const { SAML } = require('passport-saml');

const SP_ENTITY_ID = process.env.APP_URL
  ? `${process.env.APP_URL}/saml/metadata`
  : 'https://tunevault.app/saml/metadata';

const ACS_URL = process.env.APP_URL
  ? `${process.env.APP_URL}/saml/callback`
  : 'https://tunevault.app/saml/callback';

/**
 * Build a passport-saml SAML instance from an sso_config DB row.
 * @param {object} ssoConfig - row from sso_configs table
 * @returns {SAML}
 */
function buildSamlStrategy(ssoConfig) {
  // passport-saml expects the certificate without PEM headers/footers
  const cert = ssoConfig.certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');

  return new SAML({
    callbackUrl: ACS_URL,
    entryPoint: ssoConfig.sso_url,
    issuer: SP_ENTITY_ID,
    idpCert: cert,
    validateInResponseTo: 'never', // stateless — no session store for InResponseTo
    wantAssertionsSigned: true,
    acceptedClockSkewMs: 300000, // 5 minute tolerance
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
  });
}

/**
 * Generate the SAML AuthnRequest redirect URL for a given SSO config.
 * @param {object} ssoConfig - row from sso_configs table
 * @param {string} relayState - opaque value to round-trip (encoded redirect URL)
 * @returns {Promise<string>} redirect URL
 */
async function generateAuthnRequestUrl(ssoConfig, relayState) {
  const saml = buildSamlStrategy(ssoConfig);
  return new Promise((resolve, reject) => {
    saml.getAuthorizeUrl({ RelayState: relayState }, (err, url) => {
      if (err) return reject(err);
      resolve(url);
    });
  });
}

/**
 * Parse and validate an incoming SAML response (POST from IdP).
 * Returns the decoded assertion attributes on success.
 * Throws on validation failure (bad signature, expired, wrong audience).
 *
 * @param {object} ssoConfig - row from sso_configs table
 * @param {string} samlResponseB64 - base64-encoded SAMLResponse from POST body
 * @returns {Promise<object>} parsed profile attributes
 */
async function validateSamlResponse(ssoConfig, samlResponseB64) {
  const saml = buildSamlStrategy(ssoConfig);
  return new Promise((resolve, reject) => {
    saml.validatePostResponse({ SAMLResponse: samlResponseB64 }, (err, profile) => {
      if (err) return reject(err);
      if (!profile) return reject(new Error('Empty profile from SAML assertion'));
      resolve(profile);
    });
  });
}

/**
 * Extract the user email from a parsed SAML profile using the config's attribute_mapping.
 * Falls back to nameID if the mapped attribute is absent.
 *
 * @param {object} profile - parsed SAML profile from validateSamlResponse
 * @param {object} attributeMapping - { email: 'samlAttrName', name: 'samlAttrName' }
 * @returns {{ email: string|null, name: string|null, groups: string[] }}
 */
function extractUserAttributes(profile, attributeMapping) {
  const emailAttr = attributeMapping?.email || 'nameID';
  const nameAttr = attributeMapping?.name || 'displayName';
  const groupAttr = attributeMapping?.group || 'memberOf';

  const email = profile[emailAttr] || profile.nameID || null;
  const name = profile[nameAttr] || profile['http://schemas.microsoft.com/identity/claims/displayname'] || null;

  // Groups may come as a single string or array
  let groups = profile[groupAttr] || [];
  if (typeof groups === 'string') groups = [groups];
  if (!Array.isArray(groups)) groups = [];

  return { email: email?.toLowerCase()?.trim() || null, name: name?.trim() || null, groups };
}

/**
 * Map IdP group names to a TuneVault role using the config's group_role_mapping.
 * Returns the first matching role, or the config's default_role if no match.
 *
 * @param {string[]} groups - IdP group names for this user
 * @param {object} groupRoleMapping - { 'DBA-Managers': 'admin', 'DBA-Team': 'senior_dba' }
 * @param {string} defaultRole - fallback role
 * @returns {string} TuneVault role
 */
function resolveRoleFromGroups(groups, groupRoleMapping, defaultRole) {
  if (!groupRoleMapping || Object.keys(groupRoleMapping).length === 0) {
    return defaultRole || 'junior_dba';
  }

  for (const group of groups) {
    if (groupRoleMapping[group]) {
      return groupRoleMapping[group];
    }
  }
  return defaultRole || 'junior_dba';
}

/**
 * Generate the SP metadata XML for a given SSO config.
 * Used for the GET /saml/metadata endpoint.
 *
 * @param {object} ssoConfig - row from sso_configs (optional, for signed metadata)
 * @returns {string} XML string
 */
function generateSpMetadata(ssoConfig) {
  // Build a temporary SAML instance just to get metadata
  const certBlock = ssoConfig
    ? `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${
        (ssoConfig.certificate || '')
          .replace(/-----BEGIN CERTIFICATE-----/g, '')
          .replace(/-----END CERTIFICATE-----/g, '')
          .replace(/\s/g, '')
      }</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
    : '';

  return `<?xml version="1.0"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="${SP_ENTITY_ID}"
  validUntil="2099-01-01T00:00:00Z">
  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${certBlock}
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${ACS_URL}"
      index="1"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

module.exports = {
  SP_ENTITY_ID,
  ACS_URL,
  generateAuthnRequestUrl,
  validateSamlResponse,
  extractUserAttributes,
  resolveRoleFromGroups,
  generateSpMetadata,
};
