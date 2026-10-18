begin;
create table public.purchase_activations (
 list_id uuid primary key references public.lists(id) on delete cascade,
 request_id uuid not null unique, expected_version bigint not null,
 request_hash text not null, receipt jsonb not null
);
alter table public.purchase_activations enable row level security;
revoke all on public.purchase_activations from public,anon,authenticated,service_role;

-- Rebuild the conversion from current memberships, never the historical shadow.
create function public.preview_purchase_activation(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l public.lists; c jsonb; source jsonb;
begin
 select * into l from public.lists where id=p_id;
 if not found then raise exception using errcode='PT404',message='basket_not_found'; end if;
 if l.purchase_mode<>'legacy' then raise exception using errcode='PT409',message='already_activated'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('item',to_jsonb(i),'product',to_jsonb(p)) order by i.position,i.id),'[]')
 into source from public.basket_items i join public.products p on p.id=i.product_id where i.list_id=p_id;
 c:=jsonb_build_object('schema_version',2,'currency',l.currency,'budget',l.budget::text,
  'budget_enabled',false,'winner_enabled',false,'minimum_savings','0.00',
  'needs',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',left(coalesce(nullif(p.name,''),'Producto'),100),
    'required_quantity',i.quantity::text,'unit','unit','position',i.position,'allow_surplus',false) order by i.position,i.id)
    from public.basket_items i join public.products p on p.id=i.product_id where i.list_id=p_id),'[]'),
  'offers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'product_id',product_id,'max_purchase_units',null,
    'coverage',jsonb_build_array(jsonb_build_object('need_id',id,'quantity','1')),'extras','[]'::jsonb) order by position,id)
    from public.basket_items where list_id=p_id),'[]'),
  'alternatives',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',left(coalesce(nullif(p.name,''),'Producto'),100),
    'position',i.position,'scope',jsonb_build_array(i.id),'items',jsonb_build_array(jsonb_build_object('offer_id',i.id,'purchase_units',i.quantity))) order by i.position,i.id)
    from public.basket_items i join public.products p on p.id=i.product_id where i.list_id=p_id),'[]'),
  'pins','[]'::jsonb,'reference',coalesce((select jsonb_agg(id order by position,id) from public.basket_items where list_id=p_id),'[]'));
 return jsonb_build_object('schema_version',2,'list_id',p_id,'version',l.composition_version::text,
  'token',public.purchase_hash(jsonb_build_object('list',to_jsonb(l),'sources',source)),'configuration',c);
end $$;

create function public.read_purchase_activation(p_id uuid,p_request_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema_version',2,'list_id',p_id,'request_id',p_request_id,
  'receipt',(select receipt from public.purchase_activations where list_id=p_id and request_id=p_request_id))
$$;

create function public.activate_purchase_configuration(p_id uuid,p_expected_version bigint,p_request_id uuid,p_token text,p_configuration jsonb) returns jsonb
language plpgsql security definer set search_path='' set default_transaction_isolation='serializable' as $$
declare l public.lists; preview jsonb; c jsonb; r public.purchase_activations; h text; answer jsonb;
begin
 perform public.enter_purchase_operation();
 select * into l from public.lists where id=p_id for update;
 if not found then raise exception using errcode='PT404',message='basket_not_found'; end if;
 if p_request_id is null or p_expected_version is null or p_token is null or p_configuration is null then
  raise exception using errcode='PT400',message='invalid_activation'; end if;
 h:=public.purchase_hash(jsonb_build_object('version',p_expected_version::text,'token',p_token,'configuration',p_configuration));
 select * into r from public.purchase_activations where list_id=p_id;
 if found then
  if r.request_id=p_request_id and r.request_hash=h then return r.receipt; end if;
  raise exception using errcode='PT409',message='activation_conflict';
 end if;
 if l.purchase_mode<>'legacy' or l.composition_version<>p_expected_version then
  raise exception using errcode='PT409',message='activation_conflict'; end if;
 preview:=public.preview_purchase_activation(p_id);
 if preview->>'token'<>p_token then raise exception using errcode='PT409',message='activation_sources_changed'; end if;
 -- A nonempty legacy graph is conserved exactly; only notice choices may differ.
 if jsonb_array_length(preview->'configuration'->'needs')>0 and
  (p_configuration-'budget_enabled'-'winner_enabled'-'minimum_savings') is distinct from
  ((preview->'configuration')-'budget_enabled'-'winner_enabled'-'minimum_savings') then
  raise exception using errcode='PT400',message='conversion_must_preserve_memberships'; end if;
 if jsonb_typeof(p_configuration->'needs') is distinct from 'array' or jsonb_array_length(p_configuration->'needs')=0 then
  raise exception using errcode='PT400',message='explicit_graph_required'; end if;
 -- The existing publisher validates graph/units/limits and invalidates runtime.
 -- All intermediate mode/version changes roll back on any failure.
 update public.lists set purchase_mode='alternatives' where id=p_id;
 c:=public.save_purchase_configuration(p_id,p_expected_version,p_configuration);
 update public.purchase_needs n set legacy_item_id=i.id,created_at=i.created_at
 from public.basket_items i where i.list_id=p_id and n.list_id=p_id
  and n.version=(c->>'version')::bigint and n.id=i.id;
 c:=jsonb_set(c,'{needs}',(select jsonb_agg((to_jsonb(n)-'list_id'-'version')||
  jsonb_build_object('required_quantity',n.required_quantity::text) order by n.position,n.id)
  from public.purchase_needs n where n.list_id=p_id and n.version=(c->>'version')::bigint));
 update public.purchase_configurations set configuration=c where list_id=p_id and version=(c->>'version')::bigint;
 answer:=jsonb_build_object('schema_version',2,'list_id',p_id,'request_id',p_request_id,
  'previous_version',p_expected_version::text,'version',c->>'version','configuration',c);
 insert into public.purchase_activations values(p_id,p_request_id,p_expected_version,h,answer);
 return answer;
exception when integrity_constraint_violation or data_exception then
 raise exception using errcode='PT400',message='invalid_activation_graph';
end $$;
revoke all on function public.preview_purchase_activation(uuid),public.read_purchase_activation(uuid,uuid),
 public.activate_purchase_configuration(uuid,bigint,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.preview_purchase_activation(uuid),public.read_purchase_activation(uuid,uuid),
 public.activate_purchase_configuration(uuid,bigint,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
