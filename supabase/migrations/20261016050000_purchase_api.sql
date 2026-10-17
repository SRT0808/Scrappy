begin;
-- One MVCC snapshot for configuration, authoritative freshness and delivery history.
-- No activation, evaluation, delivery claim or source mutation.
create function public.read_purchase_configuration(p_id uuid,p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l public.lists; c jsonb; e jsonb; events jsonb;
begin
 if p_page is null or p_page<0 or p_page>10000 then
   raise exception using errcode='PT400',message='invalid_purchase_page';
 end if;
 select * into l from public.lists where id=p_id;
 if not found then raise exception using errcode='PT404',message='basket_not_found'; end if;
 if l.purchase_mode='alternatives' then
   select configuration into c from public.purchase_configurations where (list_id,version)=(p_id,l.composition_version);
   if c is null then raise exception using errcode='PT409',message='missing_purchase_configuration'; end if;
 end if;
 e:=public.read_current_purchase_evaluation(p_id);
 select coalesce(jsonb_agg(j order by version desc,transition_number desc),'[]') into events from (
   select ev.version,ev.transition_number,jsonb_build_object(
     'id',ev.id,'version',ev.version::text,'evaluation_id',ev.evaluation_id,
     'transition_number',ev.transition_number::text,'reasons',ev.reasons,'status',ev.status,'payload',ev.payload,
     'deliveries',coalesce((select jsonb_agg(jsonb_build_object('channel',d.channel,'status',d.status,'receipt',d.receipt) order by d.channel)
       from public.purchase_deliveries d where d.event_id=ev.id),'[]')) j
   from public.purchase_events ev where ev.list_id=p_id
   order by ev.version desc,ev.transition_number desc limit 21 offset p_page*20
 ) history;
 return jsonb_build_object('schema_version',2,'list_id',l.id,'mode',l.purchase_mode,'version',l.composition_version::text,
   'configuration',c,'latest_evaluation',case when e->>'evaluation_id' is not null then e-'capture'-'stale_reason' else null end,
   'stale_reason',e->'stale_reason','events',(select coalesce(jsonb_agg(value order by ord),'[]') from jsonb_array_elements(events) with ordinality a(value,ord) where ord<=20),
   'has_more',jsonb_array_length(events)>20);
end $$;
revoke all on function public.read_purchase_configuration(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_purchase_configuration(uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
