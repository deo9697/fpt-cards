-- Loan DB v2 — pulizia una tantum dei duplicati 'requested' individuati con
-- scripts/diagnose-duplicate-loan-requests.sql (Gruppo A: percorso con
-- collection_item_id valorizzato). NON è una migration: va eseguita a mano
-- una volta, dopo aver guardato il risultato del diagnostico.
--
-- Per ogni gruppo (stesso owner_slug, borrower_slug, collection_item_id, più
-- righe ancora 'requested') tiene la riga più vecchia e rifiuta le altre
-- (status='rejected'), come se il proprietario avesse rifiutato a mano il
-- doppione — nessuna cancellazione, tutto resta tracciabile. 'requested' non
-- impegna copie in inventario (solo 'reserved' lo fa), quindi non cambia
-- nessuna disponibilità né tocca prestiti già attivi.
--
-- Se preferisci cancellare i doppioni invece di segnarli rifiutati, sostituisci
-- il blocco UPDATE qui sotto con:
--   delete from public.loans l using ranked r where l.id = r.id and r.rn > 1;
-- (va eseguito prima dello stesso CTE "ranked").

with ranked as (
  select id, row_number() over (
    partition by owner_slug, borrower_slug, collection_item_id
    order by created_at
  ) as rn
  from public.loans
  where status = 'requested' and collection_item_id is not null
)
update public.loans l
set status = 'rejected', rejected_at = now()
from ranked r
where l.id = r.id and r.rn > 1;

-- Verifica: dopo l'update questa deve tornare vuota (nessun gruppo con più
-- di una riga ancora 'requested').
select owner_slug, borrower_slug, collection_item_id, count(*) as still_duplicated
from public.loans
where status = 'requested' and collection_item_id is not null
group by 1, 2, 3
having count(*) > 1;
