# Scenario: one week, four equal adults

A bounded, seeded probe of policy tradeoffs, not of human behavior or cryptographic security.

**Actors (no owner):** Ana (phone, tablet), Ben (old phone), Chi (phone), Dee (laptop only). Relay R stores and forwards ciphertext; it is not a membership authority.

**Three acts kept distinct:** *invitation* (new adult, new epoch); *device replacement* (same adult, new device key, membership unchanged); *adult exclusion* (prospective epoch change only).

| t | Actor | Event |
|---|---|---|
| 1 | Ana | Adds "rice ×1" to shopping; edits recipe R1 |
| 2 | R | Link drops for Ben and Chi |
| 3 | Ben | Offline: edits R1, marks rice bought |
| 4 | Chi | Offline: marks rice bought |
| 5 | R | Reconnects; delivers t1–t4 reordered, t3 twice |
| 6 | Dee | Loses laptop |
| 7 | R, Ben | Relay outage; Ben unreachable |
| 8 | Dee | Requests recovery on a new device |
| 9 | Ana | Proposes excluding Ben (epoch e2) |
| 10 | Ben | Partitioned: proposes excluding Ana (epoch e2′) |
| 11 | R | Reconnects; two trust heads exist |
| 12 | Ben | May request voluntary rejoin |

## Variants (independent, each from the initial state)

**V1 Connectivity (t1–5).** Peers holding the same updates must reach identical state; no edit is hidden or dropped. Measure: superseded intents, time to agreement.

**V2 Duplicate purchase (t1, 3–5).** Compare: editable quantity; claim-before-buy; append-only purchase events corrected by compensating events. Measure: duplicate units, unmet units, reconciliation actions.

**V3 Lost device (t6–8).** Compare a printed recovery code against 2-of-3 guardians (the other three adults), thresholding key recovery only, never membership. Outage sets: relay down; Ben offline; *strategic move:* Chi withholds a share. The threshold never lowers silently; any change is a visible, voluntary reconfiguration event. Measure per outage set: recovery success, adults whose cooperation was needed, time Dee stays locked out.

**V4 Disputed membership (t9–12).** Compare proposal rules: one adult; two of the other three; all reachable adults. *Strategic move:* Ben repeats epoch proposals. Required behavior:

- Conflicting trust heads are shown, never auto-resolved.
- Edits under a disputed head are visibly quarantined, never deleted.
- Exclusion is prospective; old data stays readable to the excluded adult.
- Any adult may keep recipes and shopping data from the other branch while declining the membership merge.
- Rejoin is a fresh invitation both sides accept.

Measure: fork detection lag, member-minutes locked out, explicit merge choices, data retained after rejoin, spam proposals per honest action.

## Reporting

Per member and household, so an average cannot hide one locked-out adult. Same seed gives byte-identical output. No cohesion score. The cautiously general lesson is what one withholding or spamming adult can force under each policy.
