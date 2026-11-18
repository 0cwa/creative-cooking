# PWA, offline, and accessibility release checklist

Run this checklist after `npm run check` passes and before a release that changes navigation, storage, the service worker, or core interaction UI.

## Automated gate

CI must pass all of the following:

- unit tests for pantry parsing/grouping, Chef prompt compilation, structured tool payload normalization, allergy validation, backup format migration/round-trips, OpenRouter share payload round-trips, and streaming SSE/tool-call assembly;
- Loro contracts and focused Node tests for local storage, cooking edits, authority, encrypted exchange, disclosure, and recovery through `npm test`
- TypeScript type checking;
- production web export with `EXPO_PUBLIC_BASE_URL=/creative-cooking`;
- exported-PWA smoke verification for the manifest, 192/512 icons, scoped service-worker registration, navigation fallback behavior, and Pantry/Chef/Recipes/Settings static routes;
- a Chromium E2E that adds pantry state, visits Recipes, switches offline, and reloads both routes through the service worker;
- Chromium Loro tests for the fresh workspace, household admission and selection, encrypted file exchange, shopping, identity, and recovery through `npm run test:e2e`
- Gitleaks.

Run just the Loro Node checks with `npm run test:loro`. To run the Loro Chromium checks locally, install Chromium with `npx playwright install chromium`, export with `EXPO_PUBLIC_BASE_URL=/creative-cooking npm run build:web`, then run `npm run test:e2e -- loro-`. Playwright starts the app export and an isolated admission fixture on loopback. Set `TEST_WEB_PORT` if the app port is already occupied.

Run the bootstrap comparison with a bundle and an isolated browser CDP endpoint. Run the RTC and file integration proofs with their own harness and isolated profiles. [Bootstrap comparison](../tests/loro/bootstrap-proof/README.md) · [RTC and file integration](../tests/loro/integration/README.md)

Some supplemental Node proofs require scratch directories for on-disk reopen and rollback checks. The guardian, recovery, and native bootstrap tests that call for a directory use `GUARDIAN_TEST_DIR`, `RECOVERY_TEST_DIR`, and `NATIVE_PROOF_DIR`, respectively. Native persistence, transport interoperability, permissions, and recovery require hardware verification. [Android and iOS device checks](plans/LORO-RELAY-IMPLEMENTATION.md#phases-and-acceptance-gates)

## Install and offline smoke

Use a clean Chromium profile or an incognito-style test profile that permits PWA installation.

1. Open the deployed GitHub Pages app while online and install it as a PWA.
2. Add at least two pantry ingredients with different preference ratings.
3. Ensure at least one saved recipe exists, then open its detail view once while online.
4. Open Pantry, Chef, Recipes, and Settings once so their route assets are visited.
5. In browser devtools, set the network to **Offline**.
6. Fully reload the installed PWA on Pantry. Confirm the app shell loads and the pantry data is still present.
7. Open Recipes and confirm the saved recipe list/detail remains available.
8. Open Settings and confirm local settings render and can be changed.
9. Open Chef and submit a request. Confirm the UI remains usable and reports the network/provider failure instead of losing local data or hanging.
10. Restore networking, reload once, and confirm the app recovers normally.

If an offline route falls back to the root shell, confirm Expo Router resolves the intended screen after hydration. A blank page, uncaught error, missing navigation chrome, or lost local data is a release blocker.

## Keyboard-only pass

On web, disconnect the mouse/trackpad for the pass.

- Tab through Pantry. Settings, ingredient preference controls, visible Remove actions, the ingredient input, and Add must all be reachable.
- In Chef, reach Previous chats, New chat, Settings, conversation rows and their visible Delete actions, meal-context controls, question choices, the composer, Send/Stop, Retry, and any Settings recovery action.
- In Recipes, each recipe card, Close, and Delete must be reachable and activatable.
- In Settings, Back, allergy add/remove controls, switches, backup actions, provider actions, and form fields must have visible focus and keyboard activation.
- In Meal context, Done, counters, and every energy choice must be reachable and operable.
- No essential action may require a swipe gesture.

## Screen-reader pass

Use VoiceOver, NVDA, TalkBack, or another platform screen reader.

- Icon-only controls announce their purpose rather than only a glyph.
- Preference stars announce the target rating and selected state.
- Shopping/pantry mode and cook-energy choices announce their selected state.
- Remove-allergy and remove-pantry controls include the item name.
- Recipe cards announce the recipe title and that they are actionable.
- Streaming/error status changes are announced without repeatedly reading the entire conversation.
- Form fields have meaningful labels (ingredient, city, API key, model, system prompt, etc.).

## Reduced width and large text

Test at approximately a 320 CSS-pixel viewport and at 200% browser text zoom / large accessibility font size.

- Headers remain readable without covering settings/back controls.
- Bottom composers retain usable input and Send/Add controls.
- Settings inline fields/buttons wrap instead of clipping horizontally.
- Recipe titles, ingredient lines, and method steps wrap without truncating essential content.
- Meal-context counters and energy choices wrap and remain tappable.
- No critical control is pushed permanently off-screen.

Record device/browser/screen-reader details with the release notes when a release materially changes these surfaces.
