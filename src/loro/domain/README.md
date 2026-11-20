# Candidate cooking commands

`registry.mjs` validates versioned semantic commands, derives their exact Loro operations, checks domain references, and exposes `recipeIntentions` for review of concurrent field writes. Import must authenticate the envelope and author and compare decoded operations with the registry. Imported preconditions are evaluated at the authenticated update's Loro predecessor frontier; checking against the latest merged view would reject valid concurrent work. `OfflineRuntime` uses the selected-head storage read and retains the existing transactional authority and revision checks.

`acceptChef` loads the pending private proposal, invokes the application planner against the household projection, derives the household command, and binds both the proposal and exact effect in the private acceptance. It resolves a committed group before generating randomized ciphertext. The household command carries no proposal or chat text beyond content deliberately selected by the proposal's effect. Pantry proposals depend on the known pantry history that the planner inspects; unrelated recipe effects are not dependencies.

`replayAuthenticated` retrieves retained outbound and applied inbox envelopes from the runtime's storage, authenticates each against the selected authority, and verifies the command, operations and preconditions at the original update frontier. It requires complete retained envelope evidence, a trusted checkpoint with version 2 command identity markers, and at most 256 stored objects and 1 MiB of checkpoint and envelope bytes. Missing evidence fails closed. It reconstructs from fresh Loro peers without exporting original source history, retains original command and effect IDs, and returns excluded or dependent work as held records. The checkpoint is checked as a boundary, not copied into the result. Authentication and evidence retention are required; `replayCommands` rejects bare command records and `replayCommandsFixtureOnly` is solely for isolated tests. Compromise policy and handling held work remain the caller's responsibility. Older effect markers are unsupported and remain preserved in existing storage.

The browser proof can be run from the project root with `agent-heavy -- node src/loro/domain/browser-server.mjs`, then open port 19563 in an isolated browser and await `window.result`. It creates and deletes an isolated IndexedDB database. The Node suite is `agent-heavy -- node --experimental-strip-types --test src/loro/domain/*.test.mjs`.

## Shopping copies from a selected recipe

The selected catalog can supply a recipe child to `planShoppingAction`. A
linked item creation signs the recipe and ingredient IDs, derived child
document ID, observed child frontier, and exact governing effects. The
ingredient's name uses the same normalization as manual shopping entry. The
recipe model stores quantity and unit together as the amount string, which the
copy preserves in display quantity. The child proof uses the existing version 4
cooking envelope and a stricter command shape for selected recipes.

An import checks the copied values and field effects against the observed child
frontier. Each frontier point must end a retained, signed recipe command.
This allows a delayed shopping copy to arrive after a concurrent recipe edit.
Local planning uses the current child frontier. A changed child requires
replanning a new, unsaved action. A completed action retries using its original
signed bytes. The durable write rechecks the selected authority, child
revision, catalog creation record and signed source identities. Copied effects
contribute their disclosure policies and incomplete status, including when
later shopping commands depend on the copy. Missing predecessor objects leave
the original ciphertext staged for retry.

The proof establishes what the copied fields were at the signed observation.
There is no cross-document global clock that establishes which other remote
edits the author knew about. The shopping copy retains its own editable
display fields and immutable recipe and ingredient links.

### Current-only document-set admission

The explicit v5 path in `pairing/household-document-set.mjs` uses the
existing signed admission, quorum grant and per-device ceremonies. A source
observation binds the pinned head, original root, epoch, generation and
durable revisions of the root, catalog and children. Publication compares the
whole source again inside the write transaction. A removed recipe contributes
an opaque source commitment and receives no target document. The fresh root
keeps live shopping links and their policy provenance.

The publisher and each receiver atomically write the authority record, exact
catalog and snapshots, policy sidecars, and independently generated data keys
for the root and each child. The receiver opens only its signed packages and
stores a signed receipt for their exact order and content. The explicit
`document-set` route in `pairing/household-file.mjs` uses encrypted file
version 3. Its retry checks the complete retained set and reuses the sealed
bytes. The v1 through v4 projection manifests retain their original meanings.

### Remaining activation work

- Bind the complete document set and its selected revisions to signed authority
  and workspace selection. Update authority checkout and runtime resolution,
  web and native boot and the content hook's recipe create, list, edit,
  history, restore and shopping entry points together. The file route for
  selected children and linked copies is currently opt-in.
- Route invitation draft signing and review, transfer controls and joined
  enrollment to the explicit v5 path. Enable content opens and edits only
  after the runtime can load the installed catalog, per-document keys and
  projection provenance. Extend same-adult release to copy the complete set
  and the histories available to that adult.
- Extend rotation, revocation, compromise review and recovery to bind source
  and target document sets and their selected revisions. Retain pending inbox
  originals, earlier generations and competing effects for review or semantic
  rebase. A child must never become visible ahead of the authority and document
  set that selects it.
- Qualify the activated routes in independent built app contexts and on
  Android and iOS, including file and encrypted device exchange, source
  reordering and durable write faults.
