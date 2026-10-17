begin;
-- Installed locally only. Events are committed with evaluations; no sender is installed.
create schema purchase_notice_internal;
revoke all on schema purchase_notice_internal from public,anon,authenticated,service_role;
create table purchase_notice_internal.usage(id uuid primary key);
create table public.purchase_deliveries (
 event_id uuid not null references public.purchase_events(id) on delete cascade,
 channel text not null check(channel in ('ntfy','email')),
 status text not null default 'pending' check(status in ('pending','claimed','sent','failed','ambiguous')),
 receipt jsonb, primary key(event_id,channel)
);
alter table public.purchase_deliveries enable row level security;
revoke all on public.purchase_deliveries from public,anon,authenticated,service_role;
grant select on public.purchase_deliveries to service_role;

create function purchase_notice_internal.evaluate() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.purchase_configurations; s public.purchase_alert_state; rec jsonb:=new.result->'recommendation';
 eff jsonb:=new.result->'effective'; signature jsonb; old_total numeric; new_total numeric; saving numeric;
 budget_hit boolean:=false; winner_hit boolean:=false; safe boolean; event_id uuid; reasons text;
begin
 -- The insertion is inside the existing gate/list/runtime SERIALIZABLE commit.
 select * into c from public.purchase_configurations where (list_id,version)=(new.list_id,new.version);
 select * into s from public.purchase_alert_state where (list_id,version)=(new.list_id,new.version) for update;
 if not found then raise exception using errcode='PT409',message='missing_purchase_alert_state'; end if;
 insert into purchase_notice_internal.usage values(new.id);
 signature:=jsonb_build_object('alternativeIds',rec->'alternativeIds','purchases',
   (select coalesce(jsonb_agg(jsonb_build_object('offerId',p->>'offerId','purchaseUnits',p->>'purchaseUnits') order by p->>'offerId'),'[]') from jsonb_array_elements(rec->'purchases') p));
 safe:=eff->>'coverageComplete'='true' and eff->>'comparisonComplete'='true'
   and eff->>'searchComplete'='true' and eff->>'invalidPin'='false';
 if safe and c.budget_enabled and c.budget is not null then
   if not s.budget_reached and (eff->>'total')::numeric<=c.budget then
     budget_hit:=true; s.budget_reached:=true; s.budget_epoch:=s.budget_epoch+1;
   elsif s.budget_reached and (eff->>'total')::numeric>c.budget*1.03 then s.budget_reached:=false;
   end if;
 end if;
 if rec->>'coverageComplete'='true' and rec->>'searchComplete'='true' then
   if s.previous_purchase_signature is not null and signature->'purchases'<>s.previous_purchase_signature->'purchases'
     and not exists(select 1 from jsonb_array_elements(new.result->'exclusions') x
       where s.previous_purchase_signature->'alternativeIds' ? (x->>'alternativeId')) then
     -- Configuration is immutable within this version. An old feasible vector is
     -- still feasible iff all of its alternatives have current valid prices.
     select sum((p->>'purchaseUnits')::numeric*(o->>'price')::numeric*
       case when o->>'currency'=c.currency then 1 else (new.inputs#>>'{fx,multiplier}')::numeric end)
       into old_total from jsonb_array_elements(s.previous_purchase_signature->'purchases') p
       join jsonb_array_elements(new.inputs->'offers') o on o->>'id'=p->>'offerId';
     select sum((p->>'convertedAmount')::numeric) into new_total from jsonb_array_elements(rec->'purchases') p;
     saving:=old_total-new_total;
     winner_hit:=c.winner_enabled and saving>0 and saving>=c.minimum_savings;
   end if;
   -- Advance on every verified recommendation, including below-threshold changes.
   s.previous_purchase_signature:=signature;
 end if;
 update public.purchase_alert_state set last_evaluation_id=new.id,budget_reached=s.budget_reached,
   budget_epoch=s.budget_epoch,previous_purchase_signature=s.previous_purchase_signature,
   transition_number=s.transition_number+case when budget_hit or winner_hit then 1 else 0 end
   where (list_id,version)=(new.list_id,new.version);
 if budget_hit or winner_hit then
   reasons:=case when budget_hit and winner_hit then 'both' when budget_hit then 'budget' else 'winner' end;
   insert into public.purchase_events(list_id,version,evaluation_id,transition_number,reasons,payload)
   values(new.list_id,new.version,new.id,s.transition_number+1,reasons,jsonb_build_object(
     'reasons',reasons,'currency',c.currency,'effective_total',eff->>'total','budget',c.budget::text,
     'savings',case when winner_hit then round(saving,2)::text else null end,
     'recommendation',rec,'effective',eff,'basket_path','/?basket='||new.list_id::text,
     'offer_urls',(select coalesce(jsonb_agg(jsonb_build_object('offer_id',o.id,'url',p.url) order by o.id),'[]')
       from public.purchase_offers o join public.products p on p.id=o.product_id
       where (o.list_id,o.version)=(new.list_id,new.version)))) returning id into event_id;
   insert into public.purchase_deliveries(event_id,channel) values(event_id,'ntfy'),(event_id,'email');
 end if;
 return new;
end $$;
revoke all on function purchase_notice_internal.evaluate() from public,anon,authenticated,service_role;
create trigger purchase_notice_evaluation after insert on public.purchase_evaluations
 for each row execute function purchase_notice_internal.evaluate();

create function public.claim_purchase_delivery(p_event uuid,p_channel text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb;
begin
 perform public.enter_purchase_operation();
 update public.purchase_deliveries set status='claimed' where event_id=p_event and channel=p_channel and status='pending';
 if not found then return null; end if;
 select e.payload into payload from public.purchase_events e where id=p_event;
 return payload;
end $$;
create function public.finish_purchase_delivery(p_event uuid,p_channel text,p_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.enter_purchase_operation();
 if p_status not in ('sent','failed','ambiguous') or p_status is null then
   raise exception using errcode='PT400',message='invalid_delivery_status'; end if;
 update public.purchase_deliveries set status=p_status,receipt=jsonb_build_object('status',p_status)
   where event_id=p_event and channel=p_channel and status='claimed';
 if not found and not exists(select 1 from public.purchase_deliveries where event_id=p_event and channel=p_channel and status=p_status) then
   raise exception using errcode='PT409',message='delivery_conflict'; end if;
 -- Unfinished claims remain inspectable and are NEVER automatically reclaimed.
 update public.purchase_events e set status=case when exists(select 1 from public.purchase_deliveries d where d.event_id=e.id and d.status='sent') then 'sent' else 'failed' end
   where e.id=p_event and not exists(select 1 from public.purchase_deliveries d where d.event_id=e.id and d.status in ('pending','claimed'));
end $$;
revoke all on function public.claim_purchase_delivery(uuid,text),public.finish_purchase_delivery(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_purchase_delivery(uuid,text),public.finish_purchase_delivery(uuid,text,text) to service_role;
commit;
