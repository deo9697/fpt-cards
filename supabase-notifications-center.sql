-- F.P.T Cards — Notifiche push (senza centro notifiche in-app).
-- MIGRAZIONE ADDITIVA NON APPLICATA AUTOMATICAMENTE.
-- Eseguire dopo supabase-milestone-5-market-watch.sql.
--
-- Questa tabella non ha una UI in-app: serve solo da sorgente per il
-- Database Webhook Supabase (INSERT) che spedisce la push reale sul telefono
-- tramite api/send-notification-push.js. dedup_key protegge da doppie righe
-- (stesso evento notificato due volte) se lo scan gira più di una volta.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  member_slug text not null references public.team_members(slug) on delete cascade,
  category text not null default 'market_alert' check (category in ('market_alert','loan','system')),
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 500),
  route_page text not null default '',
  route_params jsonb not null default '{}'::jsonb,
  dedup_key text not null,
  source_table text not null default '',
  source_id uuid,
  created_at timestamptz not null default now(),
  unique (member_slug, dedup_key)
);
create index if not exists notifications_member_created_idx
  on public.notifications(member_slug, created_at desc);
alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;

notify pgrst,'reload schema';
