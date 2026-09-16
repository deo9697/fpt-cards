-- P0 security — verifica live dopo supabase/migrations/20260916090000_
-- lockdown_bump_daily_mission.sql. Nessun accesso a un Postgres reale in
-- questa sessione: da eseguire in una sessione con accesso al DB (SQL
-- editor Supabase o psql), sostituendo <token_utente_reale> con un token di
-- sessione valido (da session_member/il login normale dell'app).

-- =====================================================================
-- 1) Il canale da chiudere: chiamata DIRETTA della RPC via PostgREST.
--    Prima della migration rispondeva 200 con un XP arbitrario accreditato.
--    Dopo: deve rispondere errore (permission denied / funzione non
--    esposta), sia via SQL diretto sia via l'endpoint REST.
-- =====================================================================
-- In SQL, impersonando il ruolo che PostgREST usa per una request anon/
-- authenticated (adatta al tuo setup locale se diverso):
set role anon;
select public.bump_daily_mission('<uno_slug_membro_reale>', 'daily_duel_log', 1, 1, 999999);
-- Atteso: ERROR: permission denied for function bump_daily_mission
reset role;

-- Equivalente via REST (da un client HTTP, non da qui):
--   POST {SUPABASE_URL}/rest/v1/rpc/bump_daily_mission
--   Authorization: Bearer <token_utente_reale>
--   apikey: <anon_key>
--   body: {"p_member":"<slug_a_piacere>","p_mission_id":"x","p_target":1,"p_delta":1,"p_xp_reward":999999}
-- Atteso: 404 (PostgREST non espone più la funzione a questo ruolo) o 403,
-- MAI 200/204 con un aggiornamento di member_progression.

-- =====================================================================
-- 2) Il canale da NON rompere: i 3 trigger devono continuare ad aggiornare
--    member_daily_missions/member_progression quando la riga arriva dai
--    percorsi reali (RPC di scrittura esistenti, non toccate da questa
--    migration).
-- =====================================================================
-- Prendi lo stato PRIMA:
select member_slug, mission_id, progress, completed_at
from public.member_daily_missions
where member_slug = '<uno_slug_membro_reale>' and mission_day = current_date;
select member_slug, total_xp, level from public.member_progression where member_slug = '<uno_slug_membro_reale>';

-- Poi, con lo stesso utente, dall'app reale (non da qui): registra un
-- duello (register_match), salva un mazzo nuovo (save_deck/save_deck_with_
-- box), e/o aggiungi carte in raccolta (save_collection_item/_batch/save_
-- fast_scan_chunk) fino a superare 100 pezzi in un giorno.

-- Poi rileggi lo stesso stato: progress/completed_at/total_xp devono essere
-- avanzati esattamente come prima della migration (i trigger sono SECURITY
-- DEFINER e chiamano bump_daily_mission come owner, indipendente dal REVOKE
-- da anon/authenticated).
select member_slug, mission_id, progress, completed_at
from public.member_daily_missions
where member_slug = '<uno_slug_membro_reale>' and mission_day = current_date;
select member_slug, total_xp, level from public.member_progression where member_slug = '<uno_slug_membro_reale>';

-- =====================================================================
-- 3) get_my_daily_missions (l'unica RPC missioni pensata per il client)
--    deve continuare a funzionare invariata.
-- =====================================================================
select public.get_my_daily_missions('<token_utente_reale>');
