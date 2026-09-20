const PREFIX = 'sk-or-v1-';
const HEX_64 = /^[0-9a-f]{64}$/i;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reverse(value: string): string {
  return Array.from(value).reverse().join('');
}

export function obfuscateOpenRouterKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key.startsWith(PREFIX)) throw new Error('Only standard OpenRouter keys can be shared this way.');

  const body = key.slice(PREFIX.length);
  if (!body) throw new Error('This OpenRouter key is empty.');

  if (HEX_64.test(body)) {
    return `x${base64UrlEncode(hexToBytes(body))}`;
  }

  return `r${reverse(body)}`;
}

export function deobfuscateOpenRouterKey(payload: string): string {
  const value = payload.trim();
  if (!value) throw new Error('This OpenRouter share link is empty.');

  if (value.startsWith('sk-or-')) return value;

  if (value.startsWith('x')) {
    const bytes = base64UrlDecode(value.slice(1));
    if (bytes.length !== 32) throw new Error('This compact OpenRouter share link is invalid.');
    return `${PREFIX}${bytesToHex(bytes)}`;
  }

  if (value.startsWith('r')) return `${PREFIX}${reverse(value.slice(1))}`;

  return `${PREFIX}${reverse(value)}`;
}
