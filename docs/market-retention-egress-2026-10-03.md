# FPT Cards — repository retention alignment and cleanup gate

> SUPERSEDED for implementation and cleanup policy by `market-retention-append-only-2026-10-03.md`.
> This file records the failed rolling strategy audit. Its rollout, file paths and test outcomes are historical, not current instructions.

**SAFE TO APPLY CLEANUP = NO.** Repository aligned with the *described* live storage policy. Full definition of done is NOT satisfied: three reproducible safety blockers remain. No live connection, migration application, cleanup, deployment, secret change, Vercel action, commit or push was performed.

## 1. Initial audit (before edits)

The working tree was already dirty. In `supabase/functions/market-sync/index.ts`, the only pre-existing diff was the priority queue server-side filter and `rpcPages` query parameter support documented in `docs/supabase-egress-audit-2026-09-26.md`. These changes are compatible and preserved. Other pre-existing changes in app/config/API/styles/auth and untracked migrations were preserved. There was no equivalent retention split or migration `20261003203253` in the repository. No conflicting retention implementation was overwritten.

Live v56 and migration status are user-provided facts, not independently reverified. This work implements the specified behavior; it does not claim a byte-for-byte match with unavailable live source.

| Writer / lifecycle path | Repository implementation | Finding |
| --- | --- | --- |
| Snapshot ingestion | `supabase/functions/market-sync/index.ts`, `syncProvider` | Only application ingestion writer found; old path inserted every metric with daily keys, 250-row batches and ignore-duplicates. |
| Anomaly flag | `supabase-market-watch-price-anomaly-detection.sql`, `trg_flag_price_anomaly` | BEFORE INSERT; compares previous price for printing/provider/type, flags >5x or <0.1x. |
| Manual confirmation | Same file, `confirm_market_price_anomaly` | Updates only `is_anomalous=false`; retains snapshot identity. |
| Current projection | `20260914200000_market_current_price_layer.sql` | AFTER INSERT sync; dedicated AFTER UPDATE OF is_anomalous handles promotion/rebuild. No value-update trigger before this task. |
| Event ingestion | `supabase-milestone-5-market-watch.sql`, `detect_market_price_event` | AFTER INSERT only; references two snapshots and stores price scalars. |

Readers were assessed using the latest definitions available in migrations plus the earlier root SQL files. Root SQL files are not one ordered migration chain; the installed live function definitions must still be checked before cleanup.

| Real reader | Source and dependency |
| --- | --- |
| `list_market_price_history` | `supabase-milestone-5-1-market-watch-operational.sql`; derived view; explicitly only Cardmarket/trend and CardTrader/reference, UTC daily distinct, requested 1–365-day range. |
| `list_market_watch_owned_page` | `20260914210000_market_watch_current_price_cutover.sql`; current layer for present prices, snapshots for 24h/7d/30d and change sorting. Historical fallback selection is NOT restricted to retained types. |
| `list_market_watch_extra` | Same migration; current layer for present, snapshots for historical deltas; unpaginated deck/manual list. |
| `get_market_watch_summary` | Same migration; current layer for present portfolio/floor, not full price history. |
| `list_market_watch` | `20260908204855_market_watch_snapshot_reuse.sql`; retained legacy RPC reads snapshots for current and historical values. Frontend API has cut over to split RPCs, but legacy SQL remains callable. |
| `market_active_price_snapshots`, `market_derived_price_snapshots`, `market_latest_prices` | Root MW1/anomaly SQL; views still read snapshots. Mapping status and anomalies control eligibility. |
| `list_collection_share_requests` | `supabase-collection-share-requests-optimize.sql`; latest-prices view for prices. |
| `ygo_market_variant_legacy_reference_prices` | `20260912180000_ygo_market_variant_exact_price_shadow.sql`; active snapshot view, called by exact-price shadow workflow. |
| `list_market_price_anomalies` | Anomaly SQL; all flagged snapshots, including non-history metrics. |
| Current rebuild/backfill/shadow report | `20260914200000_market_current_price_layer.sql`; snapshots provide fallback and comparison data. |
| `list_market_dashboard_movers` | `20260916100000_market_dashboard_movers_current_price_cutover.sql`; current layer, 48h freshness and LIMIT 3; not a full history download. |
| `get_market_watch_item_price` | `20260917140000_market_watch_single_printing_price.sql`; one-printing current lookup. |
| `run_market_alert_scan` | `supabase-market-alert-scan.sql`; consumes latest event per watched printing, indirectly depends on event generation and event survival. |

Deletion hazards: `market_current_price_snapshots.snapshot_id` and both `market_price_events` snapshot FKs use **ON DELETE CASCADE**. Removing snapshots can remove the current projection or events and change alerts. Logical dependencies also include anomaly review, current fallback/rebuild, latest-price legacy readers and fallback historical deltas where trend/reference is absent. No other snapshot FK was found in repository SQL; the dry run inventories actual installed FKs and blocks unknown ones conservatively.

CardTrader's real provider is already decommissioned. Its reference retention compatibility does not re-enable fetching or change mapping activation. Foil metric names, including `foil_trend`, belong to rolling storage under the exact requested policy.

## 2. Files changed by this task

- `supabase/functions/market-sync/index.ts`: split snapshot writes only; preserved existing egress patch.
- `supabase/migrations/20261003203253_market_snapshot_storage_hardening.sql`: value-update trigger calling existing sync; separate anomaly lifecycle unchanged; revoke PUBLIC/anon/authenticated; schema reload notification.
- `scripts/market-snapshot-retention-smoke.mjs`: actual worker VM plus real PostgreSQL SQL execution through installed PGlite, entirely offline.
- `scripts/market-snapshot-retention-dry-run.sql`: read-only dependency inventory and aggregated classification.
- `scripts/market-watch-core-smoke.mjs`: obsolete `pendingSnapshots` assertion updated to both batches; removed blanket rejection of the word CardTrader, retaining a check that its provider/API is not restored.
- `package.json`: two test commands added, preserving existing local edits.
- This report.

## 3. Retention policy and expected growth

Cardmarket/trend and CardTrader/reference retain `<mapping_id>:YYYY-MM-DD`, ignore duplicates and keep multiple days. All other metrics use `<mapping_id>:current` with merge-duplicates. Conflict identity remains `(provider, observation_key, price_type)`; distinct metrics/mappings remain isolated. Both streams keep batches of 250. Return counts remain attempted snapshot observations, NOT newly inserted rows, just as before. Failure propagation/logging, mapping resolver, queue clearing and Variant Registry are unchanged.

Existing daily non-history rows are NOT rewritten or removed. First sync adds rolling rows, then later syncs update those rows. With one Cardmarket mapping per 3,117 printings and six metrics, illustrative steady-state new rows fall from roughly 18,651/day to roughly 3,117/day (~83% less); variants, missing metrics and providers make the actual number different. This is a scenario based on the user's counts, not a live measurement. UPDATE still produces PostgreSQL row versions/WAL; bounded logical row count is not a guarantee of fixed physical disk usage or reduced API egress by the same percentage.

## 4. Reproduced regressions / safety blockers

1. **Anomaly detection on rolling conflict is lost.** BEFORE INSERT can set `NEW.is_anomalous`, but PostgREST-style upsert updates only the submitted fields. The payload does not include `is_anomalous`/`anomaly_ratio`; the existing row keeps its previous flag. In the SQL test low 10 -> 100 becomes current without being flagged. Already-flagged rows remain excluded, and manual confirmation still works, but that does not fix new rolling anomaly detection. Future fix requires a reviewed UPDATE-aware detector comparing OLD vs NEW, with reset/confirmation semantics; simply sending false from the client would be unsafe.
2. **Rolling UPDATE creates no events.** Existing AFTER INSERT event trigger does not run for conflict UPDATE. Trend daily events continue. Alert scanning can consequently miss low/average/foil changes. Also, an event created when a rolling row was first inserted retains frozen scalar prices while its snapshot pointer later resolves to a different price; reproduced with average 12 -> 13. Future decision: restrict event semantics explicitly to retained series, or design immutable event observations with an UPDATE-aware event path. Adding an UPDATE trigger blindly is insufficient because snapshot-pair identity no longer models repeated updates.
3. **Same captured_at / same snapshot ID does not refresh current values.** Existing sync accepts a newer timestamp or a larger ID at equal time. A rolling correction at the same timestamp leaves the projected price stale. Normal worker capture timestamps generally advance, but this valid correction case is unhandled. Future fix needs to allow same-row corrections without allowing an older different observation to replace a newer current row.

These issues are consequences of combining the requested live policy with the repository trigger definitions. They are left explicit, not hidden by changing unrelated SQL or inventing a different live v56. The new strict test command fails until the gate is reviewed/resolved. Do not treat the characterization command's success as approval to release or clean up.

## 5. Verification results

Run from repository root with Node 22.13.0 and already-installed dependencies; no installs.

| Check | Result |
| --- | --- |
| `node scripts/market-snapshot-retention-smoke.mjs` | PASS characterization: real worker batching/keys/preferences/error return; real SQL current UPDATE, anomalies/confirm/rebuild, foil rolling, CardTrader reference, real history RPC 7/30/90/365, trigger revokes and idempotent migration, dry-run classifications and unknown-FK gate. Reports 3 known blockers plus mutable event reference limitation. |
| `node scripts/market-snapshot-retention-smoke.mjs --strict` / `npm run test:market-retention` | FAIL safety gate by design because the above blockers are reproduced. |
| `market-watch-core`, `market-watch-mw1` | PASS. Core assertions updated for the new storage contract. |
| `market-watch-owned-page-query`, `market-watch-summary-perf` | PASS. |
| `market-watch-current-price-layer`, `market-watch-current-price-cutover` | PASS existing static/model suites; new SQL suite provides stronger trigger coverage. |
| `market-dashboard-movers-cutover`, `market-watch-bulk-confirm-aggregate`, `market-sync-egress` | PASS. Existing queue egress optimization retained. |
| `market-watch-loading` | FAIL at line 67: expects `refreshBoardSection()` after early owned-page completion. Both this test and `js/market-watch.js` have zero diff from Git HEAD, so this is pre-existing relative to this task. Not repaired outside retention scope. |
| `npm run lint`, `npm run typecheck` | Not available: package has neither script. Commands attempted and report Missing script. No claim of lint/typecheck success. |
| `node --check` on changed test scripts | PASS. TypeScript worker is parsed/stripped and executed in VM; that is not semantic TypeScript typechecking. |
| Final Git diff review / `git diff --check` | PASS whitespace check on tracked changes; reviewed writer/core-test diff and new SQL/test/report files. Global diff statistics include pre-existing user changes and do not represent this task alone. |
| Supabase/PostgREST integration and browser smoke | Not run. PGlite executes actual SQL on a minimal unrelated schema; it is not a full Supabase stack, HTTP PostgREST test or browser test. No production endpoints invoked. |

Nine of the ten targeted existing non-browser suites pass; one pre-existing loading-suite failure. SQL tests use actual repository table/trigger/function definitions, stub only unrelated schema/auth/provider/network, and mimic submitted-column conflict updates. Verify the real installed PostgREST version and trigger definitions separately before any live change.

## 6. Cleanup dry run (prepared, not executed live)

`scripts/market-snapshot-retention-dry-run.sql` wraps SELECTs in a repeatable-read READ ONLY transaction, with 60s timeout and rollback. It makes no temporary/persistent tables or functions. Run later only with explicit authorization and a role able to see all rows (RLS-filtered counts are not a cleanup audit).

Exclusive bucket precedence:

1. `history_series`: all Cardmarket/trend and CardTrader/reference, even when also referenced.
2. `referenced`: current/event FK references; unresolved anomalies; rolling rows; latest valid snapshot per mapping/type; or any unknown FK blocker. Functional retention is intentionally more conservative than just foreign keys.
3. `cleanup_candidate`: remaining rows, **not an approved deletion set**. Legacy-read indicators may still be nonzero.

Output includes totals, per-bucket/per-provider/per-price_type counts, earliest/latest timestamps, estimated logical row bytes and proportional relation bytes. FK overlaps, anomaly/rolling counts and potential legacy active/derived reader counts are shown separately. Legacy counts are conservative possible-input counts, not exact executed-query winners or measured RPC access logs. Installed view dependencies and direct/indirect-view-reading function names are listed. Dynamic SQL/external readers still require review.

The estimate includes proportional indexes/TOAST/free space and is NOT a prediction of reclaimed disk. No production bucket counts or reclaimed MB are available: the supplied 409,697 rows/~338 MB alone cannot establish which rows are referenced. No DELETE, VACUUM or production dry run executed. The script was exercised only against synthetic PGlite fixtures, including an extra unknown FK that suppresses all candidates.

## 7. Static egress audit

Impact estimates below describe request/payload structure, not measured billing. No broad redesign or frontend change was made.

| File | Function | Risk | Egress impact | Proposed fix |
| --- | --- | --- | --- | --- |
| `supabase/functions/market-sync/index.ts` | `syncProvider` / `rpcPages` | Full target catalog for priority queue was already fixed locally before this task. New-printings, selected-ID and resolver-limit modes still obtain all targets before their JS filter. | High for repeated small target jobs: up to full paginated target payload per job. Existing priority queue now filtered server-side. | Preserve queue patch; add compatible server-side filters/dedicated bounded RPC for other modes, with null-mapping semantics tested. |
| `js/market-watch.js` | `loadRowHistory` / `observeRows` | One RPC per newly visible card; cache and IntersectionObserver limit requests but do not batch. | N+1: up to one 30-day series per card as a user scrolls through the collection. | Bounded multi-printing series RPC or omit offscreen sparklines; request coalescing by printing/range. |
| `js/market-watch.js` | `loadFeaturedHistories` | Three 365-day histories downloaded even though dashboard RPC already supplies small sparkline points. | Up to 3 yearly series per uncached controller session; filters Cardmarket only after response. | Use provided sparkline for overview; fetch long history only on explicit detail. |
| `js/market-watch.js` | `fetchHistory`, `loadFeaturedHistories`, `loadRowHistory`, `setHistoryRange` | Separate in-flight sets; detail fetch lacks shared dedup/cancellation, caches keyed only by printing, not range. | Overlapping same-printing requests or repeated range toggles; potential range-cache correctness issue too. | Shared `(printing,range)` promise cache, cancel stale detail fetches, retain ranges separately. |
| `app.js` + `js/market-watch.js` | 15-minute interval / `load` | Visible Market Watch reloads owned page, summary, extra, movers and anomaly list even with daily prices. In-flight dedup exists; completed loads have no freshness TTL. | Roughly 4 full refreshes per visible hour plus navigation refreshes; NOT continuous background polling when hidden. | TTL keyed by game/member and last sync; invalidate on explicit local actions. |
| `supabase-market-watch-price-anomaly-detection.sql` | `list_market_price_anomalies` | `LIMIT 200` sits outside `jsonb_agg`, limiting the aggregate result row instead of its input. All anomalies can be returned, unscoped to a game. | Potentially unbounded JSON, requested on every Market Watch load. | Ordered limited subquery before aggregate; pagination and appropriate scope. Separate new migration after reviewing live. |
| `20260914210000_market_watch_current_price_cutover.sql` | `list_market_watch_extra` | All deck/manual watched items in one JSON response. | Grows with all watched/deck printings, repeated during reloads. | Paginate extras or load the active tab only. |
| Same migration | `get_market_watch_summary` | `catalogPriceFloor` contains per-owned-catalog entries, not just totals. | O(number of owned catalog cards) in each summary refresh. | Separate compact summary from bounded needed floor lookups. |
| `20260908204855_market_watch_snapshot_reuse.sql` | `list_market_watch` | Legacy unpaginated RPC remains in SQL even though frontend uses new RPCs. | Large payload if an old/external client still calls it; static audit cannot prove live usage. | Check RPC call logs, retire grants/endpoint after consumer verification. |
| `js/api.js` + `app.js` | `myCollection`, `teamCollection`, `loadCollection` | `pagedRpc` downloads every page; paging alone does not reduce total bytes. Full reload on reconciliation rather than delta. | Whole personal/team datasets; team skipped in standalone mode, in-flight protections already present. | Server pagination/search and incremental changed-since reconciliation; preserve loan/availability correctness. |
| `supabase-collection-share-guest-redesign.sql`, `js/api.js`, `js/collection-share.js` | `get_collection_share` / `getCollectionShare` / `load` | Guest bootstrap aggregates the entire shared collection, filters/searches locally. | Full public share payload on each new load, including all alternate names/image URLs; no history fetch here. | Paged public projection with server filters and compact summary, conditional caching respecting revocation. |
| `20260916100000_market_dashboard_movers_current_price_cutover.sql` | `list_market_dashboard_movers` | Already bounded to three items, current layer, four sparkline values. | Low output; no full history scan/download in this RPC. Extra yearly requests originate in frontend. | Keep RPC; optimize `loadFeaturedHistories` separately. |
| `supabase-milestone-5-1-market-watch-operational.sql` | `list_market_price_history` | Already bounded by printing, 1–365 days and two retained series with daily distinct. | At most daily points per eligible provider within the requested range, not every raw metric. | Keep retention compatibility; consider multi-printing bounded API for sparklines. |

Large SQL scans alone are compute/I/O costs, not API egress. Current-layer optimization helps database work; response shape and request frequency determine returned bytes. The only egress micro-fix in the writer was already present and has been preserved, not newly attributed to this task.

## 8. Next live steps — not performed

1. Compare installed v56 source and `20261003203253` SQL with this repository; do not blindly reapply the already-applied migration or redeploy.
2. Resolve the anomaly UPDATE, event semantics and same-timestamp current consistency blockers in a separately reviewed change; validate against the actual PostgREST SQL behavior.
3. Audit installed function/view/FK definitions, stale clients and historical fallback eligibility. Establish before/after RPC parity for cleanup candidates, including anomalies and event provenance.
4. Run the read-only aggregate dry run only after authorization; obtain real bucket counts and relation sizes. Check ownership/RLS visibility and unknown dependency blockers.
5. Only after those gates: design a separate, bounded, reviewable cleanup procedure with backup/recovery and retention requirements. No cleanup command is included here.
6. Observe future rows/day, current projection parity and billed egress after the already-reported live change. Disk and egress are distinct metrics.

**SAFE TO APPLY CLEANUP = NO. No commit/push/deploy performed.**

SQL trigger semantics were checked against [PostgreSQL trigger behavior](https://www.postgresql.org/docs/current/trigger-definition.html), especially BEFORE INSERT plus conflict UPDATE and the distinction between INSERT/UPDATE row triggers. [Supabase changelog](https://supabase.com/changelog) was consulted; no platform upgrade was attempted.
