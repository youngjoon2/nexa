/**
 * Opt-in real-model verification. Existing llama.cpp/Qdrant services must already be running.
 * PowerShell:
 *   $env:NEXA_LIVE_VERSION_SMOKE='1'
 *   & .\.runtime\bun\bun.exe --no-install tests/version-live-smoke.ts
 *   Remove-Item Env:NEXA_LIVE_VERSION_SMOKE
 * All files use a new temporary directory; Qdrant uses a unique, disposable collection.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../src/config';
import {Store} from '../src/storage';
import {KnowledgeBase} from '../src/knowledge';
import {Providers} from '../src/providers';
import {Indexer} from '../src/indexer';
import {AnalysisManager,planQuery} from '../src/analysis';
import {askKnowledge} from '../src/knowledge-retrieval';
import type {Source,Job} from '../src/types';

async function run() {
  const temporary=mkdtempSync(join(tmpdir(),'nexa-version-live-'));
  const root=resolve(import.meta.dir,'..');
  const collection='nexa_version_smoke_'+randomUUID().replaceAll('-','');
  const config={...loadConfig({...process.env,NEXA_DATA_DIR:join(temporary,'data'),NEXA_HOST:'127.0.0.1',NEXA_MODE:'full',NEXA_API_KEY:'',NEXA_ADMIN_KEY:'isolated-live-smoke-administrator-key'},root),collection};
  assert(/^nexa_version_smoke_[a-f0-9]{32}$/.test(config.collection));
  assert.notEqual(config.collection,'nexa_embeddinggemma_768_v1');
  const store=new Store(join(config.dataDir,'live.sqlite'));
  const kb=new KnowledgeBase(store,config),providers=new Providers(config);
  const indexer=new Indexer(store,providers,config,kb),analysis=new AnalysisManager(kb,providers);
  let collectionOwned=false;
  const start=performance.now();
  const diagnostics:{phase:string;versions?:any[];answers?:any[];feature?:any;comparison?:any}={phase:'service-health'};
  try {
    const health=await providers.health();
    assert(Object.values(health).every(service=>service.ok),'Existing generation, embedding and Qdrant services must all be healthy. This script does not start services.');
    const existing=await providers.request(config.qdrantURL,'/collections');
    assert(Array.isArray(existing.result?.collections),'Qdrant collection listing is malformed.');
    assert(!existing.result.collections.some((entry:any)=>entry.name===collection),'Refusing to reuse an existing collection.');
    // Set ownership before creation so partially completed setup is cleaned up too.
    collectionOwned=true;await providers.ensureCollection();
    const specs:Source={id:'live-spec',name:'Synthetic specifications',kind:'folder',path:join(temporary,'specifications'),board:'',revision:'',status:'ready'};
    const code:Source={id:'live-code',name:'Synthetic implementation',kind:'folder',path:join(temporary,'code'),board:'',revision:'',status:'ready'};
    for(const source of [specs,code]){mkdirSync(source.path,{recursive:true});store.addSource(source);kb.saveConnection(source.id,{projectId:'default',role:source===specs?'spec':'code'});}
    const uart=kb.addModule('default',{name:'UART',rules:[{pattern:'uart/**'}]});
    kb.addModule('default',{name:'POWER',rules:[{pattern:'power/**'}]});
    const put=(source:Source,path:string,text:string)=>{const target=join(source.path,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);};
    const waitIndex=async(job:Job)=>{
      const deadline=Date.now()+180_000;
      while(Date.now()<deadline){const current=indexer.jobs().find(value=>value.id===job.id)!;if(['completed','failed'].includes(current.status)&&!indexer.state().running){assert.equal(current.status,'completed',current.message);assert.deepEqual(current.errors,[],current.errors.join('; '));return;}await new Promise(r=>setTimeout(r,50));}
      throw new Error('Temporary fixture indexing timed out.');
    };
    const versions=[];
    diagnostics.versions=versions;
    for(let i=0;i<3;i++) {
      const name=`v${i+1}.0`,baud=i===0?115200:230400;
      diagnostics.phase=`fixture-indexing:${name}`;
      put(specs,'uart/spec.md',`# UART ${name}\n\n콘솔 통신 속도: ${baud} bps.\n\nTRACE_EXPORT 기능: ${i===0?'이 버전은 TRACE_EXPORT를 지원하지 않습니다.':'이 버전의 사양은 TRACE_EXPORT 기능을 지원한다고 명시합니다.'}\nTRACE_EXPORT는 UART 진단 기록을 CSV 형식으로 내보내는 기능입니다.\n`);
      put(specs,'power/spec.md',`# POWER ${name}\nPOWER_CURRENT_LIMIT: ${20+i*10} mA.\n`);
      put(code,'uart/trace.c',i===0?'int uart_ready(void) { return 1; }\n':`int TRACE_EXPORT(char *out, unsigned capacity) {\n  if (!out || capacity < 4) return -1;\n  out[0] = 'o'; out[1] = 'k'; out[2] = '\\n'; out[3] = '\\0';\n  return 3;\n}\n`);
      put(code,'uart/build.cmake',`# Confirmed release ${name} build manifest.\n# TRACE_EXPORT is ${i===1?'included in':'explicitly excluded from'} this release artifact.\nset(TRACE_EXPORT_INCLUDED ${i===1?'TRUE':'FALSE'})\n`);
      put(code,'power/power.c',`int power_current_limit(void) { return ${20+i*10}; }\n`);
      await waitIndex(indexer.enqueue(specs.id));await waitIndex(indexer.enqueue(code.id));
      versions.push(kb.saveVersion({projectId:'default',name,snapshots:kb.currentBindings('default')}));
    }
    assert.equal(versions.length,3);assert.equal(kb.pendingEmbeddings(),0);
    const answers=[];
    diagnostics.answers=answers;
    for(const [index,baud] of [[0,115200],[1,230400]] as const) {
      const version=versions[index]!;
      diagnostics.phase=`grounded-answer:${version.name}`;
      const answer=await askKnowledge(kb,providers,{query:'UART 콘솔 통신 속도는 얼마입니까?',projectId:'default',versionId:version.id,moduleId:uart.id});
      answers.push({version:version.name,answer:answer.answer,citations:answer.citations.map(hit=>({id:hit.id,path:hit.path,snapshotId:hit.snapshotId,versionId:hit.versionId}))});
      assert.equal(answer.answerable,true,'A direct numeric question must have a grounded answer.');
      assert(answer.citations.length>0);
      assert(new RegExp(`(?:^|[^0-9])${baud}(?:[^0-9]|$)`).test(answer.answer.replaceAll(',','')),`Expected grounded baud ${baud}; received ${answer.answer}`);
      assert(answer.citations.every(hit=>hit.versionId===version.id&&hit.moduleId===uart.id&&hit.snapshotId&&Object.values(version.snapshots).includes(hit.snapshotId)));
    }
    const route=await planQuery(kb,providers,{query:'TRACE_EXPORT 기능이 들어간 SW 버전이 어디야?',projectId:'default',moduleId:uart.id});
    assert('mode' in route&&route.mode==='feature');
    const waitAnalysis=async(id:string)=>{
      const deadline=Date.now()+360_000;
      while(Date.now()<deadline){const current=analysis.get(id)!;if(['completed','failed','cancelled'].includes(current.status)){assert.equal(current.status,'completed',current.error||current.message);return current;}await new Promise(r=>setTimeout(r,50));}
      analysis.cancel(id);throw new Error('Real-model analysis timed out.');
    };
    diagnostics.phase='feature-analysis';
    const feature=await waitAnalysis(analysis.enqueue({projectId:'default',query:'TRACE_EXPORT 기능',mode:'feature',moduleId:uart.id,versionIds:versions.map(v=>v.id)}).id);
    diagnostics.feature=feature;
    diagnostics.phase='feature-assertions';
    const rows=feature.result.rows;
    assert.deepEqual(rows.map((row:any)=>row.versionId),versions.map(v=>v.id),'Every requested version must have its own row.');
    assert.equal(rows[1].spec.state,'supported','v2 has explicit specification support.');
    assert.equal(rows[1].code.state,'supported','v2 has an actual TRACE_EXPORT function definition.');
    assert.equal(rows[1].build.state,'supported','v2 build manifest explicitly includes TRACE_EXPORT.');
    assert.equal(rows[2].build.state,'absent','v3 retains source implementation but explicitly excludes it from the release build.');
    assert.notEqual(rows[0].build.state,'supported','v1 must not inherit the v2 build conclusion.');
    assert(!['supported','conflict'].includes(rows[0].code.state),'v1 only defines uart_ready; it must not claim a TRACE_EXPORT implementation from an unrelated function.');
    for(const row of rows)for(const kind of ['spec','code','build']) {
      for(const evidence of row[kind].evidence){assert(evidence.hit.text.replace(/\s+/g,' ').includes(evidence.quote.replace(/\s+/g,' ')));assert.equal(evidence.hit.versionId,row.versionId);}
    }
    diagnostics.phase='comparison-analysis';
    const comparison=await waitAnalysis(analysis.enqueue({projectId:'default',query:'UART 모듈의 콘솔 속도와 TRACE_EXPORT 사양 변경을 비교해줘.',mode:'compare',moduleId:uart.id,versionIds:[versions[0]!.id,versions[1]!.id]}).id);
    diagnostics.comparison=comparison;
    diagnostics.phase='comparison-assertions';
    const documents=comparison.result.documents;
    assert(documents.length>0);assert(documents.every((doc:any)=>(doc.after?.path||doc.before?.path).startsWith('uart/')),'POWER documents must not enter UART comparison.');
    const numericBefore=documents.flatMap((doc:any)=>doc.hunks.flatMap((h:any)=>h.numbers.before));
    const numericAfter=documents.flatMap((doc:any)=>doc.hunks.flatMap((h:any)=>h.numbers.after));
    assert(numericBefore.some((token:string)=>token.includes('115200')));assert(numericAfter.some((token:string)=>token.includes('230400')));
    const summaries=documents.flatMap((doc:any)=>doc.summaries);
    assert(summaries.length>0,'At least one bounded real-model comparison summary must pass bilateral citation validation.');
    for(const summary of summaries) {
      assert(summary.citations.some((hit:any)=>hit.versionId===versions[0]!.id));assert(summary.citations.some((hit:any)=>hit.versionId===versions[1]!.id));
      const citedText=summary.citations.map((hit:any)=>hit.text).join('\n')+'\n'+versions.slice(0,2).map(v=>v.name).join('\n');
      const allowed=new Set((citedText.match(/\d+(?:\.\d+)?/g)||[]).map(token=>Number(token)));
      for(const token of summary.answer.replaceAll(',','').match(/\d+(?:\.\d+)?/g)||[])assert(allowed.has(Number(token)),`Model introduced uncited numeric value ${token}: ${summary.answer}`);
    }
    const report={passed:true,elapsedMs:Math.round(performance.now()-start),temporaryCollection:collection,versions:versions.map(v=>({id:v.id,name:v.name,snapshots:v.snapshots})),answers,
      feature:rows.map((row:any)=>({version:row.versionName,state:row.state,spec:row.spec.state,code:row.code.state,build:row.build.state,warnings:row.warnings})),
      comparison:{documents:documents.map((doc:any)=>({path:doc.after?.path||doc.before?.path,status:doc.status,numbers:doc.hunks.map((h:any)=>h.numbers),warnings:doc.warnings})),summaries:summaries.map((summary:any)=>({answer:summary.answer,versions:[...new Set(summary.citations.map((hit:any)=>hit.versionId))]}))}};
    console.log(JSON.stringify(report,null,2));
  } catch(error) {
    // Log full fixture evidence before cleanup: state alone cannot distinguish bad quotes from mixed candidate roles.
    console.error(JSON.stringify({passed:false,elapsedMs:Math.round(performance.now()-start),temporaryCollection:collection,
      error:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error),
      ...diagnostics,analysisJobs:analysis.list()},null,2));
    throw error;
  } finally {
    analysis.stop();indexer.stop();
    // Cancel accepted work and wait for its bounded provider request to finish before closing SQLite.
    for(const job of analysis.list())if(['queued','running'].includes(job.status))analysis.cancel(job.id);
    const deadline=Date.now()+130_000;
    while((analysis.state().running||indexer.state().running)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    if(collectionOwned) {
      assert(/^nexa_version_smoke_[a-f0-9]{32}$/.test(collection));
      try{await providers.request(config.qdrantURL,'/collections/'+collection,undefined,'DELETE',30_000);}
      catch(error){console.error('Temporary collection cleanup failed:',collection,error instanceof Error?error.message:String(error));}
    }
    store.close();
    const resolved=resolve(temporary),rel=relative(resolve(tmpdir()),resolved);
    assert(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('nexa-version-live-'),'Refusing to clean a directory outside this smoke test.');
    rmSync(resolved,{recursive:true,force:true});
  }
}

if(process.env.NEXA_LIVE_VERSION_SMOKE!=='1')console.log('Skipped: set NEXA_LIVE_VERSION_SMOKE=1 to run against existing local model services using isolated temporary data.');
else await run();
