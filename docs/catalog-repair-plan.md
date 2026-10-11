# Safe catalog repair plan

Generated locally. DRY RUN only; this script has no database connection or execution mode. Only TRUE_MISSING_PRINTING is admitted. Source snapshots and deterministic plan IDs make review repeatable.

| Observed gap (historical root cause not proven) | Count | Safe auto-repair? | Requires review? | Proposed mechanism |
|---|---:|---|---|---|
| RARITY_COVERAGE_GAP | 37 | NO | YES | Source-backed exact identity; reviewed variant; insert-only with unique-key conflict DO NOTHING |
| SET_PRINTING_COVERAGE_GAP | 90 | NO | YES | Source-backed exact identity; reviewed variant; insert-only with unique-key conflict DO NOTHING |

Grand Master Rare cases remain outside this plan: serialized/region/artwork handling requires an explicit policy. Non-rarity New records are rejected. No blind SQL INSERT batch is generated.

Future operator procedure after separate live authorization: take a baseline; approve individual plan IDs and exact variant/image evidence; re-read aliases and identity; run a bounded transaction using the actual unique identity key `(game,catalog_card_id,set_code,rarity,variant_id)`; audit source hash and inserted ID; skip existing rows without UPDATE; verify lookup/index propagation. Abort on source/schema mismatch. Replaying approved identities must produce zero inserts. No collection ownership/quantity writes.

The local PGlite regression exercises identity preservation and replay idempotency. It does not authorize production repair or prove artwork assignments.
