# Shopping for several households: UX plan

The proposed experience lets someone shop for Home and Parents in one trip while keeping ownership, quantities and cooking requirements clear. Checking Parents’ milk must never change who Chef is cooking for. The combined view is a view over selected lists, not a merged household or a shared document.

## Starting point and next boundary

The local foundation currently has a personal list, one list per household, local creation/switching, selected recipe snapshots and household requirements. `shopping.tsx` shows the selected list, sorts checked items last and offers “Put in Pantry”; `households.tsx` combines list switching, creation, requirements and recipe copies. It truthfully says “On this device.” `activeHouseholdId` currently controls both Shopping and Chef. The Automerge repository is a separate tested package, not yet the app’s production state backend; invitations and remote sync are absent.

Before combined errands, split **shopping selection** from **cooking context**. Use separate state: selected shopping list IDs for the current trip, and the persistent household Chef is cooking for. Opening or checking any shopping list must preserve cooking context. Combined selection may be remembered locally for convenience but has no permissions or membership effect. Changing it does not publish a new household. An initial single-list release can retain current functionality while establishing this split.

## Navigation and information hierarchy

Keep Shopping as a primary tab. Its header contains one scope control, “Home ▾” or “Home + Parents ▾”, with a secondary status line. A compact summary says “7 to pick up · 2 lists”; use “items” rather than total quantities when units are unknown. Default to household sections with remaining items first and checked items in a collapsed, reachable “Picked up (3)” section. The composer remains anchored above the keyboard and tab bar. Avoid jumping rows under someone’s finger when they check items: show the check immediately, then move it after interaction/focus ends, and offer Undo.

Scope opens a bottom sheet with Personal, Home and Parents as single-list choices, followed by “Combine lists for a trip.” The combined mode has checkboxes and an explicit “Use these lists” button. Show list counts and unavailable/read-only status. A footer links to “Manage households,” where creation, invitations, members, requirements and leave actions belong. Shopping should not require scrolling past requirements or recipes to switch a list. Wider screens can retain the same labels in a sidebar; desktop does not need a different ownership model.

Every row carries a text scope badge, including single-list screens, because rows can survive filtering, search and future bundling. Duplicate household names need a user-selected short label or disambiguator in the picker and badges. A personal item reads “Personal.” Pressing the checkbox changes only that row’s source item. Pressing item text opens details/edit; the overflow menu contains Remove and later Move/copy with explicit destinations. Checking and editing use distinct accessible targets. Removal has Undo when the original scope remains writable; incompatible recovery must explain why it could not restore.

### Wireframe 1: combined trip, default grouped view

```text
Shopping                         [Settings]
[ Home + Parents ▾ ]
On this device · 7 to pick up · 2 lists

HOME                                4 left
[ ] 2 lemons                 [Home]   [⋯]
[ ] oat milk, unsweetened     [Home]   [⋯]
    No dairy · item note

PARENTS                             3 left
[ ] 1 litre milk          [Parents]   [⋯]
[ ] 4 lemons              [Parents]   [⋯]

[ Picked up (3) ▾ ]
────────────────────────────────────────
Add to [Home ▾]
[ e.g. bread                    ] [Add]
```

The combined composer always names one destination; it never adds to all selected lists. Choose the last explicitly used writable destination for this trip, show it visibly, and require selection if it disappeared. With only read-only lists selected, hide the writable composer and explain “You can view these lists. Ask a household editor to make changes.” Filtering and grouping are view preferences, independent of the cooking context.

## Convenient duplicates without ambiguous purchases

Offer “Group similar items” as a later, optional display setting. The first combined version simply shows each household’s rows; this is understandable and cheaper to validate. A bundle is visual only: stable source identities remain `(scopeId, itemId)`, and list edits/checks still target those identities. Checking Home’s lemons does not check Parents’ lemons.

Grouping suggestions should require matching normalized ingredient, qualifiers and compatible explicit units. Preserve the original text and amounts. Do not combine milk with oat milk, peanut-free bread with ordinary bread, or “2 tins tomatoes” with “500 g tomatoes.” Free-text ingredient descriptions and unrecognized units stay separate. Requirements can add “Check ingredients: Home avoids peanuts” as context, without claiming that a matching label guarantees safety. A household-level diet is contextual; it must not silently rewrite a shopping item.

### Wireframe 2: deliberate fulfillment of compatible duplicates

```text
Lemons                         6 total
2 households · separate list entries

[✓] Home                         2 lemons
[ ] Parents                      4 lemons

[Mark remaining listed amounts picked up]
Marks Parents’ 4 lemons. Home is already checked.
[Close]
```

A bundle has no ordinary checkbox; show “1 of 2 entries picked up.” Each source entry can be checked individually without review. A batch action is explicitly labeled with the represented amounts and selected scopes; confirmation is only needed when meaning is unclear. When amounts are missing or incompatible, omit the total and batch fulfillment: “Amounts differ — check each list entry.” Partial quantities require a separate future quantity model; checking an entry means its listed request is fulfilled, not that an inferred fraction was purchased. No automatic unit conversion or inventory accounting is needed for this release.

## Pantry, recipes and cooking remain deliberate

Replace the combined purchased bar’s blanket “Put in Pantry” with “Finish shopping.” Its sheet lists checked entries by source, offers “Clear from their shopping lists,” and separately offers optional “Add selected items to my Pantry.” Default Pantry selection should include personal entries only; Home/Parents entries are unchecked until deliberately selected. The destination is always **My Pantry** in this release; there is no shared Pantry. Show the consequence: “Add 2 selected items to your Pantry and clear 3 checked entries from their lists.” A user can clear Parents’ fulfilled list without claiming those ingredients arrived in their own kitchen. Disabling or rejecting one scope must not undo another scope’s successful action; report per-scope outcome and leave failed entries visible.

Recipe cards use “Copy to household…” with a destination preview and the explanation “An independent copy; personal notes stay private.” Copies preserve ingredients and method, not personal notes or shopping flags. Source edits do not refresh them. “Add ingredients to shopping” always names a destination; in a combined trip it offers the visible list choices but preselects only a meaningful existing destination. Adding a recipe’s ingredients must not switch cooking context.

### Wireframe 3: Chef context stays explicit

```text
Chef
Cooking for [Home ▾]
Vegan · Avoid peanuts · + your personal allergies
[Add a guest for this meal]                 (later)

What would you like to cook?
[ Something quick with lentils            ]

Shopping trip: Home + Parents              [Open]
```

“Cooking for” is the sole persistent household-context control. Its summary identifies household requirements and opted-in personal constraints before a request; expanded details explain cloud-provider disclosure. Temporary guest requirements are a future meal-specific overlay, visibly removable and not written into either household by default. Shopping badges may display source-relevant requirement warnings, but the combined trip never unions all selected households into Chef. Imported or edited recipes are checked against the selected cooking context, with concrete ingredient matches and uncertainty rather than a safety certification.

## Status, edge cases and accessibility

| Situation | Behavior and copy |
| --- | --- |
| Current local foundation | “On this device.” No “Synced,” member presence or remote delivery indicators. |
| Future local commit, offline | “Saved on this device · Waiting to send.” Editing/checkoff stays available. A failed local write instead says “Not saved — retry”; never imply it is queued durably. |
| Future transport receipt | “Saved to relay” only after durable authorized receipt. “Up to date” requires catch-up through the observed server cursor and an empty local outbox; it does not assert every offline member has received changes. Explain details on tap, not in every row. |
| Lists not loaded | Preserve header and scope; “Loading Home…” for that section. Never render unloaded data as an empty list. Cached authorized data can remain usable within the chosen security policy. |
| Empty combined selection | “Choose lists for this trip.” The picker offers Personal and available households. |
| All selected lists empty | “Nothing to pick up in Home or Parents.” Keep destination composer available; do not promote a new household setup flow. |
| Detected removal/access loss | Remove that scope from normal combined editing; explain “Access to Parents has ended.” Preserve any unsent work in a private recovery view where policy permits, with explicit export/copy rather than resend. Do not claim offline clients instantly learn revocation or previously received copies vanish. |
| Last selected household left | Return shopping selection to Personal with a brief notice. Resolve cooking context separately and visibly if it was that household; require a valid context before a new Chef request. |
| Conflicting text edits | Inline “Two versions of this item” opens originals with scope visible. Compatible independent checkoffs merge quietly; the chosen check/uncheck policy needs engine evidence. No mandatory review for all routine edits. |

Targets are at least 44 × 44 logical pixels, with adequate spacing; badges and status use words plus icons, never color alone. Meet WCAG AA text contrast, support large text without truncating household/ingredient qualifiers, and preserve a keyboard-visible composer. Screen-reader labels include “2 lemons, Home, not picked up”; headings identify groups and collapsed purchased state. Announce the user’s result briefly, throttle background announcements, and retain focus when checked rows move. Keyboard users can open the picker, choose scopes, check/edit rows and dismiss sheets without a pointer. Virtualized rows use stable scope-plus-item IDs; never key by position, amount or bundled label.

## Delivery and acceptance

1. **Scope separation and single-list polish:** preserve cooking context when changing Shopping; row badges, explicit Pantry destination and accessible item actions. Verify Home→Parents shopping switch leaves Chef Home, including reload; Personal data and household payloads remain separated.
2. **Combined trip:** multi-select scope sheet, grouped rows, explicit add destination, clear/pantry selection and unavailable-scope handling. Verify two household entries named lemons remain separate; check Home without modifying Parents; add only to the shown destination; finish Parents’ shopping without adding to personal Pantry. Reload restores trip choices independently from cooking context.
3. **Synchronization integration, after the key/transport decision:** implement honest durability states, blocked access and per-scope failures. Test offline checkoff/restart/reconnect, missing local storage, rejected writes, late revocation and one unavailable household while another succeeds. Two users resolve a genuine text conflict without losing either original.
4. **Optional bundle convenience:** add only after the grouped trip is usable. Test compatible 2+4 lemons, milk/oat milk exclusion, incompatible units, missing quantities, duplicate household names and screen-reader focus. One bundle action must enumerate the exact source entries it fulfills.

A short observed walkthrough should ask a person to shop for Home and Parents, buy only Home’s lemons, clear Parents’ milk without adding it to their own Pantry, and then ask Chef for a Home dinner. Success means they predict each edit’s audience and the cooking requirements without inspecting Settings. The first three stages deliver the requested experience; bundling, guest overlays, named multiple lists per household, calendar planning and shared inventory can wait.
