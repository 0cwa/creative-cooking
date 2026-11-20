# Creative Cooking

A local-first Expo / React Native cooking assistant built around the ingredients you already have and what you actually feel like eating.

## MVP

- Pantry powered by FlashList: manually add concise ingredient descriptions one at a time from a bottom composer, rate each 1–5 stars, swipe to remove; optional details such as `mint (dried)` or `okra (frozen)` stay plain text, and bulk dictation goes through Chef.
- Chef chat: pantry preferences, allergies, shopping willingness, portions, cooks, energy, optional city/time context.
- Chef can add/update/remove/rate pantry items and save structured recipes via tool calls.
- Saved recipe collection with recipe-like natural-text editing over structured data, safe portion scaling, and a shopping checklist that can add purchased ingredients back to Pantry.
- OpenRouter OAuth PKCE plus direct BYOK connections for OpenAI, Anthropic, Gemini, and Mistral, all behind the same Chef provider interface.
- Installable GitHub Pages PWA with local-first app state.
- Experimental WebLLM local Chef on compatible WebGPU browsers, with explicit model download/cache/delete controls and no hidden model download from chat.
- CI, Gitleaks v3, and Pages deployment.

A simple ingredient name is always sufficient, while useful known details can stay inline as a short description, such as `mint (dried)`, `okra (frozen)`, or `fava beans (cooked, refrigerated)`. You do **not** have to maintain tags, quantities, or detailed inventory.

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

## Sharing a provider key

In Settings, a connected OpenRouter key can generate a friend link. On native builds it can be shared through the OS share sheet or copied directly. Generated links use a single `?ort=` query parameter. OpenRouter v1 keys currently use a 64-character hexadecimal body. The app removes the fixed `sk-or-v1-` prefix, packs the 64 hex characters into their 32 raw bytes, then base64url-encodes those bytes. That reduces the key body to 43 URL-safe characters while also hiding the obvious OpenRouter prefix. It is compact encoding/obfuscation, not encryption. The app captures and removes `?ort=` from the visible URL before the React bundle starts.

Anyone who has the complete link can use that API key, so treat it like a capability token. Prefer a dedicated OpenRouter key with a spending limit and revoke it when you no longer want the link to work.

For compatibility, manually constructed plain `?ort=sk-or-...` links are also accepted. Either form is a bearer capability: anyone with the link can recover/use the token, so a dedicated spending-limited key is recommended.

## Local data and backups

The Loro workspace stores pantry, recipes, shopping lists, and private notes on this device. On web it uses IndexedDB. On Android it uses SQLite. Verified household members can exchange encrypted updates. Settings also offers the available encrypted recovery controls.

The former PowerSync implementation lives on [`archive/powersync-2026-11-15`](https://github.com/0cwa/creative-cooking/tree/archive/powersync-2026-11-15). Starting Loro creates separate storage and leaves existing data alone. To read or export PowerSync data, use the archived build with the original browser origin or native application storage.

## Provider credentials

No project-owned LLM secret is committed or bundled. Users connect their own OpenRouter, OpenAI, Anthropic, Gemini, or Mistral credentials. Native builds store provider keys with Expo SecureStore. The web/PWA stores them in browser-local storage because browsers do not provide an equivalent native keychain. Provider credentials remain excluded from ordinary app backups.

## Project docs

- [Build plan](docs/BUILD_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Content sync, recovery, and support limits](docs/CONTENT-SYNC.md)
