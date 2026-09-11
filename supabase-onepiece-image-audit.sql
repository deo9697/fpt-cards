-- F.P.T Cards — One Piece: audit di sola lettura per le printing con
-- immagine mancante o sospetta (~178 righe segnalate dall'utente dopo
-- l'ultimo sync, 2026-09-10).
--
-- QUESTA NON È UNA MIGRATION: nessun ALTER/INSERT/UPDATE, solo SELECT.
-- Sicura da eseguire in qualunque momento, ripetibile, nessun effetto
-- collaterale. Non fa parte di supabase/migrations/ apposta.
--
-- Riusa la STESSA regex del controllo cross-code applicato al sync
-- (supabase/functions/onepiece-catalog-sync/normalizer.mjs:imageMatchesCode)
-- e al repair (supabase/migrations/20260910224000_onepiece_image_cross_code_
-- repair.sql), così la classifica qui sotto rispecchia esattamente cosa il
-- codice applicativo farebbe/ha fatto con ciascuna riga.
--
-- Fix 2026-09-11 (trovato eseguendo questa stessa query sui dati reali:
-- 8 dei 10 risultati in 3_immagine_sbagliata_cross_code erano falsi positivi
-- promo tipo "P-029_R1" con immagine "P-029_r1.jpg" — il catalog_card_id
-- stesso porta il suffisso di variante, non solo il filename). expected_code
-- ora spoglia lo stesso suffisso "_XX" da catalog_card_id prima di
-- confrontare, invece di confrontare il codice BASE del filename contro il
-- catalog_card_id INTERO.
--
-- Bucket prodotti (priorità nell'ordine elencato):
--   1_mancante_upstream            — nessuna immagine, nessun indizio che OPTCG
--                                     ne avesse mai fornita una diversa
--   2_url_malformato_recuperabile  — un valore è presente ma non è un URL
--                                     https:// valido (troncato, corrotto...)
--   3_immagine_sbagliata_gia_rilevata_dal_fix — il sync (dopo il fix di
--                                     questa sessione) ha già rilevato e
--                                     azzerato un'immagine cross-code,
--                                     conservando l'originale in
--                                     game_metadata.rawSuspectImageUrl.
--                                     Compare SOLO dopo un resync col fix
--                                     deployato — prima di allora questo
--                                     bucket resta vuoto anche se il
--                                     problema esiste, perché il dato grezzo
--                                     non è ancora mai stato scritto.
--   3_immagine_sbagliata_cross_code — l'immagine C'È, ma il codice ricavato
--                                     dal filename non combacia col
--                                     catalog_card_id: il caso Hawkins,
--                                     rilevabile SUBITO con questa query
--                                     anche prima di un resync, perché legge
--                                     l'image_url già in tabella oggi.
--   4_variante_legacy_senza_immagine — riga senza immagine il cui variant_id
--                                     porta il suffisso "--..." assegnato da
--                                     resolveVariantCollisions() — quasi
--                                     sempre una ristampa promo/torneo con
--                                     dati OPTCG intrinsecamente più deboli.
--   5_immagine_ok_o_non_classificabile — non rientra in nessuno dei casi
--                                     sopra: o l'immagine è a posto, o il
--                                     filename non ha affatto la forma di un
--                                     codice carta (slug nome, hash CDN) e
--                                     quindi non è giudicabile da questa
--                                     regola — va rivista a mano se compare
--                                     qui insieme a un image_url vuoto.

with base as (
  select
    cp.id, cp.catalog_card_id, cp.variant_id, cp.card_name, cp.set_code, cp.set_name, cp.rarity,
    cp.image_url,
    cp.game_metadata ->> 'rawSuspectImageUrl' as raw_suspect_image_url,
    regexp_replace(regexp_replace(coalesce(cp.image_url,''), '^.*/', ''), '\.(jpe?g|png|webp|gif)$', '', 'i') as image_stem
  from public.card_printings cp
  where cp.game = 'onepiece'
), extracted as (
  select base.*,
    substring(image_stem from '^(([A-Za-z]{1,4}[0-9]{0,3}-[0-9]{1,4})|([Dd][Oo][Nn][_-]?[0-9]+))') as extracted_code_raw
  from base
), normalized as (
  select extracted.*,
    case when extracted_code_raw is not null
      then regexp_replace(upper(extracted_code_raw), '^DON-', 'DON_')
      else null
    end as extracted_code,
    coalesce(
      regexp_replace(upper(substring(catalog_card_id from '^(([A-Za-z]{1,4}[0-9]{0,3}-[0-9]{1,4})|([Dd][Oo][Nn][_-]?[0-9]+))')), '^DON-', 'DON_'),
      upper(catalog_card_id)
    ) as expected_code
  from extracted
), classified as (
  select
    id, catalog_card_id, variant_id, card_name, set_code, set_name, rarity, image_url, raw_suspect_image_url,
    case
      when image_url is null or trim(image_url) = '' then
        case
          when raw_suspect_image_url is not null then '3_immagine_sbagliata_gia_rilevata_dal_fix'
          when variant_id like '%--%' then '4_variante_legacy_senza_immagine'
          else '1_mancante_upstream'
        end
      when image_url !~* '^https://' then '2_url_malformato_recuperabile'
      when extracted_code is not null and extracted_code <> expected_code then '3_immagine_sbagliata_cross_code'
      else '5_immagine_ok_o_non_classificabile'
    end as bucket
  from normalized
)
-- Il "with" sopra (base/extracted/normalized/classified) vale solo per QUESTO
-- statement: se vuoi vedere le righe di un bucket specifico invece del
-- riassunto, sostituisci l'intero blocco qui sotto (dal primo "select" alla
-- fine) con, ad esempio:
--   select * from classified where bucket = '3_immagine_sbagliata_cross_code' order by catalog_card_id limit 50;
-- e ri-esegui tutto lo script (il "with" deve restare, cambia solo l'ultima riga).

-- Riassunto per bucket — parti da qui.
select bucket, count(*) as printing_count
from classified
where bucket <> '5_immagine_ok_o_non_classificabile' -- tolto di proposito: sarebbe la maggioranza (migliaia di righe già a posto)
group by bucket
order by bucket;
