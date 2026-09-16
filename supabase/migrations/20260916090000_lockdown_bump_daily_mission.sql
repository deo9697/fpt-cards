-- F.P.T Cards — P0 security: chiudere l'accesso esterno diretto a
-- bump_daily_mission().
--
-- ROOT CAUSE: bump_daily_mission() (supabase-milestone-10-daily-missions.sql,
-- poi ridefinita in supabase-fast-scan-mission-trigger-perf.sql) è commentata
-- come "Helper interno (non esposto via RPC, stesso trattamento di
-- session_member/level_from_xp)", ma a differenza di session_member() non ha
-- MAI ricevuto il `revoke all ... from public, anon, authenticated` che
-- questo progetto usa per ogni helper interno (vedi supabase-secure-pin-
-- upgrade.sql riga 30). PostgreSQL concede EXECUTE a PUBLIC per default a
-- ogni nuova funzione, e PostgREST espone qualunque funzione public() con
-- EXECUTE per anon/authenticated come RPC — quindi bump_daily_mission era
-- chiamabile direttamente come POST /rest/v1/rpc/bump_daily_mission con
-- p_member/p_mission_id/p_delta/p_xp_reward ARBITRARI: chiunque poteva
-- accreditare XP a qualsiasi member_slug bypassando i trigger e i loro
-- controlli di provenienza (partita/mazzo/collezione realmente registrati).
--
-- FIX: solo un REVOKE, nessuna modifica alla funzione (stessa firma/body di
-- supabase-fast-scan-mission-trigger-perf.sql, invariata).
--
-- Perché NON rompe i trigger: mission_on_match_insert/mission_on_deck_insert/
-- mission_on_collection_change sono anch'essi SECURITY DEFINER e chiamano
-- bump_daily_mission() con `perform` da PLpgSQL — quella chiamata gira con il
-- ruolo OWNER delle funzioni (chi ha eseguito le migration, mai anon/
-- authenticated), che mantiene sempre il diritto di eseguire le proprie
-- funzioni indipendentemente da REVOKE ALL FROM public/anon/authenticated.
-- Il REVOKE blocca solo la chiamata DIRETTA via PostgREST con il JWT di un
-- utente reale (ruolo anon/authenticated), esattamente il canale da chiudere.
--
-- Verifica dopo l'esecuzione: POST /rest/v1/rpc/bump_daily_mission con un
-- token utente valido deve rispondere 404/permission denied (funzione non
-- più visibile/eseguibile per quel ruolo); get_my_daily_missions e i 3
-- trigger (aggiunta carte, salvataggio deck, registrazione match) devono
-- continuare ad aggiornare member_daily_missions/member_progression come
-- prima — copertura in scripts/mission-security-lockdown-smoke.mjs.

revoke all on function public.bump_daily_mission(text, text, integer, integer, integer)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
