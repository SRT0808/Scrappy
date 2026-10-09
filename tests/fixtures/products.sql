set local role service_role;
do $$
declare
  v_list uuid;
  v_id uuid := gen_random_uuid();
  v_failed uuid := gen_random_uuid();
  v_ambiguous uuid := gen_random_uuid();
  v_product uuid;
  v_read jsonb;
  v_result jsonb := '{"name":"SQL product","price":"100.00","currency":"PEN","original_price":"120.00","image_url":null,"method":"heuristic","confidence":0.9,"candidates":[],"warnings":[]}';
  v_confirmation jsonb;
  v_function regprocedure;
begin
  foreach v_function in array array['public.create_product_reading(uuid,text,text)'::regprocedure,
    'public.claim_product_reading(uuid)'::regprocedure,'public.complete_product_reading(uuid,jsonb,jsonb)'::regprocedure,
    'public.confirm_product_reading(uuid,jsonb)'::regprocedure] loop
    if has_function_privilege('anon',v_function,'EXECUTE') or has_function_privilege('authenticated',v_function,'EXECUTE')
      or (select prosecdef from pg_proc where oid = v_function) then raise exception 'Invalid reading RPC privileges'; end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.product_readings'::regclass)
    or has_table_privilege('anon','public.product_readings','SELECT') then raise exception 'Invalid reading RLS'; end if;
  v_list := (public.mutate_list('create',p_name => 'Product SQL fixture')->>'id')::uuid;
  v_confirmation := jsonb_build_object('list_id',v_list,'name','SQL product','currency','PEN','candidate_index',null,
    'reference_price','120.00','target_type','percent','target_value','25','check_interval_hours',6);
  v_read := public.create_product_reading(v_id,'https://fixture.example/product');
  if v_read->>'status' <> 'queued' or v_read->>'product_id' is not null then raise exception 'Premature activation'; end if;
  perform public.create_product_reading(v_id,'https://fixture.example/product');
  if (select count(*) from public.product_readings where id = v_id) <> 1 then raise exception 'Duplicate reading'; end if;
  begin
    perform public.create_product_reading(v_id,'https://fixture.example/other'); raise exception 'ID overwrite';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.confirm_product_reading(v_id,v_confirmation); raise exception 'Queued confirmation';
  exception when sqlstate 'PT409' then null; end;
  if public.claim_product_reading(v_id) is null or public.claim_product_reading(v_id) is not null then raise exception 'Duplicate claim'; end if;
  perform public.complete_product_reading(v_id,v_result,'{"fetch_mode":"http"}');
  begin
    perform public.complete_product_reading(v_id,v_result,'{}'); raise exception 'Stale completion';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.confirm_product_reading(v_id,v_confirmation || '{"currency":"USD"}'); raise exception 'Currency mismatch';
  exception when sqlstate 'PT400' then null; end;
  begin
    perform public.confirm_product_reading(v_id,v_confirmation || jsonb_build_object('list_id',gen_random_uuid())); raise exception 'Missing list';
  exception when sqlstate 'PT404' then null; end;
  if (select status from public.product_readings where id = v_id) <> 'ready' then raise exception 'Failed confirmation changed reading'; end if;
  v_read := public.confirm_product_reading(v_id,v_confirmation);
  v_product := (v_read->>'product_id')::uuid;
  if v_read->>'status' <> 'confirmed' or (public.confirm_product_reading(v_id,v_confirmation)->>'product_id')::uuid <> v_product then raise exception 'Non-idempotent confirmation'; end if;
  if not exists(select 1 from public.products where id = v_product and status = 'active' and alert_state = 'armed'
    and last_price = 100 and reference_price = 120 and target_price = 90 and target_percent = 25 and check_interval_hours = 6) then raise exception 'Wrong saved product'; end if;
  if (select count(*) from public.price_checks where product_id = v_product and ok) <> 1 then raise exception 'Duplicate initial history'; end if;
  begin
    perform public.mutate_list('delete',v_list); raise exception 'Nonempty list deleted';
  exception when foreign_key_violation then null; end;
  perform public.create_product_reading(v_failed,'https://fixture.example/failure');
  perform public.claim_product_reading(v_failed);
  perform public.complete_product_reading(v_failed,v_result || '{"price":null}', '{}');
  begin
    perform public.confirm_product_reading(v_failed,v_confirmation); raise exception 'Failed reading activated';
  exception when sqlstate 'PT409' then null; end;
  perform public.create_product_reading(v_ambiguous,'https://fixture.example/ambiguous');
  perform public.claim_product_reading(v_ambiguous);
  perform public.complete_product_reading(v_ambiguous,v_result || '{"confidence":0.5,"candidates":[{"price":"85.00","currency":"PEN","context":"Sale","selector":".sale"}]}','{}');
  begin
    perform public.confirm_product_reading(v_ambiguous,v_confirmation); raise exception 'Ambiguous default accepted';
  exception when sqlstate 'PT400' then null; end;
  v_read := public.confirm_product_reading(v_ambiguous,v_confirmation || '{"candidate_index":0,"target_type":"price","target_value":"0"}');
  if not exists(select 1 from public.products where id = (v_read->>'product_id')::uuid and last_price = 85 and target_price = 0 and target_percent is null) then raise exception 'Wrong selected candidate'; end if;
  if not exists(select 1 from public.domain_recipes where domain = 'fixture.example' and price_selector = '.sale'
    and adaptive_state->'confirmed_candidates'->'https://fixture.example/ambiguous'->>'selector' = '.sale') then raise exception 'Selection not learned'; end if;
  begin
    perform public.confirm_product_reading(gen_random_uuid(),v_confirmation); raise exception 'Missing reading';
  exception when sqlstate 'PT404' then null; end;
end $$;
