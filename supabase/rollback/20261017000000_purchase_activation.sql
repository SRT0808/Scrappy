begin;
-- Pre-activation local recovery only. Never discard a durable receipt.
do $$ begin
 if exists(select 1 from public.purchase_activations) then
  raise exception 'activation_receipts_exist_restore_compatible_code';
 end if;
end $$;
drop function public.activate_purchase_configuration(uuid,bigint,uuid,text,jsonb);
drop function public.read_purchase_activation(uuid,uuid);
drop function public.preview_purchase_activation(uuid);
drop table public.purchase_activations;
notify pgrst,'reload schema';
commit;
