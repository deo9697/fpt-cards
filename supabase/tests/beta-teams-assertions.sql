-- Test locale della migration 20261012140000_beta_teams.sql.
-- Uso (Postgres 16 usa-e-getta, NON produzione):
--   createdb beta_test
--   psql -d beta_test -f supabase/tests/beta-teams-fixture.sql
--   psql -d beta_test -f supabase/migrations/20261012140000_beta_teams.sql
--   psql -d beta_test -f supabase/migrations/20261012140000_beta_teams.sql   # idempotenza
--   psql -d beta_test -v ON_ERROR_STOP=1 -f supabase/tests/beta-teams-assertions.sql
\set ON_ERROR_STOP 1
set search_path = public, extensions;
insert into app_sessions values (digest('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx','sha256'),'daniele',now()+interval '1 day');
insert into app_sessions values (digest('tok-cristofer-xxxxxxxxxxxxxxxxxxxxxxxxxxx','sha256'),'cristofer',now()+interval '1 day');
create temp table v(k text primary key, val text);
create function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'atteso errore "%" ma la query è riuscita: %', p_like, p_sql;
exception when others then
  if sqlerrm not like p_like then raise exception 'errore inatteso per %: %', p_sql, sqlerrm; end if;
end $$;

insert into v select 'inv1', create_team_invite('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx','new_team',5,7)->>'code';
do $$ begin assert (get_invite_info((select val from v where k='inv1'))->>'mode') = 'new_team'; end $$;
insert into v select 'alice', register_with_invite((select val from v where k='inv1'),'Àlice  Rossi','1234','Alpha Squad','tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')->>'slug';
do $$ begin assert (select val from v where k='alice') ~ '^alice-rossi-[0-9a-f]{4}$', 'slug normalizzato'; end $$;

select pg_temp.expect_error($q$select create_team_invite('tok-cristofer-xxxxxxxxxxxxxxxxxxxxxxxxxxx','my_team',1,1)$q$, 'Solo il creatore%');
select pg_temp.expect_error($q$select create_team_invite('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','new_team',1,1)$q$, 'Solo l''amministratore%');

insert into v select 'inv2', create_team_invite('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','my_team',1,7)->>'code';
insert into v select 'bob', register_with_invite((select val from v where k='inv2'),'Bob','5678','ignorato','tok-bob-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')->>'slug';
select pg_temp.expect_error(format($q$select register_with_invite(%L,'Carl','5678','x','tok-carl-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')$q$, (select val from v where k='inv2')), '%non è valido%');

do $$ declare alice text := (select val from v where k='alice'); bob text := (select val from v where k='bob'); begin
  assert (select string_agg(slug, ',' order by slug) from list_login_members()) = 'cristofer,daniele', 'login: solo team core';
  assert (select count(*) from list_team_members('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = 2;
  assert (get_my_team('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')->>'isOwner')::boolean;
  assert not (get_my_team('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx')->>'isOwner')::boolean;

  insert into card_printings(id,card_name,catalog_card_id,set_code) values ('00000000-0000-0000-0000-000000000001','Dark Magician','46986414','LOB-005');
  truncate realtime.sent;
  insert into collection_items(owner_slug,printing_id) select s,'00000000-0000-0000-0000-000000000001' from unnest(array['daniele','cristofer',alice,bob]) s;
  assert (select count(*) from realtime.sent where topic like 'fpt-collection:%') = 2, 'un broadcast per team';
  assert (select count(*) from realtime.sent where topic = 'fpt-collection') = 1, 'canale storico solo per il core';
  assert (select payload->'members' from realtime.sent where topic like 'fpt-collection:%' and payload->'members' ? alice) ? bob;

  assert (select string_agg(distinct owner_slug, ',') from list_team_collection('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = least(alice,bob)||','||greatest(alice,bob);
  assert (select string_agg(distinct owner_slug, ',' order by owner_slug) from list_team_collection('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = 'cristofer,daniele';
  assert (select count(*) from list_member_profiles('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = 2;
  assert (select count(*) from list_member_avatars('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = 2;

  insert into decks(owner_slug,name) values ('daniele','deck daniele'),(alice,'deck alice');
  assert (select string_agg(owner_slug, ',') from list_team_decks('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = alice;

  insert into loans(card_name,owner_slug,borrower_slug) values ('x',alice,bob),('y','daniele','cristofer');
  assert (select count(*) from list_team_loans('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx')) = 1, 'admin vede solo i prestiti del suo team';

  insert into matches(member_slug,opponent_member_slug,result,deck_id) values (alice,bob,'win',(select id from decks where owner_slug=alice)),('daniele','cristofer','win',(select id from decks where owner_slug='daniele'));
  assert (select count(*) from get_head_to_head('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','yugioh')) = 1;
  assert (select string_agg(member_slug, ',') from get_team_stats('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx','yugioh')) = 'daniele';

  insert into team_members(slug,full_name) values ('nuovo','Nuovo');
  assert (select team_id from team_members where slug='nuovo') = core_team_id(), 'membri aggiunti dall''admin restano nel core';
end $$;

select pg_temp.expect_error(format($q$insert into loans(card_name,owner_slug,borrower_slug) values ('x','daniele',%L)$q$, (select val from v where k='alice')), '%solo con i membri del tuo team%');
select pg_temp.expect_error(format($q$insert into matches(member_slug,opponent_member_slug,result) values ('daniele',%L,'win')$q$, (select val from v where k='alice')), '%solo contro i membri del tuo team%');

select set_beta_signups('tok-daniele-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', false);
do $$ begin assert not (get_invite_info((select val from v where k='inv1'))->>'valid')::boolean, 'iscrizioni chiuse'; end $$;
select pg_temp.expect_error($q$select set_beta_signups('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', true)$q$, 'Solo l''amministratore%');
select rename_my_team('tok-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx','Alpha 2');
do $$ begin assert (select name from teams where kind='beta') = 'Alpha 2'; end $$;
select 'beta-teams: tutte le asserzioni passate' as result;
