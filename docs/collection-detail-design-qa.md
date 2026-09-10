# Collection detail redesign verification

Reference: user-provided collection detail mockup (9 September 2026).
Scope: authenticated collection card detail, personal and team variants.

Implemented a portrait artwork stage using existing F.P.T background assets, gold serif card title, printing metadata badges, explicit availability, quantity counters and a printing-matched indicative price when already available in Market Watch. Existing loan, edit, delete, watch and team-owner actions are retained.

Validation passed:
- Chrome at 360, 390 and 1280 px: no horizontal overflow in the modal.
- Quantity counters and existing action identifiers.
- Offline, zero availability, unknown price and missing printing ID.
- Collection milestone, printing editor integrity and collection loans 2.1 regression suites (minimal window stub for browser-dependent imports in Node).
- JS syntax.

Visual capture uses the local F.P.T card as a deterministic fixture, with a long test card title. The production view uses each selected printing's actual image URL. Small screens scroll vertically; the close button remains in the sticky modal header.
No live collection mutation or production deployment performed.
