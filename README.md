# Creative Cooking

A local-first Expo / React Native cooking assistant built around the ingredients you already have and what you actually feel like eating.

## MVP

- Pantry powered by FlashList: paste/type/dictate simple ingredient names, rate each 1–5 stars, swipe to remove.
- Chef chat: pantry preferences, allergies, shopping willingness, portions, cooks, energy, optional city/time context.
- Chef can add/remove/rate pantry items and save structured recipes via tool calls.
- Saved recipe collection.
- OpenRouter OAuth PKCE on web/PWA plus API-key fallback.
- Installable GitHub Pages PWA with local-first app state.
- CI, Gitleaks v3, and Pages deployment.

Ingredient names are intentionally sufficient. You do **not** have to maintain quantities or detailed inventory.

## Development

Requires Node 22.13+.

```bash
npm install
npm run web
```

Type check and production export:

```bash
npm run check
```

For a local production-like GitHub Pages subpath build:

```bash
EXPO_PUBLIC_BASE_URL=/creative-cooking npm run build:web
```

## GitHub Pages

The production workflow builds the app at the project subpath `/creative-cooking` and deploys a PWA artifact.

One repository setting must be enabled once by a repository administrator:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Re-run **Deploy GitHub Pages** (or push any commit).

After that, production is served from `https://0cwa.github.io/creative-cooking/`.

The app manifest, 192/512 icons, service worker, and generated static navigation are all emitted with the correct project base path.

## Provider credentials

No project-owned LLM secret is committed or bundled. Users connect their own OpenRouter account/key. Native builds store the key with Expo SecureStore. The web/PWA stores it in browser-local storage because browsers do not provide an equivalent native keychain.

## Project docs

- [Build plan](docs/BUILD_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
