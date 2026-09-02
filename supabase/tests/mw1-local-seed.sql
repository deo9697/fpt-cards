\set ON_ERROR_STOP on

insert into public.card_printings(id,game,catalog_card_id,card_name,set_code,set_name,rarity,image_url) values
('10000000-0000-0000-0000-000000000001','yugioh','96334243','Sea Monster of Theseus','MP17-DE231','2017 Mega-Tin Mega Pack','Secret Rare','sea.jpg'),
('10000000-0000-0000-0000-000000000002','yugioh','90673288','Sky Striker Ace - Shizuku','L26D-ENS26','Legendary Modern Decks 2026','Common','shizuku-common.jpg'),
('10000000-0000-0000-0000-000000000003','yugioh','90673288','Sky Striker Ace - Shizuku','L26D-ENS26','Legendary Modern Decks 2026','Starlight Rare','shizuku-starlight.jpg'),
('10000000-0000-0000-0000-000000000004','yugioh','6560411','Bramble Rose Dragon','DOOD-IT039','Destino delle Dimensioni','Secret Rare','bramble-secret.jpg'),
('10000000-0000-0000-0000-000000000005','yugioh','6560411','Bramble Rose Dragon','DOOD-IT039','Destino delle Dimensioni','Starlight Rare','bramble-starlight.jpg'),
('10000000-0000-0000-0000-000000000006','yugioh','90000006','Armament Reincarnation','TEST-IT006','Test Set','3','armament.jpg'),
('10000000-0000-0000-0000-000000000007','yugioh','90000007','Fairy Tail - Wiccat','TEST-IT007','Missing Set','Common','wiccat.jpg');

insert into public.collection_items(id,owner_slug,printing_id,language,condition,edition,quantity_owned)
select gen_random_uuid(),'daniele',id,case when set_code='MP17-DE231' then 'Tedesco' else 'Italiano' end,'Near Mint','Prima Edizione',1
from public.card_printings;

insert into public.decks(id,owner_slug,game,name) values
('20000000-0000-0000-0000-000000000001','daniele','yugioh','MW1 locale');
insert into public.deck_cards(deck_id,catalog_card_id,card_name,section,quantity,printing_id) values
('20000000-0000-0000-0000-000000000001','96334243','Sea Monster of Theseus','main',1,'10000000-0000-0000-0000-000000000001');

insert into public.market_provider_printings(id,printing_id,provider,provider_product_id,variant_key,language,condition_reference,edition,resolution_status,confidence,provider_metadata) values
('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','cardmarket','9001','default','','Price Guide Cardmarket','','resolved',0.8800,'{}'),
('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','cardmarket','9002','default','','Price Guide Cardmarket','','manual',1.0000,'{"active":"true","resolverStatus":"manual"}'),
('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004','cardmarket','9003','default','','Price Guide Cardmarket','','resolved',1.0000,'{"active":"true","resolverStatus":"PROVIDER_AGGREGATE","resolverVersion":"2","priceScope":{"language":"aggregate","edition":"aggregate","rarity":"aggregate","foil":"parallel_columns_unassigned"}}'),
('30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','cardmarket',null,'default','','Price Guide Cardmarket','','ambiguous',0.0000,'{"active":"false","resolverStatus":"AMBIGUOUS"}'),
('30000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000006','cardmarket',null,'default','','Price Guide Cardmarket','','unresolved',0.0000,'{"active":"false","resolverStatus":"UNSUPPORTED"}'),
('30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000007','cardmarket',null,'default','','Price Guide Cardmarket','','unresolved',0.0000,'{"active":"false","resolverStatus":"UNRESOLVED"}'),
('30000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000001','cardmarket','8999','superseded','','Price Guide Cardmarket','','resolved',0.9900,'{"active":"false","resolverStatus":"EXACT","superseded":true}');

insert into public.market_price_snapshots(id,printing_id,provider_mapping_id,provider,price_type,original_currency,original_price,normalized_currency,normalized_price,captured_at,observation_key,metadata) values
('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','cardmarket','trend','EUR',10,'EUR',10,now()-interval '8 days','sea-old','{}'),
('40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','cardmarket','trend','EUR',12,'EUR',12,now()-interval '1 hour','sea-new','{}'),
('40000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','cardmarket','trend','EUR',5,'EUR',5,now()-interval '1 hour','manual-new','{}'),
('40000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000003','cardmarket','trend','EUR',7,'EUR',7,now()-interval '1 hour','aggregate-new','{}'),
('40000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000004','cardmarket','trend','EUR',99,'EUR',99,now()-interval '1 hour','ambiguous-new','{}'),
('40000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007','cardmarket','trend','EUR',88,'EUR',88,now()-interval '30 minutes','superseded-new','{}');

insert into public.market_watch_items(member_slug,printing_id) values ('daniele','10000000-0000-0000-0000-000000000001');
insert into public.market_provider_sync_runs(id,provider,status,started_at,finished_at,last_success_at,request_count,attempt_count,metadata)
values ('50000000-0000-0000-0000-000000000001','cardmarket','succeeded',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour',2,1,'{"local":true}');
