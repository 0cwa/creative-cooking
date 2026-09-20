# Architecture

Creative Cooking is a local-first cooking application with interchangeable AI engines. Domain state belongs to the application, not to the model.

## Layers

1. **Expo Router screens/components** — Pantry, Chef, Recipes, Settings.
2. **Domain/state** — pantry names/preferences, structured recipes, chat messages, meal context, settings.
3. **Chef orchestration** — prompt/context compiler and a small typed tool set.
4. **LLM adapters** — currently OpenRouter; future cloud/local providers implement the same interface.
5. **Storage adapters** — AsyncStorage for ordinary app state; credential vault for provider secrets.

## Pantry model

Only `name` and `preference` are required. The application must not turn cooking into inventory management. Optional quantity/expiry metadata may be added later but must stay optional.

The Chef receives pantry names grouped as:

- Would like to eat — 5/5
- Would probably like eating — 4/5
- Open to eating — 3/5
- Probably don't want to eat — 2/5
- Don't want to eat — 1/5

## Tool boundary

The model proposes mutations; application code validates and executes them. The MVP tools are deliberately small:

- `pantry_add`
- `pantry_remove`
- `pantry_set_preference`
- `recipe_save`
- `ask_user`

This keeps state integrity independent of provider/model quality.

## Multiple-choice UX

`ask_user` ends the current model turn cleanly and renders an inline choice card. A tap becomes a new user turn. We do not keep a network inference request open while waiting for a person.

## Provider authentication

The primary MVP provider is OpenRouter because its OAuth PKCE flow works from a static browser application and returns a user-controlled API key. Manual OpenRouter API-key entry is also supported. Provider credentials never enter the persisted domain-state object.

On native, credentials use Expo SecureStore. On web there is no browser equivalent to a native keychain, so the credential vault uses browser-local storage; the UI and documentation must be explicit about that limitation.

## Static PWA / GitHub Pages

Production web export uses `EXPO_PUBLIC_BASE_URL=/creative-cooking`. `app/+html.tsx` links the manifest and registers a scoped service worker. The service worker caches the app shell and visited same-origin assets/routes, allowing pantry, recipes, settings, and previously loaded UI to remain useful offline. Cloud Chef requests still require connectivity unless a future local-model adapter is installed.

## Local models

Local inference is an adapter, not a separate app. Small models should use a multi-stage pipeline rather than being trusted as a monolithic autonomous agent:

1. deterministic context compiler;
2. constrained planner / clarify decision;
3. creative candidate generation;
4. deterministic allergy and availability validation;
5. structured presentation and state mutations.

This makes future WebLLM, MLC, or LiteRT-LM work additive rather than architectural rewrites.
