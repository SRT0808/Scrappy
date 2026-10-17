begin;
-- Run before persistence/shadow rollback, with every external writer excluded.
do $$ declare r record;
begin
  if exists(select 1 from public.lists where purchase_mode<>'legacy')
    or exists(select 1 from public.purchase_evaluations where capture is not null) then
    raise exception 'Cannot reverse activated purchase writers';
  end if;
  for r in select * from purchase_writer_internal.originals order by name loop
    execute r.definition;
  end loop;
  for r in select * from purchase_writer_internal.grants loop
    execute format('grant %s on public.%I to service_role',r.privilege_type,r.table_name);
  end loop;
end $$;
grant execute on function public.snapshot_basket_change(),public.snapshot_exchange_rate_change(),public.version_basket_configuration() to service_role;
drop function public.mutate_product(uuid,text,jsonb),public.save_product_alert_state(uuid,timestamptz,jsonb,jsonb),public.record_notification(jsonb);
drop schema purchase_writer_internal cascade;
notify pgrst,'reload schema';
commit;
