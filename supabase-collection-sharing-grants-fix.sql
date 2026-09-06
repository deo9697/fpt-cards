-- Fix: "permission denied for function create_collection_share" dopo aver
-- eseguito supabase-collection-sharing.sql — il grant a `authenticated` non
-- ha avuto effetto (probabilmente lo script si è fermato prima di quel
-- blocco, o quel singolo grant non è stato applicato). Questo file riapplica
-- i grant in modo esplicito e idempotente, allargandoli anche ad `anon` per
-- allinearli alle due funzioni ospite (get_collection_share,
-- submit_collection_share_request) che sappiamo già raggiungibili: la vera
-- verifica di identità resta comunque dentro ogni funzione via
-- session_member(p_token), quindi non riduce la sicurezza.

revoke all on function
  public.create_collection_share(text,text), public.revoke_collection_share(text,uuid),
  public.list_collection_shares(text), public.get_collection_share(uuid),
  public.submit_collection_share_request(uuid,text,jsonb),
  public.list_collection_share_requests(text), public.mark_collection_share_request_seen(text,uuid)
  from public, anon, authenticated;

grant execute on function
  public.create_collection_share(text,text), public.revoke_collection_share(text,uuid),
  public.list_collection_shares(text), public.get_collection_share(uuid),
  public.submit_collection_share_request(uuid,text,jsonb),
  public.list_collection_share_requests(text), public.mark_collection_share_request_seen(text,uuid)
  to anon, authenticated;

notify pgrst, 'reload schema';
