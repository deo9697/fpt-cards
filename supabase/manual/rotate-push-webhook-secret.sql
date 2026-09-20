-- MANUALE — rotazione del secret dei webhook push (trigger DB → funzioni Vercel).
-- NON è una migration. Il valore nuovo NON va scritto nel repo: sostituisci :NEW_SECRET solo nella
-- copia che incolli nel SQL Editor (genera il valore con `openssl rand -hex 32`).
--
-- PRIMA (blocco esterno, serve accesso Vercel):
--   0) Le funzioni Vercel oggi crashano (FUNCTION_INVOCATION_FAILED, package "type":"module" con codice
--      CommonJS): fai il deploy di api/*.js in versione ESM (già nel repo) e verifica
--      GET https://fpt-cards.vercel.app/api/push-public-key → 200.
--   1) Vercel → Settings → Environment Variables: aggiungi PUSH_WEBHOOK_SECRET_NEXT = <nuovo valore>
--      (Production) e rifai il deploy. Da ora la funzione accetta VECCHIO e NUOVO.
-- POI (questo script): aggiorna i due trigger al nuovo valore.
-- DOPO:
--   3) Test end-to-end (sotto). 4) Vercel: PUSH_WEBHOOK_SECRET = <nuovo valore>, elimina
--      PUSH_WEBHOOK_SECRET_NEXT, deploy → il vecchio secret non vale più.
--   5) Se quel vecchio valore è comparso in log/chat/dump, il passo 4 è ciò che lo invalida davvero.
--
-- Rollback dei trigger: ricrearli con il valore precedente (finché PUSH_WEBHOOK_SECRET lo accetta ancora).

begin;
drop trigger if exists "fpt-web-push" on public.loans;
create trigger "fpt-web-push" after insert or update on public.loans for each row
  execute function supabase_functions.http_request('https://fpt-cards.vercel.app/api/send-push', 'POST',
    '{"Content-type":"application/json","x-webhook-secret":":NEW_SECRET"}', '{}', '10000');
drop trigger if exists "notification-push" on public.notifications;
create trigger "notification-push" after insert on public.notifications for each row
  execute function supabase_functions.http_request('https://fpt-cards.vercel.app/api/send-notification-push', 'POST',
    '{"x-webhook-secret":":NEW_SECRET"}', '{}', '5000');
commit;

-- Test end-to-end SENZA dispositivo (usa un membro sintetico o un membro senza push):
--   insert into notifications(member_slug, category, title, dedup_key) values ('<slug>', 'system', 'test push', 'rot-test-1');
--   -- dopo ~5 s:
--   select status_code, left(content, 100) from net._http_response order by created desc limit 3;
--   Atteso: 200 {"message":"Notifiche inviate: 0"} (nessuna sottoscrizione). 401 = secret diverso; 500 = funzione ancora crashata.
--   Pulizia: delete from notifications where dedup_key = 'rot-test-1';
-- Nota: i cron 'fpt-market-*' leggono il secret da Supabase Vault (verificato: nessun valore in chiaro nella command).
-- Il secret push è l'unico in chiaro nei trigger DB.
