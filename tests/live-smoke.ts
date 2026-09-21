/** Opt-in real model smoke test: start Nexa first, then bun --no-install tests/live-smoke.ts. */
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';

const root=resolve(import.meta.dir,'..');
const base=process.env.NEXA_TEST_API_URL||'http://127.0.0.1:8787';
const key=process.env.NEXA_ADMIN_KEY||readFileSync(join(process.env.NEXA_DATA_DIR||join(root,'data'),'admin-key.txt'),'utf8').trim();
async function api(path:string,body?:unknown) {
  const response=await fetch(base+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Nexa-Admin-Key':key,...(process.env.NEXA_API_KEY?{Authorization:'Bearer '+process.env.NEXA_API_KEY}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150_000)});
  const value=await response.json() as any;
  assert(response.ok,JSON.stringify(value));return value;
}
async function finished(id:string) {
  const deadline=Date.now()+120_000;
  while(Date.now()<deadline) {
    const job=(await api('/jobs')).jobs.find((j:any)=>j.id===id);
    if(job?.status==='completed'){assert.equal(job.errors.length,0,JSON.stringify(job));return job;}
    if(job?.status==='failed')throw new Error(JSON.stringify(job));
    await Bun.sleep(200);
  }
  throw new Error('Index job timeout');
}
const health=await api('/health');
assert.equal(health.status,'ok');
const sourceIds=[];
for(const revision of ['A','B']) {
  const path=join(root,'examples','atlas-'+revision.toLowerCase());
  let source=(await api('/sources')).sources.find((s:any)=>s.path.toLowerCase()===path.toLowerCase());
  const submitted=source?await api('/sources/'+source.id+'/reindex',{}):await api('/sources/folder',{path,name:`예제 · ATLAS Rev ${revision}`,board:'ATLAS',revision});
  source=source||submitted.source;sourceIds.push(source.id);
  await finished(submitted.job.id);
}
const checks=[
  {query:'UART 콘솔 통신 속도는 얼마야?',revision:'A',expected:'115200'},
  {query:'UART 콘솔 통신 속도는 얼마야?',revision:'B',expected:'921600'},
  {query:'SPI 전송 대기 시간이 초과되면 어떤 오류를 반환해?',revision:'A',expected:'-ETIMEDOUT'},
  {query:'전원 레일을 어떤 순서로 켜야 해?',revision:'A',expected:'1.8 V'},
  {query:'애플리케이션 플래시 시작 주소는?',revision:'A',expected:'0x00080000'},
  {query:'이 보드의 최대 동작 온도는 얼마야?',revision:'A',expected:null},
];
const results=[];
for(const check of checks) {
  const response=await api('/ask',{query:check.query,board:'ATLAS',revision:check.revision});
  assert.equal(response.mode,'hybrid');
  assert.equal(response.answerable,check.expected!==null,JSON.stringify(response));
  if(check.expected) {
    assert(response.answer.includes(check.expected),JSON.stringify(response));
    assert(response.citations.length>0);
    assert(response.citations.every((c:any)=>c.board==='ATLAS'&&c.revision===check.revision));
    for(const citation of response.citations) {
      const doc=await api('/documents/'+citation.documentId);
      assert(doc.text.includes(citation.text.trim()));
    }
  }else assert.equal(response.citations.length,0);
  const result={query:check.query,revision:check.revision,answer:response.answer,answerable:response.answerable,citations:response.citations.map((c:any)=>({path:c.path,startLine:c.startLine,endLine:c.endLine,page:c.page})),timingMs:response.timingMs,passed:true};
  results.push(result);console.log(JSON.stringify(result));
}
await Bun.write(join(root,'data','live-smoke-results.json'),JSON.stringify({testedAt:new Date().toISOString(),synthetic:true,sourceIds,results},null,2));
console.log(`${results.length}/${checks.length} real-model smoke checks passed. Examples remain registered for UI exploration.`);
