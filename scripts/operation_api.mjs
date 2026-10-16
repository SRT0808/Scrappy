// Private commissioning transport. No credentials or request headers in evidence.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
async function github(path) {
  const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}${path}`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error(`GitHub GET: HTTP ${r.status}`);
  return r.json();
}
async function query(sql) {
  const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw Error(`Database capture: HTTP ${r.status}`);
  return r.json();
}
const jobId=8633587;
const ledgerPath='.scrappy/mission-api-budget.json';
async function provider(path='',method='GET',body) {
  let ledger; try {ledger=JSON.parse(await readFile(ledgerPath,'utf8'));} catch {ledger={};}
  const day=new Date().toISOString().slice(0,10);
  if(ledger.day!==day) ledger={day,count:0,limit:70,unknownEarlierUsage:true};
  if(ledger.count>=ledger.limit && method==='GET' && path!=='') throw Error('Local provider read budget exhausted; closure reserve retained');
  ledger.count++; await writeFile(ledgerPath,JSON.stringify(ledger));
  const r=await fetch(path==='inventory'?'https://api.cron-job.org/jobs':`https://api.cron-job.org/jobs/${jobId}${path}`,{
    method,headers:{Authorization:`Bearer ${process.env.CRONJOB_API_KEY}`,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(!r.ok) throw Error(`Provider ${method}: HTTP ${r.status}`);
  return r.json();
}
const key=createHash('sha1').update(new URL(process.env.HEALTHCHECK_URL).pathname.split('/')[1].replaceAll('-','').toLowerCase().slice(0,16)).digest('hex');
async function heartbeat(suffix='') {
  const r=await fetch(`https://healthchecks.io/api/v3/checks/${key}${suffix}`,{headers:{'X-Api-Key':process.env.HEALTHCHECKS_API_KEY},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(`Heartbeat GET: HTTP ${r.status}`);
  const c=await r.json();
  return suffix?c:{uniqueKey:c.unique_key,status:c.status,lastPing:c.last_ping,nPings:c.n_pings,period:c.timeout,grace:c.grace};
}
const tables=['basket_events','basket_items','basket_snapshots','exchange_rates','lists','notifications','price_checks','products','runs'];
async function capture(){
  const fields=tables.map(t=>`'${t}',coalesce((select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from public.${t} t),'[]'::jsonb)`);
  const [db]=await query(`select jsonb_build_object('capturedAt',now(),'tables',jsonb_build_object(${fields.join(',')}),'due',coalesce((select jsonb_agg(to_jsonb(p)) from public.due_products(now(),null) p),'[]'::jsonb))::text baseline;`);
  const [hc,main,runs,workflow,repo,cache]=await Promise.all([heartbeat(),github('/git/ref/heads/main'),github('/actions/runs?per_page=100'),github('/actions/workflows/check-prices.yml'),github(''),github('/actions/cache/usage')]);
  // The PostgreSQL JSON text is inserted verbatim, preserving decimals/microseconds.
  return JSON.stringify({heartbeat:hc,mainSha:main.object.sha,workflowState:workflow.state,publicRepository:repo.private===false,cacheBytes:cache.active_caches_size_in_bytes,runs:runs.workflow_runs.map(r=>Object.fromEntries(['id','event','head_sha','head_branch','status','conclusion','created_at'].map(k=>[k,r[k]]))),db:'RAW_DB'}).replace('"RAW_DB"',db.baseline);
}
const [mode,arg]=process.argv.slice(2);
let result;
if(mode==='capture') result=await capture();
else if(mode==='job') {
  const c=(await provider()).jobDetails;
  const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/check-prices.yml`,{headers:{Authorization:c.extendedData.headers.Authorization,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(`Dedicated credential read HTTP ${r.status}`);
  const expiry=r.headers.get('github-authentication-token-expiration');
  result=JSON.stringify({enabled:c.enabled,schedule:c.schedule,notification:c.notification,saveResponses:c.saveResponses,requestMethod:c.requestMethod,requestTimeout:c.requestTimeout,
    requestMatches:c.url===`https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/check-prices.yml/dispatches`&&JSON.stringify(JSON.parse(c.extendedData.body))===JSON.stringify({ref:'main',inputs:{mode:'all'}}),patExpiration:expiry?new Date(expiry).toISOString():null});
}
else if(mode==='history')result=JSON.stringify(await provider('/history'));
else if(mode==='inventory') {
  const data=await provider('inventory');
  result=JSON.stringify({someFailed:data.someFailed,jobs:data.jobs.filter(j=>j.url.includes(`/repos/${process.env.GITHUB_REPO}/`)).map(j=>({jobId:j.jobId,enabled:j.enabled,schedule:j.schedule}))});
}
else if(mode==='detail') {
  if(!/^[0-9-]+$/.test(arg))throw Error('Invalid history identifier');
  const c=(await provider(`/history/${arg}`)).jobHistoryDetails;
  result=JSON.stringify(Object.fromEntries(['jobId','identifier','date','datePlanned','jitter','duration','status','httpStatus','body'].map(k=>[k,c[k]])));
}
else if(mode==='run') {
  if(!/^\d+$/.test(arg))throw Error('Invalid run ID');
  const [run,jobs,timing]=await Promise.all([github(`/actions/runs/${arg}`),github(`/actions/runs/${arg}/jobs`),github(`/actions/runs/${arg}/timing`)]);
  let logEvidence=[], stepLogMarkers=[];
  if(run.status==='completed') {
    const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/jobs/${jobs.jobs[0].id}/logs`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error(`Logs HTTP ${r.status}`);
    const logs=await r.text();
    logEvidence=logs.split('\n').filter(l=>/RUN_MODE: all|Revisión terminada:|Tiempo transcurrido del runner:/.test(l));
    stepLogMarkers=logs.split('\n').filter(l=>/##\[group\]Run python -m scrappy.run|Revisión terminada:|##\[group\]Run curl --fail|##\[group\]Run elapsed=/.test(l));
    if(stepLogMarkers.some(l=>/https:\/\/hc-ping\.com\//.test(l)))throw Error('Unexpected unmasked heartbeat URL in log marker');
  }
  result=JSON.stringify({run,jobs:jobs.jobs,timing,logEvidence,stepLogMarkers});
}
else if(mode==='set') {
  const delta=JSON.parse(arg);
  if(Object.keys(delta).some(k=>!['enabled','schedule'].includes(k)))throw Error('Unsupported job mutation');
  result=JSON.stringify(await provider('','PATCH',{job:delta}));
}
else if(mode==='flips')result=JSON.stringify(await heartbeat('/flips/'));
else throw Error('Unknown operation');
if(['history','inventory'].includes(mode)) {
  const capturedAt=new Date().toISOString();
  await writeFile(`.scrappy/mission-provider-${mode}-${capturedAt.replaceAll(':','-')}.json`,JSON.stringify({capturedAt,data:JSON.parse(result)},null,2));
}
console.log(result);
