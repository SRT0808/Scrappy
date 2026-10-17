begin;
drop function public.read_purchase_configuration(uuid,integer);
notify pgrst,'reload schema';
commit;
