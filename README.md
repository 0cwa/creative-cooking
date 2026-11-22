# Creative Cooking

A local-first Expo / React Native cooking assistant built around the ingredients you already have and what you actually feel like eating.

## Getting started

1. Open [Creative Cooking](https://0cwa.github.io/creative-cooking/) and choose **Set up my kitchen**. The next screen prepares your privacy summary automatically. Read it and choose **Accept settings and open my kitchen**. There is no account, payment, or API key to set up. Nothing is accepted on your behalf, and reloading before acceptance returns you to the privacy check.
2. Add a few real ingredients in **Pantry**. A name is enough; quantities are not required. Stars describe how much you feel like eating an ingredient. Example chips only fill the input until you press **Add**.
3. Open **Recipes** to browse three built-in ideas without an account, provider key, or network connection. Previewing changes nothing. **Save a copy** adds a normal recipe you can edit, scale, and use to plan a shopping list. You can also add your own recipe.
4. On web, **Chef** currently saves private cooking notes by default. **Save note** does not request an AI reply. Cloud Chef requests remain disabled while disclosure storage is being verified; saving a cloud provider key does not enable them.
5. If you want to try the experimental on-device Chef in a compatible web browser, open **Local Chef settings**. Model downloads are explicit. The current local model provides text suggestions and cannot change Pantry or save recipes; it remains disabled when allergies are configured. Native Chef is not available yet. Settings puts this optional setup before **Household and advanced tools**. **Saved cloud connections** lets you manage existing credentials, but new cloud connections are unavailable while cloud replies are disabled.

Built-in recipes are starting points, not personalized or allergy-safe recommendations. They remain separate from saved recipes until you choose to save a copy. Pantry, saved recipes, and shopping work offline after the app is loaded; the PWA also caches previously visited routes for offline reopening.

### If your kitchen does not open

The app waits for your pantry, recipes, and preferences to load before showing editing controls. If opening fails, **Try again** reopens the same saved kitchen. It does not delete your data or create a replacement. Follow the message for blocked browser storage, insufficient space, or an unsupported browser; **Show technical details** contains the original error for troubleshooting. Use **Recover an existing kitchen** if you have an encrypted recovery archive. Household invitation rules are optional under **More setup options** and can be managed later in Settings.

## MVP

- Pantry powered by FlashList: manually add concise ingredient descriptions one at a time from a bottom composer, rate each 1–5 stars, swipe to remove; optional details such as `mint (dried)` or `okra (frozen)` stay plain text.
- Chef chat: pantry preferences, allergies, shopping willingness, portions, cooks, energy, optional city/time context.
- Chef can add/update/remove/rate pantry items and save structured recipes via tool calls.
- Saved recipe collection with offline starter ideas, recipe-like natural-text editing over structured data, safe portion scaling, and a shopping checklist that can add purchased ingredients back to Pantry.
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

The **First-use browser checks** PR workflow exercises new-kitchen setup, recovery from startup errors, shared start links, and Chef settings alongside the full CI suite. Its `first-use-browser-report` artifact includes the browser report, mobile setup screenshots, and failure traces. To run the same checks locally after exporting the app:

```bash
npx playwright test tests/first-use.spec.mjs tests/provider-settings.spec.mjs tests/chef-notes.spec.mjs --project=web
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
