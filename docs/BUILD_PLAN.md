# Creative Cooking — step-by-step build plan

## Product rule: ingredient names are enough

The pantry is intentionally low-friction. A pantry item requires only a human-readable name, for example `onions`, `leeks`, or `carrots`. Users can paste or dictate a comma/newline-separated list. New items default to preference 3/5 (“Open to eating”). Quantity, unit, expiry, location, brand, and inventory counts are not required and must never block use of the app.

## Phase 1 — foundation and deployment

- [x] Use stable Expo SDK 57 + React Native + Expo Router + TypeScript.
- [x] Configure static web export for a GitHub Pages subpath.
- [x] Add installable PWA manifest and service worker.
- [x] Add CI for type checking and production web export.
- [x] Add Gitleaks v3 secret scanning.
- [x] Add GitHub Pages deployment workflow.
- [x] One-time repository admin setup: Settings → Pages → Source → GitHub Actions.
- [x] Keep application data local-first; no account required.
- [x] Keep provider credentials outside normal app state (SecureStore on native, browser-local credential vault on web).

## Phase 2 — pantry

- [x] FlashList ingredient list.
- [x] Add one ingredient or many names separated by commas/newlines/semicolons.
- [x] Default new ingredients to 3/5 preference.
- [x] 1–5 star preference editing.
- [x] Swipe left to remove plus an accessible visible remove action.
- [x] Persist pantry locally.
- [ ] Add optional bulk-edit/reorder tools only if real usage demonstrates need.

## Phase 3 — Chef

- [x] Chat interface with new-chat action.
- [x] Shopping / pantry-only toggle.
- [x] Meal context sheet: portions, number of cooks, per-cook energy.
- [x] Compile pantry into the five requested preference groups for every Chef turn.
- [x] Include allergies as hard constraints.
- [x] Optionally include local time/time zone and city.
- [x] Editable Chef system prompt plus non-editable app-level safety/tool contract.
- [x] OpenRouter provider adapter with tool calling.
- [x] Web/PWA OpenRouter OAuth PKCE and manual API key fallback.
- [x] Chef tools: pantry add/remove/preference, recipe save, inline multiple choice question.
- [ ] Streaming token rendering after core behavior is stable.
- [ ] Additional direct BYOK provider adapters (Gemini, Mistral, OpenAI, Anthropic) behind the same interface.

## Phase 4 — saved recipes

- [x] Structured recipe persistence rather than Markdown-only blobs.
- [x] Saved-recipe list and recipe detail view.
- [x] Delete saved recipe.
- [x] Chef can save recipes through a typed tool call.
- [ ] Add recipe editing and portion scaling.
- [ ] Add shopping-list generation from saved recipes.

## Phase 5 — local-model experiments

- [ ] Add a capability registry for local inference.
- [ ] PWA: WebLLM adapter behind an explicit Experimental setting and WebGPU/storage checks.
- [ ] Use worker/service-worker model lifecycle with recovery after browser worker eviction.
- [ ] Native: prototype Gemma 4 E2B-class models via LiteRT-LM and/or MLC runtime.
- [ ] Implement small-model pipeline: deterministic context compiler → low-temperature planner → creative candidate generator → deterministic allergy/constraint validator → presenter.
- [ ] Benchmark tool adherence, latency, peak RAM, battery usage, and recipe quality on representative phones before promoting local mode.

## Phase 6 — quality and hardening

- [ ] Unit tests for pantry parsing/grouping, tool payload validation, recipe persistence, and prompt compilation.
- [x] CI verifies TypeScript and the production static export; Gitleaks passes.
- [x] Inspect the generated Pages artifact for manifest, service worker, install icons, static routes, and correct `/creative-cooking` asset paths.
- [ ] End-to-end smoke test for Pages PWA installation and offline pantry/recipe access.
- [ ] Deterministic post-generation allergy validation against structured recipe ingredients.
- [ ] Accessibility pass: keyboard, screen reader labels, contrast, non-swipe deletion path.
- [ ] Provider error/retry UX and rate-limit messaging.
- [x] Data export/import and explicit local-data reset.
- [x] Request persistent browser storage and expose status/retry in Settings.
- [x] Encrypted OpenRouter friend links with ?ort= ciphertext and URL-fragment decryption key.
