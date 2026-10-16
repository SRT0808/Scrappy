import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import observe_operation as observer


class OperationObserverTests(unittest.TestCase):
    def fixture(self, due=True):
        sha=observer.SHA
        old='2026-10-13T00:00:00.000001Z'
        start,end='2026-10-13T04:00:15.060109Z','2026-10-13T04:00:20.711561Z'
        p=dict(id='p',status='active',check_interval_hours=3,last_checked_at=old if due else '2026-10-13T03:00:00Z',last_success_at=old,last_price='100.00',reference_price='100.00',currency='PEN',last_method='json_ld',last_availability=None,consecutive_failures=0,target_type='price',target_price='50.00',alert_state='armed')
        tables={t:[] for t in ('runs','price_checks','products','lists','basket_items','basket_snapshots','basket_events','notifications','exchange_rates')}
        tables['products']=[p]
        tables['lists']=[dict(id='l',budget=None,composition_version=1)]
        hc=dict(uniqueKey='hc',status='up',lastPing=old,nPings=1,period=10800,grace=32400)
        before=dict(db=dict(capturedAt='2026-10-13T03:58:30Z',tables=tables,due=[p] if due else []),heartbeat=hc,mainSha=sha,workflowState='active',runs=[])
        after=copy.deepcopy(before)
        after['db']['tables']['runs']=[dict(id='db',started_at=start,finished_at=end,trigger='dispatch',checked=int(due),ok_count=int(due),fail_count=0)]
        if due:
            after['db']['tables']['price_checks']=[dict(id='c',product_id='p',checked_at=end,ok=True,price='90.00',currency='PEN',method='json_ld',availability=None)]
            after['db']['tables']['products'][0].update(last_price='90.00',last_checked_at=end,last_success_at=end)
        after['heartbeat'].update(lastPing='2026-10-13T04:00:21Z',nPings=2)
        after['runs']=[dict(id=1,status='completed')]
        detail=dict(jobId=8633587,status=1,httpStatus=200,datePlanned=1791864000,identifier='8633587-1',date=1791864001,body=json.dumps(dict(workflow_run_id=1)))
        detail['datePlanned']=int(observer.timestamp('2026-10-13T04:00:00Z').timestamp())
        execution=dict(run=dict(id=1,head_sha=sha,head_branch='main',event='workflow_dispatch',status='completed',conclusion='success',created_at='2026-10-13T04:00:01Z'),jobs=[dict(conclusion='success',steps=[dict(name='Review products and send notifications',conclusion='success',started_at='2026-10-13T04:00:15Z',completed_at='2026-10-13T04:00:20Z'),dict(name='Ping heartbeat',conclusion='success',started_at='2026-10-13T04:00:21Z',completed_at='2026-10-13T04:00:21Z')])],logEvidence=['RUN_MODE: all'],timing={})
        return [before,after,detail,execution,'2026-10-13T04:00:00Z']

    def test_success_and_zero_due(self):
        for due in (True,False):
            with self.subTest(due=due):
                result=observer.check_slot(*self.fixture(due))
                self.assertTrue(result['passed'])
                self.assertEqual(result['priceChecks'],int(due))

    def test_two_due_products_share_one_snapshot_and_duplicates_fail(self):
        f=self.fixture()
        before,after=f[0]['db']['tables'],f[1]['db']['tables']
        before['products'].append(dict(before['products'][0],id='p2'))
        after['products'].append(dict(after['products'][0],id='p2'))
        after['price_checks'].append(dict(after['price_checks'][0],id='c2',product_id='p2'))
        after['runs'][0].update(checked=2,ok_count=2)
        members=[dict(list_id='l',product_id=p,quantity='1') for p in ('p','p2')]
        before['basket_items']=copy.deepcopy(members)
        after['basket_items']=members
        lines=[dict(product_id=p['id'],valid=True,stale=False,unavailable=False,
                    currency='PEN',conversion=None,quantity='1',reference_price='100.00',
                    last_price='90.00',last_checked_at=p['last_checked_at'],
                    last_success_at=p['last_success_at']) for p in after['products']]
        snapshot=dict(id='s',list_id='l',composition_version=1,complete=True,
                      calculated_at=after['runs'][0]['finished_at'],lines=lines,
                      item_count=2,valid_count=2,stale_count=0,unavailable_count=0,
                      missing_count=0,fx_missing_count=0,currency='PEN',
                      reference_total='200.00',current_total='180.00',savings='20.00',
                      savings_percent='10.00')
        after['basket_snapshots']=[snapshot]
        self.assertEqual(observer.check_slot(*f)['snapshots'],1)
        after['basket_snapshots'].append(dict(snapshot,id='duplicate'))
        with self.assertRaisesRegex(ValueError,'snapshot count/membership'):
            observer.check_slot(*f)

    def test_missing_baseline(self):
        f=self.fixture();f[0]=None
        with self.assertRaisesRegex(ValueError,'Missing pre-slot'):
            observer.check_slot(*f)

    def test_failed_execution(self):
        f=self.fixture();f[3]['run']['conclusion']='failure'
        with self.assertRaisesRegex(ValueError,'Failed or unfinished'):
            observer.check_slot(*f)

    def test_ambiguous_response(self):
        for body in ('', '{}','{"workflow_run_id":2}'):
            f=self.fixture();f[2]['body']=body
            with self.assertRaises(ValueError):observer.check_slot(*f)

    def test_overlap_and_extra_heartbeat(self):
        f=self.fixture();f[1]['db']['tables']['runs'].append(dict(f[1]['db']['tables']['runs'][0],id='other'))
        with self.assertRaisesRegex(ValueError,'overlapping'):observer.check_slot(*f)
        f=self.fixture();f[1]['heartbeat']['nPings']=3
        with self.assertRaisesRegex(ValueError,'Missing/extra'):observer.check_slot(*f)

    def test_missing_provider_execution_and_late_capture(self):
        f=self.fixture()
        def call(mode,arg=None):
            return f[0] if mode=='capture' else {'history':[]}
        with patch.object(observer,'wait_until'),patch.object(observer.time,'sleep'),patch.object(observer,'save'):
            with self.assertRaisesRegex(ValueError,'Missing automatic'):
                observer.observe_slot({},Path('unused.json'),f[4],None,[],call)
        f[0]['db']['capturedAt']=f[4]
        with patch.object(observer,'wait_until'):
            with self.assertRaisesRegex(ValueError,'arrived late'):
                observer.observe_slot({},Path('unused.json'),f[4],None,[],call)

    def test_ambiguous_disable_is_read_back_before_restoration(self):
        calls=[]
        def call(mode,arg=None):
            calls.append((mode,arg))
            if len(calls)==1:raise TimeoutError('Response lost')
            if mode=='job':return {'enabled':False,'schedule':observer.NORMAL}
            return {}
        with patch.object(observer.time,'sleep'):
            self.assertEqual(observer.disable_and_restore(call)['schedule'],observer.NORMAL)
        restore=next(i for i,c in enumerate(calls) if c==('set',{'schedule':observer.NORMAL}))
        self.assertEqual(calls[restore-1][0],'job')

    def test_unexplained_intervening_effects(self):
        f=self.fixture()
        with self.assertRaisesRegex(ValueError,'intervening'):
            observer.unchanged(f[0]['db'],f[1]['db'])

    def test_saved_decimal_state_roundtrip_and_real_change(self):
        state={'tables':{'products':[{'id':'p','price':observer.Decimal('97.800001'),'payload':{'quantity':observer.Decimal('1.5000')},'checked_at':'2026-10-13T00:00:00.000001Z'}]}}
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'state.json'
            observer.save(path,state)
            stored=observer.read(path)
            observer.unchanged(stored,state)
            changed=copy.deepcopy(state)
            changed['tables']['products'][0]['price']=observer.Decimal('97.800002')
            with self.assertRaises(ValueError):observer.unchanged(stored,changed)
            changed=copy.deepcopy(state)
            changed['tables']['products'][0]['checked_at']='2026-10-13T00:00:00.000002Z'
            with self.assertRaises(ValueError):observer.unchanged(stored,changed)

    def test_node_transport_decodes_utf8_independently_of_windows_locale(self):
        from types import SimpleNamespace
        with patch.object(observer.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='{"notice":"✅ Notificación"}')) as process:
            self.assertEqual(observer.api('capture')['notice'],'✅ Notificación')
        self.assertEqual(process.call_args.kwargs['encoding'],'utf-8')

    def test_explicit_old_capture_repair_and_subcent_preservation(self):
        value={'title':'✅ Notificación','price':observer.Decimal('97.800001'),'nested':['Revisión válida']}
        encoded={'title':value['title'].encode('utf-8').decode('cp1252'),'price':value['price'],'nested':[value['nested'][0].encode('utf-8').decode('cp1252')]}
        self.assertEqual(observer.recover_cp1252_capture(encoded),value)

    def test_existing_window_cannot_be_overwritten_or_rearmed(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'active.json'
            observer.save(p,{'approved':True,'ownerCoordination':True,'windowStatus':'armed'})
            with patch.object(observer,'api') as transport:
                with self.assertRaisesRegex(ValueError,'never overwrite'):
                    observer.prepare(p)
                with self.assertRaisesRegex(ValueError,'Do not rearm'):
                    observer.run(p)
            transport.assert_not_called()

    def log_fixture(self):
        f=self.fixture(False)
        f[3]['jobs'][0]['steps']=[]
        f[3]['stepLogMarkers']=[
            '2026-10-13T04:00:15.001Z ##[group]Run python -m scrappy.run --mode "$RUN_MODE"',
            '2026-10-13T04:00:20.999Z Revisión terminada: 0 productos, 0 válidos, 0 rechazados.',
            '2026-10-13T04:00:21.001Z ##[group]Run curl --fail --silent "${HEALTHCHECK_URL%/}"',
            '2026-10-13T04:00:21.999Z ##[group]Run elapsed=$(( $(date +%s) - RUN_STARTED_AT ))']
        return f

    def test_empty_api_steps_reconciled_from_explicit_log_boundaries(self):
        f=self.log_fixture()
        result=observer.check_slot(*f)
        self.assertTrue(result['passed'])
        self.assertEqual(result['stepEvidenceSource'],'timestamped-successful-runner-log-boundaries')
        self.assertEqual(f[3]['jobs'][0]['steps'],[])

    def test_missing_ambiguous_or_reversed_log_boundaries_fail(self):
        for change in ('missing','duplicate','reversed'):
            f=self.log_fixture();markers=f[3]['stepLogMarkers']
            if change=='missing':markers.pop()
            if change=='duplicate':markers.append(markers[0])
            if change=='reversed':markers[3]=markers[3].replace('04:00:21.999','04:00:14.999')
            with self.subTest(change=change),self.assertRaises(ValueError):observer.check_slot(*f)

    def test_normal_resume_rejects_missing_or_elapsed_slots_before_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'closed.json'
            base=dict(approved=True,ownerCoordination=True,windowStatus='failed-disabled-restored',verified=[{}, {}, {}],normalVerified=[],normalSlots=['2020-01-01T00:00:00Z','2020-01-01T03:00:00Z','2020-01-01T06:00:00Z'])
            with patch.object(observer,'api') as transport:
                observer.save(p,base)
                with self.assertRaisesRegex(ValueError,'reconciled'):observer.resume_normal(p)
                base['normalVerified']=[{'passed':True,'planned':base['normalSlots'][0]}]
                observer.save(p,base)
                with self.assertRaisesRegex(ValueError,'elapsed/missing'):observer.resume_normal(p)
            transport.assert_not_called()

    def test_precision_boundary_and_historical_mutation(self):
        f=self.fixture();f[1]['db']['tables']['runs'][0]['finished_at']='2026-10-13T04:00:21.000001Z'
        with self.assertRaisesRegex(ValueError,'attribution'):observer.check_slot(*f)
        f=self.fixture(False);f[1]['db']['tables']['products'][0]['last_price']='100.000001'
        with self.assertRaisesRegex(ValueError,'Non-due'):observer.check_slot(*f)

    def test_runner_closes_after_ambiguous_activation_or_missing_slot(self):
        for failure_at in ('activation','slot'):
            with self.subTest(failure_at=failure_at), tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'proposal.json'
                now=observer.datetime.now(observer.timezone.utc)
                proposal=dict(approved=True,ownerCoordination=True,windowStatus='prepared',earliestActivation=(now-observer.timedelta(minutes=1)).isoformat(),latestActivation=(now+observer.timedelta(minutes=1)).isoformat(),deadline=(now+observer.timedelta(minutes=30)).isoformat(),schedule={'expiresAt':20261013202100},plannedSlots=['slot'],verified=[])
                original_read=observer.read
                observer.save(path,proposal)
                calls=[]
                def call(mode,arg=None):
                    calls.append((mode,arg))
                    if mode=='set' and arg.get('enabled') is True and failure_at=='activation':
                        raise TimeoutError('Activation response lost')
                    if mode=='job':return dict(enabled=True,schedule=proposal['schedule'])
                    if mode=='capture':return self.fixture()[0]
                    return {}
                def read(p):
                    return {'workflowSource':'fixture'} if str(p).endswith('new-window-preparation.json') else original_read(p)
                with patch.object(observer,'api',side_effect=call),patch.object(observer,'preflight'),patch.object(observer,'read',side_effect=read),patch.object(observer,'observe_slot',side_effect=ValueError('Missing automatic provider execution')),patch.object(observer,'disable_and_restore',return_value={'enabled':False,'schedule':observer.NORMAL}) as close:
                    with self.assertRaises((TimeoutError,ValueError)):
                        observer.run(path)
                close.assert_called_once()
                saved=original_read(path)
                self.assertEqual(saved['windowStatus'],'failed-disabled-restored')
                self.assertIn('stoppedCapture',saved)
                self.assertEqual(sum(1 for m,a in calls if m=='set' and a.get('enabled') is True),1)


if __name__=='__main__':unittest.main()
