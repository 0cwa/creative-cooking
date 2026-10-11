// QR-size invitation serialization proof. NOT an authenticated pairing protocol.
const PREFIX = 'ccpair1.';
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_SPACE = /^[0-9a-f]{32,64}$/;

export function encodeInvitation(value) {
  const { spaceId, inviterPublicKey, addressHints = [], issuedAt, expiresAt, nonce } = value;
  if (!HEX_SPACE.test(spaceId) || !HEX_64.test(inviterPublicKey) ||
      !HEX_SPACE.test(nonce) || !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt ||
      expiresAt - issuedAt > 15 * 60 * 1000 || !Array.isArray(addressHints) ||
      addressHints.length > 4 || addressHints.some(x => typeof x !== 'string' || x.length > 256)) {
    throw new Error('Invalid invitation parameters');
  }
  const canonical = {
    version: 1, spaceId, inviterPublicKey,
    addressHints: [...new Set(addressHints)].sort(),
    issuedAt, expiresAt, nonce
  };
  const token = PREFIX + Buffer.from(JSON.stringify(canonical)).toString('base64url');
  if (token.length > 2048) throw new Error('Invitation too long for QR');
  return token;
}

export function decodeInvitation(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 2048) {
    throw new Error('Invalid invitation token');
  }
  const parsed = JSON.parse(Buffer.from(token.slice(PREFIX.length), 'base64url').toString('utf8'));
  // Re-encoding provides schema, canonical order and size validation; do not accept extra fields.
  if (encodeInvitation(parsed) !== token) throw new Error('Non-canonical invitation');
  if (now > parsed.expiresAt || now < parsed.issuedAt - 5 * 60 * 1000) {
    throw new Error('Invitation expired or not yet valid');
  }
  return parsed;
}
