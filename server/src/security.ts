import { createHmac, randomBytes } from 'node:crypto';
import argon2, { type HashOptions } from 'argon2';

const passwordOptions: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

let dummyHash: Promise<string> | undefined;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, passwordOptions);
}

export async function verifyPassword(hash: string | undefined, password: string): Promise<boolean> {
  if (hash) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await argon2.verify(await dummyHash, password);
  return false;
}
