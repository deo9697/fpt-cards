# Stabilization tranche isolation and commit readiness — 2026-10-08

**ENVIRONMENT READY = YES. SAFE TO COMMIT STABILIZATION TRANCHE = NO. SAFE TO COMMIT ENTIRE WORKTREE = NO. SAFE TO DEPLOY = NO.**

The scope can be extracted from unrelated work, but the runtime catalog fallback introduces a reproduced false Common printing. This audit changes only local audit tooling/reports/artifacts, not application behavior. Nothing was staged or committed; no push, deployment, Supabase connection, data mutation or cron operation occurred.

## Environment and complete inventory

Git 2.45.1.windows.1 and Node v22.13.0 executed normally. Windows error 1909 did not recur. Git warned that the user-level ignore file was unreadable; repository status and diffs succeeded. No global configuration was changed. Inventory: **1255 files**, 21 tracked status entries and 1234 untracked files. These totals include each file in both disposable HEAD archives/workspaces, not just application changes.

- B. PREVIOUS_UNRELATED_WORK: 62
- A. STABILIZATION_TRANCHE: 16
- D. TEST_FIXTURE: 32
- E. BUILD_OR_TEMP_ARTIFACT: 1097
- C. GENERATED_REPORT: 48

Candidate commit set: **78 paths**, including 2 extracted package files and audit evidence. This is the proposed scope, not an approval. Full per-file status/classification/reason/keep/risk table: [inventory](stabilization-working-tree-inventory.md). Captured status, diffstat, name-status, diffcheck and last 15 commits are in artifacts/commit-readiness-2026-10-08/.

## Exact mixed-file extraction

- `package.json`: clean split by semantic hunk. Keep four Market test commands (`test:market-retention`, `test:market-feed-hardening`, `test:market-egress-rollout`, `test:market-retention-sql-sync`) and PGlite, pinned in the extracted candidate to `0.5.8`. Exclude User Edition/auth/pilot/security command additions. The extracted formatting is normalized JSON; root file is unchanged.
- `package-lock.json`: regenerate/select against that package, retaining the existing resolved dependency graph and changing root PGlite metadata to the exact pin. Offline lock-only npm validation passed. Root lockfile is unchanged. This is semantic extraction, not permission to stage the entire root file.
- Exact extracted package and lock are in `artifacts/commit-readiness-2026-10-08/workspace/`; `package-selected.diff` shows the package delta. No other selected source file mixes unrelated hunks. `sw.js` is excluded with the User Edition precache additions; production cache/version handling remains a deployment concern.

## Review findings

**Blocking NEW_REGRESSION — `js/cards.js:308`:** a source row with `set_rarity: "New"` and no cardinfo printings reaches `sanitizeYugiohRarity`, which maps the tag to Common. The new fallback then appends that invented rarity. The identical fully mocked input returned zero matches at HEAD and one Common printing in the candidate. Audit/repair planners reject New correctly, but those tests do not protect this runtime path. Evidence: [reproduction](audit-snapshots/commit-readiness-2026-10-08/catalog-new-repro.json). Required follow-up: reject non-rarity source tags in the fallback and verify incomplete-cardinfo plus New/Reprint cases without weakening existing legacy behavior unintentionally. No production fix was made during this audit.

| Area | Reviewed result |
|---|---|
| Market | Deployable wrapper has no remote import. Queue makes one private boolean probe with no feed download or acknowledgement. Daily is explicit; byte instrumentation and bulk single-attempt bounds remain. Snapshot INSERT uses mapping/day keys and ignore-duplicates. Other merge-duplicates calls concern mappings/variant metadata, not snapshot rows. |
| Catalog | MAMO 12/13/14 tests retained, row truncation removed, misses retryable, repair plan dry-run/non-executable. 127 candidates require review; New false positives excluded from plans and 18 Grand Master Rare excluded from ordinary repair. Runtime fallback blocker above remains. |
| Fast Scan | Exact/near/review smoke tests pass. Diagnostic classification does not change acceptance predicates. Existing candidate fan-out bounds remain; source-row processing is in batches of eight, with total work proportional to returned identities. Physical camera/network measurements are not claimed. |
| Shared Collection | Source arrays replaced on reload; selection stays in a separate Map. Cached sort/filter, delegated grid listeners and shared in-flight load pass selection/request/browser regressions. No mobile layout changes included. |
| Tests/tooling | PGlite tests execute synthetic SQL locally. The 59-suite runner is green but lacks the runtime New fallback case. Browser timing and CRLF-sensitive static regex are real test limitations. Some historical audit/benchmark tools assume Windows paths and dated evidence folders. |

## Validation

BASELINE = **59/59**. CURRENT WORKTREE = **59/59**, including **24/24 Market**. ISOLATED HEAD + SELECTED TRANCHE = initially **57/59**, then **59/59** after the two targeted checks below. All original first-run logs are retained. The newly discovered catalog reproduction is outside this suite and prevents a green readiness decision.

- Assisted browser: transient assertion failure; unchanged test passed on two reruns. Classified ENVIRONMENT_FAILURE/timing flake, not proven product regression.
- Market current-price static test: pre-existing regex only accepts LF. Archive extraction produced CRLF. Only the disposable SQL copy was normalized to LF; unchanged test then passed. Classified PRE_EXISTING test portability defect. Root SQL and test files were untouched.
- Root `git diff --check`, generated retention SQL check and exact Market rollout package/hash check: PASS. Retention SQL synchronization also passes in the isolated copy.
- Offline npm lock-only validation: PASS. A clean `npm ci` was not run; Node dependencies resolve from installed ancestor node_modules, with the browser SDK copied as a fixture. Do not represent this as clean-install verification.

Evidence: [validation JSON](audit-snapshots/commit-readiness-2026-10-08/validation.json); full run logs in `artifacts/commit-readiness-2026-10-08/{current-tests,isolated-tests}/`.

## Static hygiene and live/migration safety

No conflict markers, TODO/FIXME, debugger statements or embedded JWT/private-key patterns were found in the proposed file scan. Pattern absence is not a comprehensive secret audit. Console output is CLI reporting or retained Market telemetry; loopback URLs belong to local test harnesses. The sole raw GitHub URL is in the explicitly archived v2 rollback source, not the deployable wrapper. Windows paths occur in dated documentation and Git/Chrome test executables; browser tooling remains Windows-specific. No generated report is imported by production runtime. Tests intentionally consume catalog report fixtures.

No new automatic migration is selected, no historical migration is deleted or moved by this tranche, and no history ledger is modified. SQL under `supabase/manual/` stays manual; the obsolete rolling trigger source stays under `docs/archive/` and must not be reapplied. Queue RPC source/grants are represented locally in the manual package. Migration drift remains unresolved (45 UNKNOWN mismatch entries); a blanket db push is unsafe. This alone is not an automatic commit-time migration replay because no migration runner or automatic SQL was added.

Evidence labels: **VERIFIED REPO** = source diff and local tests from this audit. **LOCAL ONLY** = candidate fixes, isolated extraction, mock/PGlite tests and repair plan. **VERIFIED LIVE (historical)** = explicitly dated 5/8 October snapshots in earlier reports; no live state was refreshed here. **DISCUSSED ONLY** = user-reported historical YGOPRO API incompleteness and future repair/rollout steps; the original import payload remains unavailable. Older rollout docs describe earlier stages and are not instructions to resume deployment now.

## Exact proposed commit file list — BLOCKED

- `docs/archive/20261003203253_market_snapshot_storage_hardening.sql`
- `docs/audit-snapshots/commit-readiness-2026-10-08/catalog-new-repro.json`
- `docs/audit-snapshots/commit-readiness-2026-10-08/hygiene.json`
- `docs/audit-snapshots/commit-readiness-2026-10-08/inventory.json`
- `docs/audit-snapshots/commit-readiness-2026-10-08/proposed-manifest.json`
- `docs/audit-snapshots/commit-readiness-2026-10-08/validation.json`
- `docs/audit-snapshots/market-egress-2026-10-04/market-refresh-queue-cached-v2.ts`
- `docs/audit-snapshots/production-stabilization-2026-10-05/mamo-audit.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/mamo-source.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/fresh-migration-probe.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/ingest-live-functions.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/konami-facts.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/live-readonly.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/migration-drift.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/migration-text-hashes.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/related-db-identities.json`
- `docs/catalog-repair-plan.json`
- `docs/catalog-repair-plan.md`
- `docs/mamo-en013-root-cause.md`
- `docs/market-egress-live-rollout-2026-10-04.md`
- `docs/market-egress-rollout-operator-notes.md`
- `docs/market-feed-egress-2026-10-04.md`
- `docs/market-retention-append-only-2026-10-03.md`
- `docs/market-retention-egress-2026-10-03.md`
- `docs/migration-drift-report.md`
- `docs/missing-catalog-identities-review.json`
- `docs/missing-catalog-identities-review.md`
- `docs/production-baseline-2026-10-05.md`
- `docs/real-device-stabilization-checklist.md`
- `docs/stabilization-blockers-2026-10-08.md`
- `docs/stabilization-commit-readiness-2026-10-08.md`
- `docs/stabilization-working-tree-inventory.md`
- `js/cards.js`
- `js/collection-share.js`
- `js/fast-scan-core.js`
- `js/fast-scan.js`
- `package-lock.json` — EXTRACTED CONTENT ONLY
- `package.json` — EXTRACTED CONTENT ONLY
- `scripts/audit-stabilization-tranche.mjs`
- `scripts/build-catalog-repair-plan.mjs`
- `scripts/build-market-egress-rollout-package.mjs`
- `scripts/build-market-retention-sql.mjs`
- `scripts/build-migration-drift-report.mjs`
- `scripts/catalog-identities-review-smoke.mjs`
- `scripts/catalog-ingest-plan-smoke.mjs`
- `scripts/catalog-integrity-audit-smoke.mjs`
- `scripts/catalog-integrity-audit.mjs`
- `scripts/catalog-printing-completeness-smoke.mjs`
- `scripts/collection-routing-browser-smoke.mjs`
- `scripts/collection-share-bootstrap-guard-smoke.mjs`
- `scripts/collection-share-guest-smoke.mjs`
- `scripts/collection-share-performance-benchmark.mjs`
- `scripts/fast-scan-catalog-diagnostic-smoke.mjs`
- `scripts/fast-scan-milestone-smoke.mjs`
- `scripts/fixtures/fast-scan-stabilization-corpus.json`
- `scripts/lib/catalog-ingest-plan.mjs`
- `scripts/market-egress-rollout-smoke.mjs`
- `scripts/market-feed-egress-audit.sql`
- `scripts/market-feed-hardening-smoke.mjs`
- `scripts/market-snapshot-retention-dry-run.sql`
- `scripts/market-snapshot-retention-policy.sql`
- `scripts/market-snapshot-retention-smoke.mjs`
- `scripts/market-sync-egress-smoke.mjs`
- `scripts/market-watch-browser-smoke.mjs`
- `scripts/market-watch-loading-smoke.mjs`
- `scripts/probe-fresh-migrations.mjs`
- `scripts/production-stabilization-tests.mjs`
- `scripts/review-missing-catalog-identities.mjs`
- `supabase/config.toml`
- `supabase/functions/market-refresh-queue-cached/index.ts`
- `supabase/functions/market-sync/index.ts`
- `supabase/manual/market-append-only-restore.sql`
- `supabase/manual/market-egress-cron-rollout.sql`
- `supabase/manual/market-egress-live-verification.sql`
- `supabase/manual/market-egress-queue-canary.sql`
- `supabase/manual/market-egress-rollout-rollback.sql`
- `supabase/manual/market-feed-queue-probe.sql`
- `supabase/manual/market-snapshot-retention-design.sql`

## Files to exclude

Exclude every `artifacts/**` file, local `.claude/**` settings, raw HTML captures, transient logs, and all paths marked NO in the complete inventory. Explicit non-artifact exclusions:

- `app.js`
- `config.js`
- `js/api.js`
- `js/icons.js`
- `scripts/market-watch-core-smoke.mjs`
- `scripts/public-exposure-probe.mjs`
- `styles.css`
- `sw.js`
- `.claude/settings.local.json`
- `docs/audit-snapshots/gate-final-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/gate-pre-migs-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/gate3-post-teardown-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/gate3-pre-teardown-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/market-egress-2026-10-04/market-feed-cache-canary-v1.ts`
- `docs/audit-snapshots/market-egress-2026-10-04/market-sync-cache-canary-v1.ts`
- `docs/audit-snapshots/market-egress-live-rollout-2026-10-04/cron-before-tool-result.json`
- `docs/audit-snapshots/market-egress-live-rollout-2026-10-04/market-refresh-queue-cached-v2.ts`
- `docs/audit-snapshots/market-egress-live-rollout-2026-10-04/market-sync-v57.ts`
- `docs/audit-snapshots/post-migration-no-claim-fingerprints-2026-09-19.json`
- `docs/audit-snapshots/post-synthetic-pilot-teardown-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/pre-mig3-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/pre-migration-fingerprints-2026-09-19.json`
- `docs/audit-snapshots/pre-synthetic-pilot-check-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/baseline.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/catalog-alternate-artwork-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/catalog-integrity-audit-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/catalog-market-names-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/catalog-printing-completeness-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/catalog-repair-bootstrap-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-alias-build-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-detail-design-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-detail-price-lookup-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-editor-authoritative-printings-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-loans-2-1-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-milestone-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-routing-browser-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-search-browser-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-search-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-share-bootstrap-guard-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-share-guest-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-share-request-hardening-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-share-request-state-machine-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/collection-share-requests-state-machine-e2e-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/decks-milestone-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-artwork-variant-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-assisted-browser-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-benchmark-dataset-regression-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-catalog-diagnostic-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-events-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-milestone-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-ocr-confusions-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-ocr-pipeline-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-p0-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-save-hardening-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/fast-scan-telemetry-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/live-readonly.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/mamo-audit.csv`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-dashboard-movers-cutover-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-egress-rollout-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-feed-hardening-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-live-check.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-snapshot-retention-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-sync-egress-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-sync-live.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-admin-panel-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-backfill-panel-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-backfill-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-canary-poller-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-candidate-metadata-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-exact-price-shadow-panel-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-exact-price-shadow-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-mapping-source-check-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-resolver-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-variant-set-template-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-browser-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-bulk-confirm-aggregate-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-core-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-current-price-cutover-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-current-price-layer-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-loading-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-mw1-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-owned-page-query-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-watch-summary-perf-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/market-wrapper-live.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/pagination-p0-browser-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/pagination-p0-smoke.mjs.log`
- `docs/audit-snapshots/production-stabilization-2026-10-05/shared-performance.json`
- `docs/audit-snapshots/production-stabilization-2026-10-05/test-results.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/konami-mamo.html`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-alternate-artwork-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-identities-review-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-ingest-plan-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-integrity-audit-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-market-names-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-printing-completeness-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/catalog-repair-bootstrap-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-alias-build-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-detail-design-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-detail-price-lookup-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-editor-authoritative-printings-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-loans-2-1-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-milestone-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-routing-browser-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-search-browser-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-search-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-share-bootstrap-guard-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-share-guest-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-share-request-hardening-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-share-request-state-machine-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/collection-share-requests-state-machine-e2e-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/decks-milestone-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-artwork-variant-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-assisted-browser-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-benchmark-dataset-regression-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-catalog-diagnostic-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-events-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-milestone-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-ocr-confusions-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-ocr-pipeline-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-p0-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-save-hardening-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/fast-scan-telemetry-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-dashboard-movers-cutover-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-egress-rollout-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-feed-hardening-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-snapshot-retention-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-sync-egress-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-admin-panel-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-backfill-panel-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-backfill-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-canary-poller-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-candidate-metadata-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-exact-price-shadow-panel-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-exact-price-shadow-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-mapping-source-check-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-resolver-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-variant-set-template-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-browser-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-bulk-confirm-aggregate-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-core-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-current-price-cutover-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-current-price-layer-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-loading-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-mw1-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-owned-page-query-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/market-watch-summary-perf-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/pagination-p0-browser-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/pagination-p0-smoke.mjs.log`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tests/test-results.json`
- `docs/audit-snapshots/stabilization-blockers-2026-10-08/tranche-manifest.json`
- `docs/audit-snapshots/standalone-pre-migration-fingerprints-2026-09-21.json`
- `docs/audit-snapshots/ue-post-e2e-fingerprints-2026-09-20.json`
- `docs/audit-snapshots/ue-pre-e2e-fingerprints-2026-09-20.json`
- `docs/gate-migration3-auth-fallback-2026-09-20.md`
- `docs/pilot-final-gate-2026-09-20.md`
- `docs/pilot-gate-2026-09-20.md`
- `docs/pilot-phone-test-checklist.md`
- `docs/production-readiness-audit-2026-09-19.md`
- `docs/rpc-classification.md`
- `docs/standalone-data-ownership-phase-a-2026-09-21.md`
- `docs/standalone-data-ownership-plan.md`
- `docs/supabase-egress-audit-2026-09-26.md`
- `docs/synthetic-pilot-e2e-2026-09-20.md`
- `docs/user-architecture-phase1-2.md`
- `docs/user-edition-auth-mvp-2026-09-20.md`
- `js/identity.js`
- `js/user-edition.js`
- `scripts/.isolate-fast-scan.mjs`
- `scripts/auth-cross-user-gate.mjs`
- `scripts/client-security-scan.mjs`
- `scripts/fixtures/user-architecture-baseline.sql`
- `scripts/identity-compat-smoke.mjs`
- `scripts/pilot-account.mjs`
- `scripts/pilot-gate-sql-smoke.mjs`
- `scripts/prepare-stabilization-tranche.mjs`
- `scripts/production-baseline-audit.mjs`
- `scripts/rotate-push-secret.mjs`
- `scripts/rpc-classification-report.mjs`
- `scripts/standalone-gotrue-e2e.mjs`
- `scripts/standalone-sql-smoke.mjs`
- `scripts/user-architecture-sql-smoke.mjs`
- `scripts/user-edition-gotrue-e2e.mjs`
- `scripts/user-edition-mobile-emulation.mjs`
- `scripts/user-edition-smoke.mjs`
- `supabase/manual/legacy-migration-readiness.sql`
- `supabase/manual/retire-legacy-email-claim-trigger.sql`
- `supabase/migrations/20260919100000_user_architecture_profiles_teams.sql`
- `supabase/migrations/20260919110000_legacy_identity_link.sql`
- `supabase/migrations/20260919120000_session_member_auth_fallback.sql`
- `supabase/migrations/20260920100000_login_member_rate_limit.sql`
- `supabase/migrations/20260920110000_claim_disclosure_hardening.sql`
- `supabase/migrations/20260920120000_restrict_internal_rpc_privileges.sql`
- `supabase/migrations/20260921100000_standalone_shadow_identity.sql`
- `supabase/rollbacks/20260919100000_user_architecture_profiles_teams.down.sql`
- `supabase/rollbacks/20260919110000_legacy_identity_link.down.sql`
- `supabase/rollbacks/20260919120000_session_member_auth_fallback.down.sql`
- `supabase/rollbacks/20260920100000_login_member_rate_limit.down.sql`
- `supabase/rollbacks/20260920110000_claim_disclosure_hardening.down.sql`
- `supabase/rollbacks/20260920120000_restrict_internal_rpc_privileges.down.sql`
- `supabase/rollbacks/20260921100000_standalone_shadow_identity.down.sql`

## Commit proposal and remaining gates

Proposed message, only after blockers are resolved: `fix: stabilize market egress, catalog lookup and collection scanning`.

**SAFE TO COMMIT STABILIZATION TRANCHE = NO:** extraction is feasible, but the reproduced New-to-Common runtime regression requires a fix and regression coverage. Resolve/review test portability and complete clean dependency validation before treating the candidate as reproducible.

**SAFE TO COMMIT ENTIRE WORKTREE = NO:** unrelated auth/User Edition work and generated artifacts remain.

**SAFE TO DEPLOY = NO:** migration convergence, current live rollout re-verification, physical-device checks, explicit review of the 127 repair candidates, cache/version handling and unresolved runtime blocker remain. No production rollout is authorized by this audit.
