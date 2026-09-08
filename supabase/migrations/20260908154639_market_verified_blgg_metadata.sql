-- Verified against Konami's card database, 2026-09-08:
-- https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=22501&ope=2&request_locale=en
-- https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=22503&ope=2&request_locale=en
-- Preserve printing UUIDs and inventory references; conflicting duplicates abort.
update public.card_printings
set card_name='Shadowreaver Knight 21', rarity='Ultra Rare', updated_at=now()
where game='yugioh' and catalog_card_id='95506252'
  and set_code in ('BLGG-EN046','BLGG-IT046')
  and rarity in ('New','Common');
update public.card_printings
set card_name='First Striker Advantage', rarity='Ultra Rare', updated_at=now()
where game='yugioh' and catalog_card_id='58995660'
  and set_code in ('BLGG-EN048','BLGG-IT048')
  and rarity in ('New','Common');
