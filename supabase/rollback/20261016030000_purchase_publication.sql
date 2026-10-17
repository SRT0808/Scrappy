begin isolation level serializable;
-- Never discard published v2 history, even after a list was removed or mode reset.
select public.enter_purchase_operation();
lock table public.lists in access exclusive mode;
do $$ begin
  if exists(select 1 from purchase_publication_internal.publications) then
    raise exception 'Cannot reverse published purchase configurations';
  end if;
end $$;
drop function public.save_purchase_configuration(uuid,bigint,jsonb);
drop schema purchase_publication_internal cascade;
notify pgrst,'reload schema';
commit;
