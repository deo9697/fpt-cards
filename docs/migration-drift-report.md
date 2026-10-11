# Migration drift — 2026-10-08

Read-only comparison of repository SQL, current live history, and actual public relation/function signatures. No record deletion, renaming, history repair, live DDL or replay.

- LOCAL_ONLY: 0
- LIVE_ONLY: 20
- SAME_CHANGE_DIFFERENT_HISTORY: 15
- OBSOLETE_LOCAL: 1
- MISSING_LOCAL_HISTORY: 35
- UNKNOWN: 45

`UNKNOWN` is intentional: matching names/objects cannot prove equivalent policies, columns, grants or function bodies. Exact normalized hashes establish matching submitted SQL, not that later migrations have not superseded it. Full evidence: [JSON](audit-snapshots/stabilization-blockers-2026-10-08/migration-drift.json).

| Side | Version / name | Classification | Local evidence | Present live objects |
|---|---|---|---|---|
| LIVE | 20260831141916 fast_scan_catalog_aliases | MISSING_LOCAL_HISTORY | supabase-fast-scan-catalog-aliases.sql | card_catalog_aliases, resolve_catalog_card_id, canonicalize_card_printing_catalog_id, reconcile_catalog_identity |
| LIVE | 20260831171833 fast_scan_catalog_identity_v2 | MISSING_LOCAL_HISTORY | supabase-fast-scan-catalog-identity-v2.sql | reconcile_catalog_identity |
| LIVE | 20260831184115 catalog_verification_v1 | MISSING_LOCAL_HISTORY | supabase-catalog-verification-v1.sql | invalidate_card_printing_catalog_verification, list_collection_catalog_verification_queue, repair_collection_item_catalog_identity |
| LIVE | 20260901115539 printing_editor_integrity | MISSING_LOCAL_HISTORY | supabase-printing-editor-integrity.sql | correct_collection_item_printing |
| LIVE | 20260901115818 printing_editor_integrity_conflict_fix | MISSING_LOCAL_HISTORY | supabase-printing-editor-integrity-conflict-fix.sql | Not established |
| LIVE | 20260901115955 printing_editor_integrity_conflict_fix_v2 | MISSING_LOCAL_HISTORY | supabase-printing-editor-integrity-conflict-fix-v2.sql | Not established |
| LIVE | 20260901130554 fast_scan_idempotency_p0 | MISSING_LOCAL_HISTORY | supabase-fast-scan-idempotency-p0.sql | fast_scan_batches, fast_scan_batch_chunks, save_fast_scan_chunk, list_my_collection, list_team_collection |
| LIVE | 20260901130737 fast_scan_idempotency_p0_qualified_columns | SAME_CHANGE_DIFFERENT_HISTORY | supabase-fast-scan-idempotency-p0.sql | fast_scan_batches, fast_scan_batch_chunks, save_fast_scan_chunk, list_my_collection, list_team_collection |
| LIVE | 20260902201112 mw1_market_mapping_integrity | MISSING_LOCAL_HISTORY | supabase-mw1-market-mapping-integrity.sql | market_mapping_is_active, market_active_price_snapshots, market_derived_price_snapshots, market_latest_prices |
| LIVE | 20260904073004 market_watch_indicative_cardmarket_baselines | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260904073015 market_watch_cron_timeout_hardening | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260905143012 notifications_center | MISSING_LOCAL_HISTORY | supabase-notifications-center.sql | notifications |
| LIVE | 20260905143100 market_alert_scan | MISSING_LOCAL_HISTORY | supabase-market-alert-scan.sql | run_market_alert_scan, market_alert_scan_gate |
| LIVE | 20260908153009 catalog_identity_localized_names | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908152605_catalog_identity_localized_names.sql | reconcile_catalog_identity |
| LIVE | 20260908154348 market_refresh_queue_schedule | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908154257_market_refresh_queue_schedule.sql | Not established |
| LIVE | 20260908202416 market_verified_blgg_metadata | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908154639_market_verified_blgg_metadata.sql | Not established |
| LIVE | 20260908203439 onepiece_catalog_search_and_collection_metadata | MISSING_LOCAL_HISTORY | supabase/migrations/20260908201500_onepiece_catalog_search_and_collection_metadata.sql | search_onepiece_catalog, list_my_collection, list_team_collection |
| LIVE | 20260908203824 market_watch_reference_join | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908203706_market_watch_reference_join.sql | list_market_watch |
| LIVE | 20260908204946 market_watch_snapshot_reuse | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908204855_market_watch_snapshot_reuse.sql | list_market_watch |
| LIVE | 20260909115338 onepiece_deck_multi_printing_per_card | MISSING_LOCAL_HISTORY | supabase/migrations/20260908205000_onepiece_deck_multi_printing_per_card.sql | save_deck, save_deck_with_box |
| LIVE | 20260909173417 optimize_loan_confirmation_commitments | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260909195650 market_refresh_include_mapped_without_prices | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260910053530 route_daily_market_sync_through_cache | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260910122046 deck_card_manual_order | MISSING_LOCAL_HISTORY | supabase/migrations/20260910120000_deck_card_manual_order.sql | save_deck, save_deck_with_box, list_my_decks_with_boxes, list_my_decks, list_team_decks |
| LIVE | 20260910201322 onepiece_card_costs_lookup | MISSING_LOCAL_HISTORY | supabase/migrations/20260910130000_onepiece_card_costs_lookup.sql | list_onepiece_card_costs |
| LIVE | 20260911113356 onepiece_image_cross_code_repair_base_code_fix | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260912142829 ygo_market_variant_review_resolver | MISSING_LOCAL_HISTORY | supabase/migrations/20260912170000_ygo_market_variant_review_resolver.sql | list_ygo_market_variant_review_queue, confirm_ygo_market_variant |
| LIVE | 20260912152001 ygo_market_variant_exact_price_shadow | MISSING_LOCAL_HISTORY | supabase/migrations/20260912180000_ygo_market_variant_exact_price_shadow.sql | ygo_market_variant_price_shadow, ygo_market_variant_legacy_reference_prices, run_ygo_market_variant_price_shadow, ygo_market_variant_exact_price_report |
| LIVE | 20260912155219 ygo_market_variant_candidate_metadata | MISSING_LOCAL_HISTORY | supabase/migrations/20260912190000_ygo_market_variant_candidate_metadata.sql | ygo_market_variant_candidate_metadata, get_ygo_market_variant_candidate_metadata, request_ygo_market_variant_candidate_metadata_refresh |
| LIVE | 20260912183040 ygo_market_variant_set_templates | MISSING_LOCAL_HISTORY | supabase/migrations/20260912200000_ygo_market_variant_set_templates.sql | ygo_market_variant_set_templates, touch_ygo_market_variant_set_templates_updated_at, list_ygo_market_variant_set_templates, list_ygo_market_variant_ambiguous_for_dry_run, apply_ygo_verified_set_template_resolutions, list_ygo_market_variant_review_queue, ygo_market_variant_exact_price_report |
| LIVE | 20260916120949 lockdown_bump_daily_mission | MISSING_LOCAL_HISTORY | supabase/migrations/20260916090000_lockdown_bump_daily_mission.sql | Not established |
| LIVE | 20260911123437 deck_win_streak | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260911140625_deck_win_streak.sql | get_deck_win_streak |
| LIVE | 20260911134702 market_watch_owned_pagination | MISSING_LOCAL_HISTORY | supabase/migrations/20260911145101_market_watch_owned_pagination.sql | list_market_watch_owned_page, list_market_watch_extra, get_market_watch_summary, list_market_confirm_queue |
| LIVE | 20260912011438 deck_archetype_unlock_total_wins | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260912095443 ygo_market_variant_registry | MISSING_LOCAL_HISTORY | supabase/migrations/20260912110000_ygo_market_variant_registry.sql | ygo_rarity_canon, ygo_rarity_aliases, normalize_ygo_rarity_key, normalize_ygo_rarity, ygo_market_variants, touch_ygo_market_variants_updated_at |
| LIVE | 20260912095518 ygo_market_variant_backfill_report | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260912120000_ygo_market_variant_backfill_report.sql | ygo_market_variant_backfill_report |
| LIVE | 20260912095858 index_ygo_market_variants_verified_by | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260912100415 guard_ygo_printing_rarity | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260912100530 reconcile_numeric_ygo_rarities_without_duplicates | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260912100628 merge_duplicate_common_ygo_printings | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260912102745 ygo_market_variants_resolution_reason | MISSING_LOCAL_HISTORY | supabase/migrations/20260912130000_ygo_market_variants_resolution_reason.sql | Not established |
| LIVE | 20260912112604 ygo_market_variant_canary | MISSING_LOCAL_HISTORY | supabase/migrations/20260912140000_ygo_market_variant_canary.sql | ygo_market_variant_canary_runs, run_ygo_market_variant_canary, get_ygo_market_variant_canary_run |
| LIVE | 20260912185807 ygo_market_variant_mapping_source_check | MISSING_LOCAL_HISTORY | supabase/migrations/20260912210000_ygo_market_variant_mapping_source_check.sql | Not established |
| LIVE | 20260912193056 ygo_market_variant_exact_price_eligible_queue | MISSING_LOCAL_HISTORY | supabase/migrations/20260912220000_ygo_market_variant_exact_price_eligible_queue.sql | list_ygo_market_variant_exact_price_eligible |
| LIVE | 20260914094819 optimize_get_collection_share_set_based | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260914120936 ygo_market_variant_backfill_candidates | MISSING_LOCAL_HISTORY | supabase/migrations/20260912230000_ygo_market_variant_backfill_candidates.sql | list_ygo_market_variant_backfill_candidates |
| LIVE | 20260914125325 market_watch_owned_page_perf | MISSING_LOCAL_HISTORY | supabase/migrations/20260914090000_market_watch_owned_page_perf.sql | list_market_watch_owned_page |
| LIVE | 20260914131633 market_watch_summary_perf | MISSING_LOCAL_HISTORY | supabase/migrations/20260914150000_market_watch_summary_perf.sql | get_market_watch_summary |
| LIVE | 20260916102138 prevent_empty_user_decks | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260915133951 dashboard_collection_trends | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260915134135 dashboard_trends_active_prices | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260915140233 dashboard_trends_current_prices | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260915201826 list_catalog_printings_index | MISSING_LOCAL_HISTORY | supabase/migrations/20260915100000_list_catalog_printings_index.sql | list_catalog_printings_index |
| LIVE | 20260915201836 fix_catalog_printings_index_cursor | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260916121006 market_dashboard_movers_current_price_cutover | MISSING_LOCAL_HISTORY | supabase/migrations/20260916100000_market_dashboard_movers_current_price_cutover.sql | list_market_dashboard_movers |
| LIVE | 20260916123429 shared_collection_request_hardening | MISSING_LOCAL_HISTORY | supabase/migrations/20260916120000_shared_collection_request_hardening.sql | submit_collection_share_request, list_collection_share_requests |
| LIVE | 20260916123635 shared_collection_request_hardening_hotfix | MISSING_LOCAL_HISTORY | supabase/migrations/20260916123000_shared_collection_request_hardening_hotfix.sql | submit_collection_share_request |
| LIVE | 20260916125009 shared_collection_request_hardening_hotfix_repo_sync | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260916194628 collection_share_requests_state_machine_hardened | LIVE_ONLY | No matched file | Not established |
| LIVE | 20260917172550 market_watch_single_printing_price | MISSING_LOCAL_HISTORY | supabase/migrations/20260917140000_market_watch_single_printing_price.sql | get_market_watch_item_price |
| LIVE | 20260917172646 ygo_printing_mapping_reconciliation_queue | MISSING_LOCAL_HISTORY | supabase/migrations/20260917100000_ygo_printing_mapping_reconciliation_queue.sql | list_collection_printing_mapping_queue |
| LIVE | 20261003203253 market_snapshot_storage_hardening | MISSING_LOCAL_HISTORY | docs/archive/20261003203253_market_snapshot_storage_hardening.sql | Not established |
| LIVE | 20261004074139 market_refresh_queue_pending_egress_hardening | LIVE_ONLY | No matched file | Not established |
| LOCAL | 20260908152605 catalog_identity_localized_names | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908152605_catalog_identity_localized_names.sql | reconcile_catalog_identity |
| LOCAL | 20260908154257 market_refresh_queue_schedule | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908154257_market_refresh_queue_schedule.sql | Not established |
| LOCAL | 20260908154639 market_verified_blgg_metadata | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908154639_market_verified_blgg_metadata.sql | Not established |
| LOCAL | 20260908190500 onepiece_deck_and_printing_foundation | UNKNOWN | supabase/migrations/20260908190500_onepiece_deck_and_printing_foundation.sql | save_deck, save_deck_with_box, correct_collection_item_printing, repair_collection_item_catalog_identity, save_collection_batch, save_collection_item |
| LOCAL | 20260908201500 onepiece_catalog_search_and_collection_metadata | UNKNOWN | supabase/migrations/20260908201500_onepiece_catalog_search_and_collection_metadata.sql | search_onepiece_catalog, list_my_collection, list_team_collection |
| LOCAL | 20260908203706 market_watch_reference_join | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908203706_market_watch_reference_join.sql | list_market_watch |
| LOCAL | 20260908204855 market_watch_snapshot_reuse | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260908204855_market_watch_snapshot_reuse.sql | list_market_watch |
| LOCAL | 20260908205000 onepiece_deck_multi_printing_per_card | UNKNOWN | supabase/migrations/20260908205000_onepiece_deck_multi_printing_per_card.sql | save_deck, save_deck_with_box |
| LOCAL | 20260909120000 loans_legacy_cleanup_and_indexes | UNKNOWN | supabase/migrations/20260909120000_loans_legacy_cleanup_and_indexes.sql | Not established |
| LOCAL | 20260909130000 loans_pre_agreed_request | UNKNOWN | supabase/migrations/20260909130000_loans_pre_agreed_request.sql | request_collection_loan |
| LOCAL | 20260909140000 loan_request_idempotency | UNKNOWN | supabase/migrations/20260909140000_loan_request_idempotency.sql | request_collection_loan, request_collection_loans |
| LOCAL | 20260909150000 match_went_first | UNKNOWN | supabase/migrations/20260909150000_match_went_first.sql | register_match, get_match_timeline |
| LOCAL | 20260909160000 team_member_titles | UNKNOWN | supabase/migrations/20260909160000_team_member_titles.sql | list_member_profiles |
| LOCAL | 20260910100000 lookup_card_printings_by_catalog_id | UNKNOWN | supabase/migrations/20260910100000_lookup_card_printings_by_catalog_id.sql | lookup_card_printings_by_catalog_id |
| LOCAL | 20260910120000 deck_card_manual_order | UNKNOWN | supabase/migrations/20260910120000_deck_card_manual_order.sql | save_deck, save_deck_with_box, list_my_decks_with_boxes, list_my_decks, list_team_decks |
| LOCAL | 20260910130000 onepiece_card_costs_lookup | UNKNOWN | supabase/migrations/20260910130000_onepiece_card_costs_lookup.sql | list_onepiece_card_costs |
| LOCAL | 20260910224000 onepiece_image_cross_code_repair | UNKNOWN | supabase/migrations/20260910224000_onepiece_image_cross_code_repair.sql | repair_collection_item_catalog_identity |
| LOCAL | 20260911140625 deck_win_streak | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260911140625_deck_win_streak.sql | get_deck_win_streak |
| LOCAL | 20260911145101 market_watch_owned_pagination | UNKNOWN | supabase/migrations/20260911145101_market_watch_owned_pagination.sql | list_market_watch_owned_page, list_market_watch_extra, get_market_watch_summary, list_market_confirm_queue |
| LOCAL | 20260911150000 collection_share_catalog_card_id | UNKNOWN | supabase/migrations/20260911150000_collection_share_catalog_card_id.sql | get_collection_share |
| LOCAL | 20260911160000 ygo_printing_registry | UNKNOWN | supabase/migrations/20260911160000_ygo_printing_registry.sql | normalize_ygo_set_code, ygo_printcode_prefix_cache, ygo_printcode_entries, ygo_printing_registry, touch_ygo_printing_registry_updated_at, ygo_printing_overrides, ygo_artwork_index, ygo_artwork_index_lookup, ygo_artwork_index_upsert, ygo_printing_registry_lookup, ygo_printcode_cache_lookup, ygo_printcode_cache_upsert, apply_ygo_printing_mappings, upsert_ygo_printing_override, list_ygo_printings_for_backfill, list_ygo_printing_registry_issues, save_collection_item, save_collection_batch, repair_collection_item_catalog_identity |
| LOCAL | 20260911170000 ygo_artwork_admin_resolver | UNKNOWN | supabase/migrations/20260911170000_ygo_artwork_admin_resolver.sql | ygo_artwork_index_upsert, list_ygo_artwork_review_queue |
| LOCAL | 20260912090000 ygo_artwork_curator_role | UNKNOWN | supabase/migrations/20260912090000_ygo_artwork_curator_role.sql | ygo_printing_artwork_audit, confirm_ygo_printing_artwork, list_ygo_artwork_review_queue, list_my_ygo_artwork_verifications, login_member |
| LOCAL | 20260912093000 ygo_artwork_set_prefixes | UNKNOWN | supabase/migrations/20260912093000_ygo_artwork_set_prefixes.sql | list_ygo_artwork_review_set_prefixes |
| LOCAL | 20260912110000 ygo_market_variant_registry | UNKNOWN | supabase/migrations/20260912110000_ygo_market_variant_registry.sql | ygo_rarity_canon, ygo_rarity_aliases, normalize_ygo_rarity_key, normalize_ygo_rarity, ygo_market_variants, touch_ygo_market_variants_updated_at |
| LOCAL | 20260912120000 ygo_market_variant_backfill_report | SAME_CHANGE_DIFFERENT_HISTORY | supabase/migrations/20260912120000_ygo_market_variant_backfill_report.sql | ygo_market_variant_backfill_report |
| LOCAL | 20260912130000 ygo_market_variants_resolution_reason | UNKNOWN | supabase/migrations/20260912130000_ygo_market_variants_resolution_reason.sql | Not established |
| LOCAL | 20260912140000 ygo_market_variant_canary | UNKNOWN | supabase/migrations/20260912140000_ygo_market_variant_canary.sql | ygo_market_variant_canary_runs, run_ygo_market_variant_canary, get_ygo_market_variant_canary_run |
| LOCAL | 20260912141500 catalog_verification_queue_throttle | UNKNOWN | supabase/migrations/20260912141500_catalog_verification_queue_throttle.sql | list_collection_catalog_verification_queue, record_collection_catalog_verification_attempt |
| LOCAL | 20260912150000 repair_catalog_identity_ambiguous_column_fix | UNKNOWN | supabase/migrations/20260912150000_repair_catalog_identity_ambiguous_column_fix.sql | repair_collection_item_catalog_identity |
| LOCAL | 20260912160000 rival_wins | UNKNOWN | supabase/migrations/20260912160000_rival_wins.sql | get_rival_wins |
| LOCAL | 20260912170000 ygo_market_variant_review_resolver | UNKNOWN | supabase/migrations/20260912170000_ygo_market_variant_review_resolver.sql | list_ygo_market_variant_review_queue, confirm_ygo_market_variant |
| LOCAL | 20260912180000 ygo_market_variant_exact_price_shadow | UNKNOWN | supabase/migrations/20260912180000_ygo_market_variant_exact_price_shadow.sql | ygo_market_variant_price_shadow, ygo_market_variant_legacy_reference_prices, run_ygo_market_variant_price_shadow, ygo_market_variant_exact_price_report |
| LOCAL | 20260912190000 ygo_market_variant_candidate_metadata | UNKNOWN | supabase/migrations/20260912190000_ygo_market_variant_candidate_metadata.sql | ygo_market_variant_candidate_metadata, get_ygo_market_variant_candidate_metadata, request_ygo_market_variant_candidate_metadata_refresh |
| LOCAL | 20260912200000 ygo_market_variant_set_templates | UNKNOWN | supabase/migrations/20260912200000_ygo_market_variant_set_templates.sql | ygo_market_variant_set_templates, touch_ygo_market_variant_set_templates_updated_at, list_ygo_market_variant_set_templates, list_ygo_market_variant_ambiguous_for_dry_run, apply_ygo_verified_set_template_resolutions, list_ygo_market_variant_review_queue, ygo_market_variant_exact_price_report |
| LOCAL | 20260912210000 ygo_market_variant_mapping_source_check | UNKNOWN | supabase/migrations/20260912210000_ygo_market_variant_mapping_source_check.sql | Not established |
| LOCAL | 20260912220000 ygo_market_variant_exact_price_eligible_queue | UNKNOWN | supabase/migrations/20260912220000_ygo_market_variant_exact_price_eligible_queue.sql | list_ygo_market_variant_exact_price_eligible |
| LOCAL | 20260912230000 ygo_market_variant_backfill_candidates | UNKNOWN | supabase/migrations/20260912230000_ygo_market_variant_backfill_candidates.sql | list_ygo_market_variant_backfill_candidates |
| LOCAL | 20260914090000 market_watch_owned_page_perf | UNKNOWN | supabase/migrations/20260914090000_market_watch_owned_page_perf.sql | list_market_watch_owned_page |
| LOCAL | 20260914150000 market_watch_summary_perf | UNKNOWN | supabase/migrations/20260914150000_market_watch_summary_perf.sql | get_market_watch_summary |
| LOCAL | 20260914200000 market_current_price_layer | UNKNOWN | supabase/migrations/20260914200000_market_current_price_layer.sql | market_current_price_snapshots, sync_market_current_price_snapshot, rebuild_market_current_price_snapshot, trg_market_current_price_snapshot_after_insert, trg_market_current_price_snapshot_after_anomaly_change, backfill_market_current_price_snapshots, market_current_price_layer_shadow_report |
| LOCAL | 20260914210000 market_watch_current_price_cutover | UNKNOWN | supabase/migrations/20260914210000_market_watch_current_price_cutover.sql | get_market_watch_summary, list_market_watch_owned_page, list_market_watch_extra |
| LOCAL | 20260915100000 list_catalog_printings_index | OBSOLETE_LOCAL | supabase/migrations/20260915100000_list_catalog_printings_index.sql | list_catalog_printings_index |
| LOCAL | 20260915110000 list_catalog_printings_index_created_at_cursor | UNKNOWN | supabase/migrations/20260915110000_list_catalog_printings_index_created_at_cursor.sql | list_catalog_printings_index |
| LOCAL | 20260916090000 lockdown_bump_daily_mission | UNKNOWN | supabase/migrations/20260916090000_lockdown_bump_daily_mission.sql | Not established |
| LOCAL | 20260916100000 market_dashboard_movers_current_price_cutover | UNKNOWN | supabase/migrations/20260916100000_market_dashboard_movers_current_price_cutover.sql | list_market_dashboard_movers |
| LOCAL | 20260916120000 shared_collection_request_hardening | UNKNOWN | supabase/migrations/20260916120000_shared_collection_request_hardening.sql | submit_collection_share_request, list_collection_share_requests |
| LOCAL | 20260916123000 shared_collection_request_hardening_hotfix | UNKNOWN | supabase/migrations/20260916123000_shared_collection_request_hardening_hotfix.sql | submit_collection_share_request |
| LOCAL | 20260917100000 ygo_printing_mapping_reconciliation_queue | UNKNOWN | supabase/migrations/20260917100000_ygo_printing_mapping_reconciliation_queue.sql | list_collection_printing_mapping_queue |
| LOCAL | 20260917120000 collection_share_requests_state_machine | UNKNOWN | supabase/migrations/20260917120000_collection_share_requests_state_machine.sql | collection_share_confirmed_quantity, get_collection_share, submit_collection_share_request, list_collection_share_requests, confirm_collection_share_request, complete_collection_share_request, cancel_collection_share_request |
| LOCAL | 20260917130000 collection_share_requests_state_machine_hardening | UNKNOWN | supabase/migrations/20260917130000_collection_share_requests_state_machine_hardening.sql | get_collection_share, complete_collection_share_request |
| LOCAL | 20260917140000 market_watch_single_printing_price | UNKNOWN | supabase/migrations/20260917140000_market_watch_single_printing_price.sql | get_market_watch_item_price |
| LOCAL | 20260921100000 standalone_shadow_identity | UNKNOWN | supabase/migrations/20260921100000_standalone_shadow_identity.sql | session_member, is_team_admin, my_team_slug, is_member_claimed, get_my_identity, claim_legacy_member |

## Safest convergence strategy

1. Freeze the historical ledger; never make the live database accept a fictitious migration history.
2. Establish a disposable Supabase-compatible bootstrap including root SQL prerequisites; the migrations directory alone is not a demonstrated fresh-environment recipe.
3. Compare resulting columns, constraints, indexes, triggers, grants, RLS policies and function bodies against a reviewed current-schema manifest. Names alone are insufficient.
4. Preserve ordered historical migrations. Add a reviewed forward-only local reconciliation migration only after discrepancies are reproduced; no automatic application to production.
5. Replay from an empty environment and a representative older baseline, then run RPC and security regressions. Current recommendation: do not run `supabase db push`.
6. Market manual SQL must be incorporated into that bootstrap deliberately; the rolling UPDATE trigger must remain absent while its historical live record is preserved.

Convergence is NOT proven by this report. Unknown content mismatches remain a deployment blocker; this report makes each one explicit rather than repairing history blindly.
