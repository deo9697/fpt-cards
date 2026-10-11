# MAMO-EN013 — end-to-end investigation, 2026-10-08

**ROOT CAUSE NOT PROVEN** for the historical incident. The user reports that
YGOPRODeck had incomplete API coverage despite records being visible in its DB.
This is the strongest supported incident hypothesis, not a recovered historical
API payload. No original import command/log/payload was supplied.

The source snapshot of 5 October contains ID 75787708 / MAMO-EN013 and multiple
rarities. Current official [Konami card detail](https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=22702&request_locale=en)
confirms the code and Ultra/Starlight/Grand Master rarities. Its September release
date does not prove what YGOPRODeck returned at the earlier import time.
Live row created at `2026-10-04T07:50:20.415927Z` is the manual repair, not evidence
of original importer success. Other MAMO rows have multiple creation cohorts;
their timestamps alone cannot identify the command that created them.

| Stage | Actual path and evidence | Finding |
|---|---|---|
| External source | YGOPRODeck cardinfo and cardsetsinfo; preserved set snapshot | Current source includes EN013. Historical response unavailable. |
| Raw fetch | js/cards.js lookupPrintingBySetCode → exact code endpoint → findCardById/cardinfo | Old lookup required both endpoints to agree; valid set response could be lost if card_sets lagged. Reproduced by deterministic fixture. |
| Pagination/bounds | External exact lookup previously exact.slice(0,8) | More than 8 source identities truncated. Local fix batches by 8 without total truncation. Not evidence EN013 was the ninth item. |
| Card mapping / set parsing | mapYugiohCard → normalizeCatalogPrintings; then exact set-code filter | Incomplete card_sets formerly erased the independently valid set endpoint row. Current fallback retains its explicit rarity and identity. |
| Rarity | sanitizeYugiohRarity legacy compatibility maps New/Reprint tags to Common | Old audit wrongly counted 18 pseudo-Common rows. Audit/administrative planner now reject these with an explicit reason; legacy UI sanitizer is not a source of physical-printing evidence. |
| Artwork merge | Canonical ID aliases separate from image IDs | Multiple images do not prove which artwork belongs to a printing. New local planner preserves image/source provenance and explicit variants; it never guesses variant assignment. |
| Canonicalization | Explicit JS and live card_catalog_aliases registries | No alias for 75787708 shown by the audited registry. Names alone never canonicalize IDs. |
| Dedupe | Resolver key includes catalog ID + set code + rarity | EN013 cannot merge into EN012/EN014 through this key. Same code/rarity artwork distinctions remain only partially supported by the runtime resolver. |
| Persistence | save_collection_item/save_collection_batch or admin repair, not automatic persistence by lookup | Looking up a card does not populate all global card_printings. Saving writes selected observations/collection items. A complete scheduled YGO catalog importer was not found in the repository; One Piece has a separate job. |
| Incremental source refresh | No complete global YGO feed ingestion job found | Cannot assert newly appearing API printings automatically populate DB. A valid new exact lookup is no longer trapped by a permanent negative cache; database persistence still requires the existing save/admin path. |
| Incremental scanner cache | js/fast-scan-catalog-cache.js → list_catalog_printings_index | Downloads DB index, not external catalog. Live function uses (created_at,id), superseding unsafe UUID-only cursor. New local RPC test proves a newly inserted smaller UUID is found. |

## Answers to the six incident questions

1. **Present in source at import time?** Unknown. User reports upstream API
   incompleteness. Preserved source is later than the incident, so it cannot prove
   historical presence/absence.
2. **Where dropped if present?** Reproducible failure point is the intersection of
   exact set endpoint with incomplete cardinfo.card_sets. No evidence ties that
   stage conclusively to this particular original import execution.
3. **If absent, does incremental refresh add it later?** DB index refresh picks up
   newly persisted rows. Source lookup can recover after a miss. There is no
   demonstrated automatic global source→DB backfill, so not guaranteed.
4. **Could dedupe merge EN013 elsewhere?** Not into another set code with the
   inspected keys. No EN013 canonical alias was found. Artwork collapse within
   one code/rarity is a separate limitation.
5. **Could rarity/artwork logic reject it?** Ultra Rare is retained. Incomplete
   card_sets can yield no candidates regardless of rarity. New-tag handling can
   manufacture a pseudo-Common identity in the old audit, not explain the missing
   valid Ultra Rare row by itself.
6. **Same mechanism in all 163?** Not established. Review finds 18 audit artifacts,
   18 serialized special-rarity cases and 127 ordinary missing printing identities.
   Source coverage gaps and demand-driven persistence are hypotheses per group;
   each candidate explicitly records historical root cause as unproven.

## Regression and boundaries

`catalog-printing-completeness-smoke.mjs` exercises the production resolver:
EN012/013/014 with missing card_sets, recovery after source miss, >8 source rows,
explicit rejection of incomplete source and transport failures.
`catalog-ingest-plan-smoke.mjs` exercises a pure administrative plan and a local
PGlite identity table: aliases, rarities, explicit artwork variants, invalid
fields, multiple sets, incremental insert, replay and the actual index RPC.
It is not an installed production importer. Every source printing has an explicit
disposition; alias merges retain provenance. No production writes were performed.

**INGEST BUG FIXED = YES for the reproduced resolver loss and audit false positives.**
**Historical incident cause proven = NO. Global automatic YGO ingest/backfill installed = NO.**
