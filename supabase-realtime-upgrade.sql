-- Aggiornamento realtime senza esporre dati nel broadcast.
create or replace function public.broadcast_loan_change()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
begin
  perform realtime.send(
    jsonb_build_object('changed', true),
    'loans_changed',
    'fpt-loans',
    false
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists broadcast_fpt_loan_change on public.loans;
create trigger broadcast_fpt_loan_change
after insert or update or delete on public.loans
for each row execute function public.broadcast_loan_change();
