begin isolation level serializable;
select public.enter_purchase_operation();
lock table public.purchase_evaluations in access exclusive mode;
do $$ begin
 if exists(select 1 from purchase_notice_internal.usage) then raise exception 'Cannot reverse used purchase notices'; end if;
end $$;
drop trigger purchase_notice_evaluation on public.purchase_evaluations;
drop function public.claim_purchase_delivery(uuid,text),public.finish_purchase_delivery(uuid,text,text);
drop table public.purchase_deliveries;
drop schema purchase_notice_internal cascade;
commit;
