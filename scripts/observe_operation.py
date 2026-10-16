"""Bounded Windows commissioning observer; no manual dispatch or synthetic ping.

prepare writes a concrete proposal. run requires that proposal to be approved.
Evidence lives in ignored .scrappy; monetary JSON is decoded as Decimal.
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from verify_acceptance import require, timestamp, within, decimal, money, additions, verify_snapshot

ROOT = Path(__file__).resolve().parents[1]
SHA = '63be2b508a1f791747dc3d1d2aba8656cdf4f812'
NORMAL = dict(timezone='UTC', hours=[0,3,6,9,12,15,18,21], mdays=[-1], minutes=[0], months=[-1], wdays=[-1], expiresAt=0)
LIMA = timezone(timedelta(hours=-5))


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'), parse_float=Decimal)


def save(path, value):
    # Decimal is serialized as an exact string, never converted back to float.
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, default=str, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    os.replace(temporary, path)


def api(mode, arg=None):
    command = ['node', '--env-file=.env', 'scripts/operation_api.mjs', mode]
    if arg is not None:
        command.append(json.dumps(arg) if isinstance(arg, dict) else str(arg))
    p = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=150)
    require(p.returncode == 0, f'Transport {mode} failed; inspect private observer transport log')
    return json.loads(p.stdout, parse_float=Decimal)


def preflight(job, capture, source):
    require(not job['enabled'] and job['schedule'] == NORMAL, 'Expected disabled original schedule')
    require(job['requestMatches'] and job['saveResponses'] and job['requestMethod'] == 1, 'Dispatch contract changed')
    require(timestamp(job['patExpiration']) > datetime.now(timezone.utc)+timedelta(days=1), 'PAT expiry unsafe')
    require(capture['mainSha'] == SHA, 'Unapproved main SHA')
    require(capture['workflowState'] == 'active' and capture['publicRepository'] and capture['cacheBytes'] < 10_000_000_000, 'Workflow/free allowance unsafe')
    expected_notification = dict(onFailure=True,onFailureCount=1,onSuccess=True,onDisable=True,mode=2,selectedChannels=[0])
    require(all(job['notification'].get(k) == v for k,v in expected_notification.items()), 'Provider notification controls changed')
    require(not any(r['status'] != 'completed' for r in capture['runs']), 'Active writers exist')
    require(capture['heartbeat']['period'] == 10800 and capture['heartbeat']['grace'] == 32400, 'Heartbeat configuration changed')
    for text in ["github.ref == 'refs/heads/main'", 'group: scrappy-check-prices', 'cancel-in-progress: false', 'timeout-minutes: 20', 'runs-on: ubuntu-latest']:
        require(text in source, 'Workflow protection missing')
    require('\n  schedule:' not in source, 'Competing native scheduler')
    require('continue-on-error:' not in source, 'Successful job cannot prove step success with ignored errors')


def unchanged(before, after):
    # Persisted Decimal values use exact strings. Canonicalize fresh Decimals to
    # that same representation; never use float or tolerate a numeric difference.
    canonical=lambda value:json.dumps(value,default=str,sort_keys=True,separators=(',',':'))
    require(canonical(before['tables']) == canonical(after['tables']), 'Unexplained intervening database effects')


def recover_cp1252_capture(value):
    """Explicit one-time repair for captures made by the old Windows transport.

    Call only on evidence known to have used CP1252 for Node UTF-8 output.
    Preserve the original artifact and corroborate against fresh database reads.
    """
    if isinstance(value,dict):return {k:recover_cp1252_capture(v) for k,v in value.items()}
    if isinstance(value,list):return [recover_cp1252_capture(v) for v in value]
    if isinstance(value,str):
        try:return value.encode('cp1252').decode('utf-8')
        except (UnicodeEncodeError,UnicodeDecodeError):return value
    return value


def execution_steps(execution):
    """Use authoritative timestamped runner logs if GitHub omits step metadata.

    This is explicit alternate evidence, not fabricated API step records.
    Workflow SHA/no-continue-on-error guards and job success are checked separately.
    """
    steps=execution['jobs'][0]['steps']
    names=('Review products and send notifications','Ping heartbeat')
    if all(any(s['name']==name for s in steps) for name in names):
        return steps, 'github-job-steps'
    require(not steps, 'Partially missing step metadata needs inspection')
    markers=execution.get('stepLogMarkers',[])
    patterns=(r'##\[group\]Run python -m scrappy\.run --mode',r'Revisión terminada: \d+ productos, \d+ válidos, \d+ rechazados\.',r'##\[group\]Run curl --fail.*"\$\{HEALTHCHECK_URL%/\}"',r'##\[group\]Run elapsed=')
    points=[]
    for pattern in patterns:
        matches=[l.split(' ',1)[0] for l in markers if re.search(pattern,l)]
        require(len(matches)==1, 'Missing/ambiguous authoritative log boundary')
        points.append(timestamp(matches[0]))
    require(points==sorted(points) and len(set(points))==4, 'Reversed log boundaries')
    require(execution['jobs'][0]['conclusion']=='success' and execution['run']['conclusion']=='success', 'Logs cannot replace a failed job')
    second=lambda t:t.replace(microsecond=0).isoformat().replace('+00:00','Z')
    derived=[dict(name=names[0],conclusion='success',started_at=second(points[0]),completed_at=second(points[1])),dict(name=names[1],conclusion='success',started_at=second(points[2]),completed_at=second(points[3]))]
    return derived, 'timestamped-successful-runner-log-boundaries'


def check_slot(before, after, detail, execution, planned, previous_ids=()):
    require(before and timestamp(before['db']['capturedAt']) < timestamp(planned), 'Missing pre-slot baseline')
    require(timestamp(planned)-timestamp(before['db']['capturedAt']) <= timedelta(minutes=2), 'Stale pre-slot baseline')
    run = execution['run']
    require(detail['jobId'] == 8633587 and detail['status'] == 1 and detail['httpStatus'] == 200, 'Failed provider execution')
    require(detail['datePlanned'] == int(timestamp(planned).timestamp()), 'Unexpected planned slot')
    try:
        dispatch = json.loads(detail['body'])
    except (TypeError, ValueError):
        raise ValueError('Ambiguous dispatch response') from None
    require(dispatch.get('workflow_run_id') == run['id'], 'Provider/run mismatch')
    require(run['id'] not in previous_ids, 'Repeated Actions ID')
    require(run['head_sha'] == before['mainSha'] == after['mainSha'] == SHA and run['head_branch'] == 'main' and run['event'] == 'workflow_dispatch', 'Unexpected runner identity')
    require(run['status'] == 'completed' and run['conclusion'] == 'success', 'Failed or unfinished runner')
    require(len(execution['jobs']) == 1 and execution['jobs'][0]['conclusion'] == 'success', 'Unexpected jobs')
    steps, step_source = execution_steps(execution)
    processing = next(s for s in steps if s['name'] == 'Review products and send notifications')
    heartbeat = next(s for s in steps if s['name'] == 'Ping heartbeat')
    require(processing['conclusion'] == heartbeat['conclusion'] == 'success', 'Failed processing/heartbeat')
    require(any('RUN_MODE: all' in l for l in execution['logEvidence']), 'Missing all-mode log')
    b, a = before['db']['tables'], after['db']['tables']
    db_runs = additions(b['runs'], a['runs'])
    require(len(db_runs) == 1, 'Missing or overlapping database runs')
    db_run = db_runs[0]
    start, end = db_run['started_at'], db_run['finished_at']
    require(end is not None and timestamp(start) <= timestamp(end), 'Incomplete database run')
    require(db_run['trigger'] == 'dispatch' and all(within(t, processing['started_at'], processing['completed_at'], github_seconds=True) for t in (start,end)), 'Database attribution failed')
    checks = additions(b['price_checks'], a['price_checks'])
    due = [p for p in b['products'] if p['status'] in ('active','error') and (p['last_checked_at'] is None or timestamp(p['last_checked_at'])+timedelta(hours=int(p['check_interval_hours'])) <= timestamp(start))]
    require(len(checks) == db_run['checked'] == db_run['ok_count'] and db_run['fail_count'] == 0, 'Unsuccessful review counters')
    require({c['product_id'] for c in checks} == {p['id'] for p in due} and len(checks) == len(due), 'Due selection or reread needs directed reconciliation')
    require(all(c['ok'] and within(c['checked_at'], start, end) for c in checks), 'Invalid checks')
    for table in ('lists','basket_items','basket_events','notifications'):
        require(a[table] == b[table], f'Unexpected {table} effects require directed verification')
    require(all(l['budget'] is None for l in a['lists']), 'Eligible basket scope needs directed verification')
    products = {p['id']:p for p in a['products']}
    require(set(products) == {p['id'] for p in b['products']}, 'Product identities changed')
    mutable = {'last_price','last_checked_at','last_success_at','last_method','last_availability','consecutive_failures'}
    checked = {c['product_id']:c for c in checks}
    for p in b['products']:
        current = products[p['id']]
        if p['id'] not in checked:
            require(current == p, 'Non-due product mutated')
            continue
        require(current.keys() == p.keys() and all(current[k] == v for k,v in p.items() if k not in mutable), 'Product configuration/alert mutation')
        c = checked[p['id']]
        require(decimal(current['last_price']) == decimal(c['price']) and current['currency'] == c['currency'] and current['last_method'] == c['method'] and current['last_availability'] == c['availability'], 'Product reading mismatch')
        require(timestamp(current['last_checked_at']) == timestamp(current['last_success_at']) == timestamp(c['checked_at']) and current['consecutive_failures'] == 0, 'Product version mismatch')
        target = decimal(current['target_price']) if current['target_type'] == 'price' else money(decimal(current['reference_price'])*(1-decimal(current['target_percent'])/100))
        require(decimal(c['price']) > target and current['alert_state'] == 'armed', 'Eligible individual alert requires directed verification')
    snapshots = additions(b['basket_snapshots'], a['basket_snapshots'])
    expected_lists = {i['list_id'] for i in a['basket_items'] if i['product_id'] in checked}
    require(sorted(s['list_id'] for s in snapshots) == sorted(expected_lists), 'Unexpected snapshot count/membership')
    for s in snapshots:
        require(within(s['calculated_at'], start, end), 'Snapshot outside run')
        verify_snapshot(s)
        basket = next(l for l in a['lists'] if l['id'] == s['list_id'])
        require(s['composition_version'] == basket['composition_version'], 'Snapshot version mismatch')
        members = [i for i in a['basket_items'] if i['list_id'] == s['list_id']]
        require({i['product_id'] for i in members} == {l['product_id'] for l in s['lines']}, 'Snapshot membership mismatch')
        for line in s['lines']:
            product = products[line['product_id']]
            require(decimal(line['reference_price']) == decimal(product['reference_price']) and decimal(line['last_price']) == decimal(product['last_price']), 'Snapshot line price mismatch')
            require(timestamp(line['last_checked_at']) == timestamp(product['last_checked_at']) and timestamp(line['last_success_at']) == timestamp(product['last_success_at']), 'Snapshot line timestamps mismatch')
            require(decimal(line['quantity']) == decimal(next(i['quantity'] for i in members if i['product_id'] == line['product_id'])), 'Snapshot quantity mismatch')
    fx_key = lambda r:(r['rate_date'],r['from_currency'],r['to_currency'])
    old_fx = {fx_key(r):r for r in b['exchange_rates']}
    new_fx = {fx_key(r):r for r in a['exchange_rates']}
    require(old_fx.keys() <= new_fx.keys(), 'Historical FX deleted')
    fx_changed = [r for k,r in new_fx.items() if old_fx.get(k) != r]
    require(len(fx_changed) <= 1, 'Unexpected FX changes')
    for r in fx_changed:
        require(r['from_currency'] == 'USD' and r['to_currency'] == 'PEN' and r['source'] == 'BCRPData:PD04638PD' and 0 < decimal(r['rate']) < 1000 and within(r['fetched_at'], start,end), 'FX attribution failed')
        require(r['rate_date'] <= timestamp(start).astimezone(LIMA).date().isoformat(), 'Future FX rate')
        if fx_key(r) in old_fx:
            require(all(v == old_fx[fx_key(r)][k] for k,v in r.items() if k != 'fetched_at'), 'Changed FX value needs provider evidence')
    hc, prior = after['heartbeat'], before['heartbeat']
    require(hc['uniqueKey'] == prior['uniqueKey'] and hc['period'] == 10800 and hc['grace'] == 32400, 'Heartbeat identity/configuration mismatch')
    require(hc['status'] == 'up' and hc['nPings'] == prior['nPings']+1 and within(hc['lastPing'],heartbeat['started_at'],heartbeat['completed_at'],github_seconds=True), 'Missing/extra heartbeat')
    require(not any(r['status'] != 'completed' for r in after['runs']), 'Overlapping Actions execution')
    new_actions = {r['id'] for r in after['runs']} - {r['id'] for r in before['runs']}
    require(new_actions == {run['id']}, 'Competing Actions invocation')
    return dict(passed=True,providerId=detail['identifier'],runId=run['id'],databaseRunId=db_run['id'],planned=planned,actualProvider=detail['date'],createdAt=run['created_at'],priceChecks=len(checks),snapshots=len(snapshots),fxRefreshes=len(fx_changed),heartbeatMatched=True,timing=execution['timing'],stepEvidenceSource=step_source)


def disable_and_restore(call=api):
    # Never repeat an ambiguous enable; disabling is an idempotent safety action.
    for _ in range(3):
        try:
            call('set', {'enabled':False})
            closed = call('job')
            require(not closed['enabled'], 'Disable not verified')
            call('set', {'schedule':NORMAL})
            final = call('job')
            require(not final['enabled'] and final['schedule'] == NORMAL, 'Closed restoration not verified')
            return final
        except Exception:
            time.sleep(2)
    raise RuntimeError('Closure could not be verified; provider expiry is the remaining bound')


def prepare(path):
    require(not Path(path).exists(), 'Use a fresh proposal path; never overwrite an existing window')
    job, capture = api('job'), api('capture')
    preparation = read(ROOT/'.scrappy/job-8633587-new-window-preparation.json')
    preflight(job,capture,preparation['workflowSource'])
    now = datetime.now(timezone.utc)
    start = now.replace(minute=0,second=0,microsecond=0)+timedelta(hours=1)
    # Three exact minutes in one UTC hour: no unintended Cartesian-product slots.
    slots = [start+timedelta(minutes=10*i) for i in range(3)]
    # cron-job.org expiry is YYYYMMDDhhmmss in the job timezone, not Unix time.
    schedule = dict(timezone='UTC',hours=[start.hour],minutes=[0,10,20],mdays=[start.day],months=[start.month],wdays=[-1],expiresAt=int((slots[-1]+timedelta(minutes=1)).strftime('%Y%m%d%H%M%S')))
    proposal = dict(preparedAt=now.isoformat(),jobId=8633587,sha=SHA,approved=False,windowStatus='prepared',schedule=schedule,
        plannedSlots=[s.isoformat() for s in slots],plannedSlotsLima=[s.astimezone(LIMA).isoformat() for s in slots],
        earliestActivation=(start-timedelta(minutes=20)).isoformat(),latestActivation=(start-timedelta(minutes=3)).isoformat(),deadline=(slots[-1]+timedelta(minutes=9)).isoformat(),
        original=job,preparation=capture,verified=[],normalVerified=[],freeAllowance=preparation['github'],
        scope='Three automatic main/all slots; preserve real effects; expiry before any fourth slot; disable on failure; restore three-hour cadence and observe three normal slots. No manual dispatch/synthetic ping.')
    save(path,proposal)
    print(json.dumps({k:proposal[k] for k in ('windowStatus','plannedSlotsLima','earliestActivation','latestActivation','deadline','scope')}),flush=True)


def wait_until(point):
    while datetime.now(timezone.utc) < point:
        time.sleep(min(15,max(0,(point-datetime.now(timezone.utc)).total_seconds())))


def observe_slot(proposal,path,planned,previous,ids,call=api):
    when=timestamp(planned)
    wait_until(when-timedelta(seconds=90))
    baseline=call('capture')
    require(timestamp(baseline['db']['capturedAt']) < when, 'Pre-slot capture arrived late')
    require(baseline['mainSha'] == SHA, 'Unapproved main SHA before slot')
    require(baseline['workflowState'] == 'active', 'Workflow unavailable before slot')
    require(baseline['heartbeat']['period'] == 10800 and baseline['heartbeat']['grace'] == 32400, 'Heartbeat configuration changed before slot')
    if previous:
        unchanged(previous['db'],baseline['db'])
        require(previous['heartbeat'] == baseline['heartbeat'], 'Intervening heartbeat')
    require(not any(r['status'] != 'completed' for r in baseline['runs']), 'Active writer before slot')
    evidence={'baseline':baseline,'planned':planned}
    evidence_path=Path(str(path).replace('.json',f'-slot-{int(when.timestamp())}.json'))
    save(evidence_path,evidence)
    wait_until(when+timedelta(seconds=45))
    detail=None
    for delay in (0,60,120):
        if delay:time.sleep(delay)
        history=call('history')
        slots=[s for s in history['history'] if s['datePlanned'] == int(when.timestamp())]
        require(len(slots)<=1, 'Duplicate provider dispatch')
        if slots:
            detail=call('detail',slots[0]['identifier']);break
    require(detail is not None, 'Missing automatic provider execution')
    evidence['provider']=detail;save(evidence_path,evidence)
    try:run_id=json.loads(detail['body'])['workflow_run_id']
    except (KeyError,ValueError,TypeError):raise ValueError('Ambiguous provider dispatch') from None
    cutoff=when+timedelta(minutes=8)
    execution=None
    while datetime.now(timezone.utc) < cutoff:
        execution=call('run',run_id)
        if execution['run']['status']=='completed':break
        time.sleep(30)
    require(execution is not None and execution['run']['status']=='completed', 'Run missed bounded completion deadline')
    after=call('capture')
    evidence.update(execution=execution,after=after)
    save(evidence_path,evidence)
    result=check_slot(baseline,after,detail,execution,planned,ids)
    result['evidencePath']=str(evidence_path)
    evidence['result']=result;save(evidence_path,evidence)
    print(json.dumps(result,default=str),flush=True)
    return result,after


def run(path):
    proposal=read(path)
    require(proposal['approved'] is True and proposal.get('ownerCoordination') is True, 'Concrete scope/coordination not approved')
    require(proposal['windowStatus']=='prepared', 'Do not rearm a prior or ambiguous window')
    now=datetime.now(timezone.utc)
    require(timestamp(proposal['earliestActivation']) <= now <= timestamp(proposal['latestActivation']), 'Activation window expired/not open')
    require(timestamp(proposal['deadline'])-now <= timedelta(minutes=60), 'Window exceeds 60 minutes')
    before=api('capture');job=api('job')
    preparation=read(ROOT/'.scrappy/job-8633587-new-window-preparation.json')
    preflight(job,before,preparation['workflowSource'])
    proposal['activationBaseline']=before
    proposal['windowStatus']='activation-attempted';save(path,proposal)
    try:
        api('set',{'enabled':True,'schedule':proposal['schedule']})
        actual=api('job')
        require(actual['enabled'] and actual['schedule']==proposal['schedule'], 'Ambiguous activation read-back')
        proposal['activatedAt']=datetime.now(timezone.utc).isoformat();proposal['windowStatus']='armed';save(path,proposal)
        print('Fast window armed with provider expiry and bounded observer.',flush=True)
        previous=None
        for planned in proposal['plannedSlots']:
            result,previous=observe_slot(proposal,path,planned,previous,[v['runId'] for v in proposal['verified']])
            proposal['verified'].append(result);save(path,proposal)
        require(len({v['databaseRunId'] for v in proposal['verified']})==3, 'Repeated DB ID')
        # Restore original cadence only after successful fast verification.
        api('set',{'enabled':False})
        require(not api('job')['enabled'],'Fast stop not verified')
        api('set',{'schedule':NORMAL,'enabled':True})
        actual=api('job')
        require(actual['enabled'] and actual['schedule']==NORMAL,'Normal restoration not verified')
        proposal['normalRestoredAt']=datetime.now(timezone.utc).isoformat();proposal['windowStatus']='normal-observation';save(path,proposal)
        start=datetime.now(timezone.utc).replace(minute=0,second=0,microsecond=0)
        start+=timedelta(hours=3-start.hour%3)
        proposal['normalSlots']=[(start+timedelta(hours=i*3)).isoformat() for i in range(3)];save(path,proposal)
        print('Fast gate passed; original 3h schedule restored. Observing three normal cycles.',flush=True)
        for planned in proposal['normalSlots']:
            result,previous=observe_slot(proposal,path,planned,previous,[v['runId'] for v in proposal['verified']+proposal['normalVerified']])
            proposal['normalVerified'].append(result);save(path,proposal)
        final=api('job')
        require(final['enabled'] and final['schedule']==NORMAL, 'Final job configuration changed')
        proposal['finalJob']=final;proposal['windowStatus']='six-slots-passed';proposal['completedAt']=datetime.now(timezone.utc).isoformat();save(path,proposal)
        print('Six slots passed. Outage receipt/recovery and final audit remain separate gates.',flush=True)
    except BaseException as exc:
        proposal['windowStatus']='failed';proposal['failure']=str(exc)
        try:
            proposal['closure']=disable_and_restore();proposal['windowStatus']='failed-disabled-restored'
        except Exception as closure:
            proposal['closureFailure']=str(closure)
        try:proposal['stoppedCapture']=api('capture')
        except Exception:pass
        save(path,proposal)
        print(json.dumps({'windowStatus':proposal['windowStatus'],'failure':str(exc)},default=str),flush=True)
        raise


def resume_normal(path):
    """Resume future normal slots after correcting an evidence-only failure.

    Previously executed slots must already be reconciled with preserved baselines.
    No replay, manual dispatch or missing past slot is accepted.
    """
    proposal=read(path)
    require(proposal['approved'] is True and proposal['ownerCoordination'] is True, 'Scope not approved')
    require(proposal['windowStatus']=='failed-disabled-restored' and len(proposal['verified'])==3, 'Fast gate or verified closure missing')
    verified=proposal['normalVerified']
    require(bool(verified) and len(verified)<3 and all(r['passed'] for r in verified), 'Prior normal evidence must be reconciled before resumption')
    require([r['planned'] for r in verified]==proposal['normalSlots'][:len(verified)], 'Normal state chain is not consecutive')
    remaining=proposal['normalSlots'][len(verified):]
    require(all(timestamp(p)>datetime.now(timezone.utc)+timedelta(minutes=3) for p in remaining), 'Do not recover an elapsed/missing slot')
    latest=read(verified[-1]['evidencePath'])['after']
    current,job=api('capture'),api('job')
    preparation=read(ROOT/'.scrappy/job-8633587-new-window-preparation.json')
    preflight(job,current,preparation['workflowSource'])
    unchanged(latest['db'],current['db'])
    require(latest['heartbeat']==current['heartbeat'], 'Intervening ping during stopped correction')
    proposal['resumptionBaseline']=current
    proposal['windowStatus']='normal-resumption-attempted';save(path,proposal)
    try:
        api('set',{'enabled':True})
        actual=api('job')
        require(actual['enabled'] and actual['schedule']==NORMAL, 'Normal resumption read-back failed')
        proposal['windowStatus']='normal-observation';proposal['resumedAt']=datetime.now(timezone.utc).isoformat();save(path,proposal)
        print('Corrected evidence gate; normal schedule resumed before the next slot. No run replayed.',flush=True)
        previous=latest
        for planned in remaining:
            result,previous=observe_slot(proposal,path,planned,previous,[v['runId'] for v in proposal['verified']+proposal['normalVerified']])
            proposal['normalVerified'].append(result);save(path,proposal)
        final=api('job')
        require(final['enabled'] and final['schedule']==NORMAL, 'Final job configuration changed')
        proposal['finalJob']=final;proposal['windowStatus']='six-slots-passed';proposal['completedAt']=datetime.now(timezone.utc).isoformat();save(path,proposal)
        print('Six slots passed; final audit remains.',flush=True)
    except BaseException as exc:
        proposal['failure']=f'{type(exc).__name__}: {exc}'
        try:
            proposal['closure']=disable_and_restore();proposal['windowStatus']='failed-disabled-restored'
        except Exception as closure:proposal['closureFailure']=str(closure)
        try:proposal['stoppedCapture']=api('capture')
        except Exception:pass
        save(path,proposal)
        raise


if __name__=='__main__':
    os.chdir(ROOT)
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['prepare','run','resume-normal'])
    parser.add_argument('path')
    args=parser.parse_args()
    {'prepare':prepare,'run':run,'resume-normal':resume_normal}[args.mode](Path(args.path))
