# Stabilization blockers — 2026-10-08

## Outcome

Full local regression suite: **59/59 PASS**, including all 24 Market smoke scripts. Previous baseline: 57/57; two additional smoke scripts cover identity review and deterministic ingest planning. No live database writes, deployment, cron activation, commit or push were performed.

## Catalog review and ingest

The original 163 findings are classified in `missing-catalog-identities-review.json` and `.md`: 127 TRUE_MISSING_PRINTING, 18 INVALID_SOURCE_RECORD, and 18 LEGACY_OR_SPECIAL_PRODUCT. Other categories contain zero findings. The 18 invalid records were `New` source labels incorrectly interpreted as Common rarity. The 18 special records require separate serialized Grand Master Rare review; they are not ordinary automatic repair candidates.

The user confirms incomplete YGOPRO API coverage as the reported origin. **Historical ROOT CAUSE NOT PROVEN**: the original import payload and execution log were not recovered. Current source contents cannot prove what the original import received. See `mamo-en013-root-cause.md` for the six historical questions and pipeline trace.

**INGEST BUG FIXED: YES, within reproduced scope**: resolver fallback, bounded processing without truncating observations, retryable missing lookups, and rejection of non-rarity source tags. The pure ingest planner is a dry-run administrative design, not a newly installed production importer. Tests cover MAMO 12/13/14, explicit aliases and variants, multiple rarities/sets, invalid fields, incremental replay, and the actual created-at cursor SQL in local PGlite.

The repair plan contains exactly 127 unapproved candidates: 37 rarity coverage gaps and 90 set-printing coverage gaps. These are observed gap groups, not proven historical causes. `catalog-repair-plan.json` defaults to dry-run, is non-executable, preserves existing identities, and excludes the 36 invalid/special records. No repair was executed.

## Migration convergence

See `migration-drift-report.md` and the audit JSON. The 116 mismatch entries classify as LOCAL_ONLY 0, LIVE_ONLY 20, SAME_CHANGE_DIFFERENT_HISTORY 15, OBSOLETE_LOCAL 1, MISSING_LOCAL_HISTORY 35, UNKNOWN 45. Entries can describe both sides of a matching change; counts are not counts of distinct changes. Exact text fingerprints preserve case and internal whitespace, normalizing only line endings and outer whitespace. Object-name matches alone do not prove equivalence.

The disposable fresh-migration probe first encountered unavailable platform Vault objects. With inert local Vault/Cron stubs, it reached `20260908154639_market_verified_blgg_metadata.sql` and failed with 42P01 because `public.card_printings` was absent. This demonstrates a missing application bootstrap prerequisite in that isolated migration-directory run, not a production database failure. Evidence: `audit-snapshots/stabilization-blockers-2026-10-08/fresh-migration-probe.json`.

Preserve live migration history. Reconstruct and verify bootstrap prerequisites in a disposable database, compare full schema definitions, then prepare a fresh forward reconciliation migration. Do not replay historical DDL or fabricate history records.

## Working tree and release gates

A HEAD archive and explicit selected-file tranche were prepared under `artifacts/stabilization-tranche-2026-10-08/`. The selection manifest is in the current audit folder. It excludes unrelated Market deployment and auth changes and selects only the PGlite dependency hunk rather than the entire dirty package manifest. It reuses installed dependencies; a clean dependency installation has not been verified.

**SAFE TO COMMIT ISOLATED TRANCHE: NO — verification incomplete.** The isolated suite and complete working-tree classification were not finished. After the 59/59 run completed, launching new shell commands failed twice with Windows `CreateProcessWithLogonW failed: 1909`. No isolated-test success or complete change inventory is claimed.

**SAFE TO COMMIT ENTIRE TREE: NO. SAFE TO DEPLOY: NO.** Remaining gates are isolated tranche verification, complete working-tree inventory, dependency/lockfile validation, migration convergence, reviewed repair decisions, and physical-device checks. Historical forensic attribution remains unproven and must not be presented as recovered evidence.

## Physical devices and test evidence

`real-device-stabilization-checklist.md` specifies Android Chrome/iPhone Safari scanner and guest collection checks, sampling, p50/p95 measurements, focus/light/foil/thermal observations and network/DOM/memory measurements. Physical tests were **NOT EXECUTED**; desktop regression results are not physical-device results.

Full suite evidence: `audit-snapshots/stabilization-blockers-2026-10-08/tests/test-results.json` and sibling logs. There were zero failures in this run. The separate isolated run remains pending.
