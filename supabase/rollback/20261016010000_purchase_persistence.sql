begin;
-- Local rollback only. Never discard captured history or active alternatives.
do $$ begin
 if exists(select 1 from public.purchase_evaluations where archive is not null)
    or exists(select 1 from public.lists where purchase_mode='alternatives') then
   raise exception using errcode='PT409',message='Cannot reverse active purchase persistence';
 end if;
end $$;
drop trigger purchase_evaluation_immutable on public.purchase_evaluations;
drop function public.reject_purchase_evaluation_update();
drop function public.read_current_purchase_evaluation(uuid);
drop function public.commit_purchase_evaluation(uuid,bigint,text,jsonb);
drop function public.invalidate_purchase_inputs(uuid[],boolean,uuid[]);
drop function public.capture_purchase_inputs(uuid,bigint);
drop function public.purchase_source(uuid,timestamptz);
drop function public.enter_purchase_operation();
drop function public.purchase_hash(jsonb);
drop function public.purchase_canonical(jsonb);
drop table public.purchase_runtime,public.purchase_operation_gate;
alter table public.purchase_evaluations drop constraint purchase_evaluation_archive_complete,
    drop column capture,drop column archive,drop column committed_state_revision;
commit;
