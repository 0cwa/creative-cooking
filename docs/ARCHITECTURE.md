# Architecture

Creative Cooking is a local-first cooking application with interchangeable AI engines. Domain state belongs to the application, not to the model.

## Layers

1. **Expo Router screens/components** — Pantry, Chef, Recipes, Settings.
2. **Domain/state** — pantry descriptions/preferences, structured recipes, the active Chef chat plus archived conversations, meal context, settings.
3. **Chef orchestration** — prompt/context compiler and a small typed tool set.
4. **LLM adapters** — OpenRouter plus direct OpenAI, Anthropic, Gemini, and Mistral BYOK adapters implement the same interface; future local providers use the same boundary.
5. **Storage adapters** — IndexedDB for ordinary web/PWA app state, AsyncStorage on native, and a separate credential vault for provider secrets.

## Pantry model

Only `name` and `preference` are required. The `name` field is intentionally a human-readable ingredient description, so relevant known qualifiers can remain inline (for example `mint (dried)`, `okra (frozen)`, or `fava beans (cooked, refrigerated)`) without adding a tag/category workflow. The application must not turn cooking into inventory management. Optional structured quantity/expiry metadata may be added later but must stay optional.

The Chef receives pantry names grouped as:

- Would like to eat — 5/5
- Would probably like eating — 4/5
- Open to eating — 3/5
- Probably don't want to eat — 2/5
- Don't want to eat — 1/5

## Tool boundary

The model proposes mutations; application code validates and executes them. The MVP tools are deliberately small:

- `pantry_add`
- `pantry_update`
- `pantry_remove`
- `pantry_set_preference`
- `recipe_save`
- `ask_user`

This keeps state integrity independent of provider/model quality.

Mutation tools also accept a `propose` flag. Proposed calls are intercepted by the shared tool executor before any state mutation, stored with the assistant chat message, and rendered as compact confirmation cards. Accepting a card replays the same validated tool call through the executor with proposal mode bypassed. `ToolExecutor.forceProposals` is reserved for a future user preference that can require confirmation for every mutation without changing provider adapters or individual tool schemas.

## Multiple-choice UX

`ask_user` ends the current model turn cleanly and renders an inline choice card. A tap becomes a new user turn. We do not keep a network inference request open while waiting for a person.

## Provider authentication

OpenRouter remains the default because its OAuth PKCE flow works from a static browser application, while direct OpenAI, Anthropic, Gemini, and Mistral BYOK connections are also available. Provider/model selection is ordinary app state, but provider credentials never enter the persisted domain-state object or backups. A centralized model registry describes tool calling, structured output, streaming, cloud/local status, and known free-tier status. Unknown model IDs remain usable without inventing capability claims.

On native, credentials use Expo SecureStore. On web there is no browser equivalent to a native keychain, so the credential vault uses browser-local storage; the UI and documentation must be explicit about that limitation.

## App-state persistence

On web/PWA, ordinary application state is stored in IndexedDB. On first load after the migration, the adapter imports the existing `creative-cooking-state-v1` value from the previous localStorage-backed AsyncStorage path, commits it to IndexedDB, and only then removes the legacy value. The migration is idempotent because IndexedDB is authoritative once a record exists. Native builds continue to use AsyncStorage.

Persistence failures are surfaced immediately and remain visible in Settings with a retry action; the app does not silently fall back to localStorage for ordinary state. Versioned JSON backup/restore remains independent of the storage backend. Web exports use browser downloads/file input; native builds write the same JSON envelope to a temporary file, share it through the OS share sheet, and restore through the system document picker. Provider credentials stay excluded on every platform.

## Static PWA / GitHub Pages

Production web export uses `EXPO_PUBLIC_BASE_URL=/creative-cooking`. `app/+html.tsx` links the manifest and registers a scoped service worker. The service worker caches the app shell and visited same-origin assets/routes, allowing pantry, recipes, settings, and previously loaded UI to remain useful offline. Cloud Chef requests still require connectivity unless a future local-model adapter is installed.

## Local models

Local inference is an adapter, not a separate app. The PWA has an explicit Experimental WebLLM provider gated by a usable WebGPU adapter, Web Workers, and browser-storage capacity. Model weights are never downloaded implicitly from Chef: Settings owns explicit download/cancel/delete controls, and the provider fails closed with a Settings recovery path if the browser cache is missing or has been evicted. The pinned WebLLM runtime uses a worker so inference does not block the UI; deleting the model also terminates the in-memory engine.

Small models should use a multi-stage pipeline rather than being trusted as a monolithic autonomous agent:

1. deterministic context compiler;
2. constrained planner / clarify decision;
3. creative candidate generation;
4. deterministic allergy and availability validation;
5. structured presentation and state mutations.

This makes future WebLLM, MLC, or LiteRT-LM work additive rather than architectural rewrites.
