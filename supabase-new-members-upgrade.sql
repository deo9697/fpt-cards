-- Nuovi membri F.P.T. Tutti entrano come guest e scelgono il PIN al primo accesso.
insert into public.team_members (slug, full_name, role) values
  ('giuseppe-ventre', 'Giuseppe Ventre', 'guest'),
  ('antonio-donato', 'Antonio Donato', 'guest'),
  ('vittorio-oro-jackson', 'Vittorio Oro Jackson', 'guest'),
  ('mirco-sposato', 'Mirco Sposato', 'guest'),
  ('ivo-scalercio', 'Ivo Scalercio', 'guest'),
  ('antonello-napolitano', 'Antonello Napolitano', 'guest'),
  ('matteo-scorza', 'Matteo Scorza', 'guest'),
  ('vincenzo-de-marco', 'Vincenzo De Marco', 'guest')
on conflict (slug) do update
  set full_name = excluded.full_name,
      role = 'guest';
