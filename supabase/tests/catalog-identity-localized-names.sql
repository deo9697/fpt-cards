-- Run after catalog_identity_localized_names. Fixtures always roll back.
begin;
insert into public.card_printings(game,catalog_card_id,card_name,set_code,set_name,rarity,image_url)
values ('yugioh','96363153','Sintonizzare','REGRESSION-IT001','Regression','Common','https://images.ygoprodeck.com/images/cards/96363153.jpg');
do $$
begin
  if public.reconcile_catalog_identity('yugioh','96363153','REGRESSION-EN001','Tuning','https://images.ygoprodeck.com/images/cards/96363153.jpg') <> 'valid' then
    raise exception 'Translated name rejected';
  end if;
  if public.reconcile_catalog_identity('yugioh','96363153','REGRESSION-EN001','Tuning','https://images.ygoprodeck.com/images/cards/31849106.jpg') <> 'mismatch' then
    raise exception 'Conflicting image accepted';
  end if;
  if public.reconcile_catalog_identity('yugioh','31849106','REGRESSION-IT001','Different Dimension Ground','') <> 'mismatch' then
    raise exception 'Conflicting physical printing accepted';
  end if;
  if public.reconcile_catalog_identity(null,'96363153','REGRESSION-EN001','Tuning','') <> 'mismatch' then
    raise exception 'Missing game accepted';
  end if;
end;
$$;
rollback;
