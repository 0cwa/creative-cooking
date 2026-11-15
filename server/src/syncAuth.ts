import { exportJWK, importPKCS8, importSPKI, SignJWT, type JWK } from 'jose';
import type { ServerConfig } from './config.js';

export const POWERSYNC_JWT_TTL_SECONDS = 300;

interface SyncKeys {
  privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  publicJwk: JWK;
}

const keyCache = new Map<string, Promise<SyncKeys>>();

function keys(config: Pick<ServerConfig, 'syncJwtPrivateKeyB64Url' | 'syncJwtPublicKeyB64Url' | 'syncJwtKeyId'>): Promise<SyncKeys> {
  const cacheKey = `${config.syncJwtKeyId}\0${config.syncJwtPrivateKeyB64Url}\0${config.syncJwtPublicKeyB64Url}`;
  let cached = keyCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const privatePem = Buffer.from(config.syncJwtPrivateKeyB64Url, 'base64url').toString('utf8');
      const publicPem = Buffer.from(config.syncJwtPublicKeyB64Url, 'base64url').toString('utf8');
      const [privateKey, publicKey] = await Promise.all([
        importPKCS8(privatePem, 'EdDSA'),
        importSPKI(publicPem, 'EdDSA'),
      ]);
      const publicJwk = await exportJWK(publicKey);
      return { privateKey, publicJwk: { ...publicJwk, use: 'sig', alg: 'EdDSA', kid: config.syncJwtKeyId } };
    })();
    keyCache.set(cacheKey, cached);
  }
  return cached;
}

export async function powerSyncJwks(
  config: Pick<ServerConfig, 'syncJwtPrivateKeyB64Url' | 'syncJwtPublicKeyB64Url' | 'syncJwtKeyId'>,
) {
  const loaded = await keys(config);
  return { keys: [loaded.publicJwk] };
}

export async function issuePowerSyncJwt(
  config: Pick<ServerConfig,
    'syncJwtPrivateKeyB64Url' | 'syncJwtPublicKeyB64Url' | 'syncJwtKeyId' | 'syncJwtAudience' | 'syncJwtIssuer'
  >,
  userId: string,
) {
  const { privateKey } = await keys(config);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + POWERSYNC_JWT_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: config.syncJwtKeyId, typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.syncJwtIssuer)
    .setAudience(config.syncJwtAudience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}
