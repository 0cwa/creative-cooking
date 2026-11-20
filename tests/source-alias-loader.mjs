import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context);

  const path = resolvePath(sourceRoot, specifier.slice(2));
  const source = [path, `${path}.ts`, `${path}.mjs`, `${path}.js`].find(existsSync) ?? path;
  return nextResolve(pathToFileURL(source).href, context);
}
