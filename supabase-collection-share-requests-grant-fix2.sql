-- Fix: "permission denied for function list_collection_share_requests"
-- tornato dopo aver applicato supabase-collection-share-request-prices.sql.
-- Causa: quel file riportava per errore il grant di questa funzione a solo
-- `authenticated`, sovrascrivendo il grant a `anon, authenticated` che
-- aveva già risolto lo stesso problema in precedenza
-- (supabase-collection-sharing-grants-fix.sql). In questo progetto i grant
-- solo su `authenticated` non si sono mai dimostrati affidabili per queste
-- funzioni — riallineato a `anon, authenticated` come le altre.

revoke all on function public.list_collection_share_requests(text) from public, anon, authenticated;
grant execute on function public.list_collection_share_requests(text) to anon, authenticated;

notify pgrst, 'reload schema';
