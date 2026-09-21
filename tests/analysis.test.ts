import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage';
import {KnowledgeBase} from '../src/knowledge';
import {SerialGate,type Providers} from '../src/providers';
import type {Config} from '../src/config';
import type {Hit,Source} from '../src/types';
import {AnalysisManager,compareDocuments,diffText,planQuery,selectFeatureCandidates,validateFeatureEvidence} from '../src/analysis';
import {askKnowledge,searchKnowledge} from '../src/knowledge-retrieval';

let directory:string,store:Store,kb:KnowledgeBase;
const managers:AnalysisManager[]=[];
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'nexa-analysis-test-'));
  store=new Store(join(directory,'test.sqlite'));
  kb=new KnowledgeBase(store,{root:directory,dataDir:directory} as Config);
});
afterEach(()=>{for(const manager of managers)manager.stop();managers.length=0;store.close();rmSync(directory,{recursive:true,force:true});});

function providers(mode:'keyword'|'full'='keyword',extra:Record<string,unknown>={}) {
  return {config:{mode,qdrantURL:'http://127.0.0.1:16333'},generationGate:new SerialGate(12),
    embed:async()=>{throw new Error('offline');},tokens:async()=>100,collectionPath:()=>'/collections/test',...extra} as unknown as Providers;
}
function source(id='spec',role:'spec'|'code'|'reference'='spec') {
  const source:Source={id,name:id,kind:'folder',path:join(directory,id),board:'',revision:'',status:'ready'};
  if(!store.source(id))store.addSource(source);
  kb.saveConnection(id,{projectId:'default',role});return source;
}
function snapshot(owner:Source,files:Record<string,string>,extraChunks?:Record<string,any[]>) {
  const entries=Object.entries(files).map(([path,text])=>({path,...kb.putParsed(new TextEncoder().encode(text),{title:path,text,warnings:[],chunks:extraChunks?.[path]||[{text,startLine:1,endLine:text.split('\n').length}]},'test-v1',path)}));
  const result=kb.createSnapshot(owner,entries,{errors:[],excluded:[]});kb.activate(owner.id,result.id);return result;
}
function version(name:string,files:Record<string,string>,owner=source()) {const snap=snapshot(owner,files);return kb.saveVersion({name,projectId:'default',snapshots:{[owner.id]:snap.id}});}
function manager(p=providers()){const result=new AnalysisManager(kb,p);managers.push(result);return result;}
async function finished(m:AnalysisManager,id:string) {
  for(let i=0;i<1000;i++){const job=m.get(id)!;if(['completed','failed','cancelled'].includes(job.status))return job;await new Promise(r=>setTimeout(r,2));}
  throw new Error('analysis did not finish');
}

test('scoped hybrid search retains duplicate content occurrences and excludes other versions and projects',async()=>{
  const first=version('v1',{'one.md':'UART_CAP enables diagnostics.','two.md':'UART_CAP enables diagnostics.'});
  const second=version('v2',{'one.md':'UART_CAP removed in this specification.'});
  const valid=kb.lexical({query:'UART_CAP',versionId:first.id});
  const unrelated=kb.lexical({query:'UART_CAP',versionId:second.id});
  // Force the exact same chunk content to occur under another path in a snapshot.
  const file=kb.snapshotFiles(Object.values(first.snapshots)[0]!)[0]!;
  const module=kb.addModule('default',{name:'Shared',rules:[{pattern:'**',role:'spec'}]});
  const duplicateSnapshot=kb.createSnapshot(source(),[{path:'a.md',parsedKey:file.parsedKey,rawHash:file.rawHash},{path:'b.md',parsedKey:file.parsedKey,rawHash:file.rawHash}],{errors:[],excluded:[]});
  const duplicated=kb.saveVersion({name:'duplicate',projectId:'default',snapshots:{spec:duplicateSnapshot.id}});
  const duplicates=kb.lexical({query:'UART_CAP',versionId:duplicated.id});
  expect(duplicates).toHaveLength(2);expect(duplicates[0]!.id).toBe(duplicates[1]!.id);
  let filter:any;
  const p=providers('full',{embed:async()=>[1],request:async(_base:string,_path:string,body:any)=>{filter=body.filter;return {result:{points:[{id:unrelated[0]!.id},{id:duplicates[0]!.id},{id:'deleted'}]}};}});
  const result=await searchKnowledge(kb,p,{query:'UART_CAP',projectId:'default',versionId:duplicated.id,moduleId:module.id,role:'spec',limit:8});
  expect(result.mode).toBe('hybrid');expect(result.hits).toHaveLength(2);
  expect(new Set(result.hits.map(h=>h.documentId)).size).toBe(2);
  expect(result.hits.every(h=>h.channels.includes('vector')&&h.versionId===duplicated.id)).toBe(true);
  expect(filter.must).toContainEqual({key:'snapshotIds',match:{any:[duplicateSnapshot.id]}});
  expect(filter.must).toContainEqual({key:'projectId',match:{value:'default'}});
  expect(filter.must).toContainEqual({key:'moduleIds',match:{value:module.id}});
  expect(filter.must).toContainEqual({key:'roles',match:{value:'spec'}});
  expect(kb.memberships(duplicates[0]!.id)).toContainEqual({snapshotId:duplicateSnapshot.id,projectId:'default',moduleId:module.id,role:'spec'});
  expect(valid.length).toBe(2);
});

test('general answers expose the same evidence IDs that the model can cite and return original citations',async()=>{
  const selected=version('v1',{'uart.md':'UART_CAP supports 115200 baud.','clock.md':'UART_CAP uses a 48 MHz clock.'});
  const originals=kb.lexical({query:'UART_CAP',versionId:selected.id});
  let evidence:Hit[]=[];
  const p=providers('full',{complete:async(messages:{role:string;content:string}[],allowed:string[])=>{
    const content=messages.find(message=>message.role==='user')!.content;
    evidence=content.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    expect(evidence.map(hit=>hit.id)).toEqual(allowed);
    expect(allowed).toEqual(['D1','D2']);
    return {answerable:true,answer:'115200 baud 통신을 지원하며 48 MHz 클록을 사용합니다.',citations:allowed};
  }});
  const result=await askKnowledge(kb,p,{query:'UART_CAP',versionId:selected.id});
  expect(result.answerable).toBe(true);
  expect(result.citations.map(hit=>hit.id).sort()).toEqual(originals.map(hit=>hit.id).sort());
  expect(result.citations.map(hit=>hit.documentId)).toEqual(evidence.map(hit=>hit.documentId));
  expect(result.citations.every(hit=>hit.versionId===selected.id)).toBe(true);
});

test('search coverage counts only documents matching board and revision filters',async()=>{
  const a=source('a'),b=source('b');a.board='Atlas';a.revision='A';b.board='Atlas';b.revision='B';
  const first=snapshot(a,{'spec.md':'UART_CAP 115200 baud.'}),second=snapshot(b,{'spec.md':'UART_CAP 921600 baud.'});
  const selected=kb.saveVersion({name:'both boards',projectId:'default',snapshots:{a:first.id,b:second.id}});
  const input={query:'UART_CAP',versionId:selected.id,board:'Atlas',revision:'B'};
  const result=await searchKnowledge(kb,providers(),input);
  expect(result.coverage.documents).toBe(1);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]!.text).toContain('921600');
  expect(kb.scopeInfo({...input,revision:'unknown'}).coverage.documents).toBe(0);
  expect(kb.scopeInfo({...input,board:'Other'}).coverage.documents).toBe(0);
  expect(kb.scopeInfo({query:'UART_CAP',board:'Atlas'}).coverage.documents).toBe(2);
});

test('intentional keyword search skips model services while full-mode fallback preserves failure warnings',async()=>{
  version('v1',{'uart.md':'UART_CAP supports 115200 baud.'});
  kb.saveConnection('spec',{errors:['일부 문서를 읽지 못했습니다.']});
  for(const mode of ['keyword','full'] as const){
    let embeddingCalls=0,vectorCalls=0;
    const p=providers(mode,{
      embed:async()=>{embeddingCalls++;throw new Error('offline');},
      request:async()=>{vectorCalls++;throw new Error('offline');},
    });
    const result=await searchKnowledge(kb,p,{query:'UART_CAP'});
    expect(result.mode).toBe('keyword');
    expect(result.hits).toHaveLength(1);
    expect(result.warnings).toContain('spec: 일부 문서를 읽지 못했습니다.');
    expect(result.warnings.some(warning=>warning.includes('임베딩 또는 벡터 서비스'))).toBe(mode==='full');
    expect(embeddingCalls).toBe(mode==='keyword'?0:1);
    expect(vectorCalls).toBe(0);
  }
});

test('feature exploration always returns every version; keyword candidates and no-hits remain unknown',async()=>{
  const a=version('v1',{'spec.md':'UART_CAP diagnostics are supported.'});
  const b=version('v2',{'spec.md':'A completely different feature.'});
  const m=manager();const job=await finished(m,m.enqueue({projectId:'default',mode:'feature',query:'UART_CAP'}).id);
  expect(job.status).toBe('completed');expect(job.result.rows.map((r:any)=>r.versionId)).toEqual([a.id,b.id]);
  for(const row of job.result.rows){expect(row.state).toBe('unknown');expect(row.spec.state).toBe('unknown');expect(row.code.state).toBe('unknown');expect(row.build.state).toBe('unknown');}
  expect(job.result.rows[0].spec.citations.length).toBeGreaterThan(0);
  expect(job.result.rows[1].spec.citations).toEqual([]);
  expect(job.result.firstConfirmedVersionId).toBeNull();
});

test('feature evidence requires exact cited quotes and records opposing evidence as conflict',()=>{
  const hit={id:'chunk',documentId:'doc',text:'UART_CAP is supported. UART_CAP is explicitly excluded from this release.'} as Hit;
  const context=new Map([['E1',hit]]);
  expect(validateFeatureEvidence({evidence:[]},context).state).toBe('unknown');
  expect(()=>validateFeatureEvidence({evidence:[{id:'E1',quote:'UART_CAP is unsupported.',support:'absent'}]},context)).toThrow();
  expect(()=>validateFeatureEvidence({evidence:[{id:'other',quote:'UART_CAP is supported.',support:'present'}]},context)).toThrow();
  const conflict=validateFeatureEvidence({evidence:[{id:'E1',quote:'UART_CAP is supported.',support:'present'},{id:'E1',quote:'UART_CAP is explicitly excluded from this release.',support:'absent'}]},context);
  expect(conflict.state).toBe('conflict');expect(conflict.citations).toHaveLength(1);expect(conflict.evidence).toHaveLength(2);
});

test('spec support never becomes build inclusion without separate model-verified evidence',async()=>{
  version('v1',{'spec.md':'UART_CAP diagnostics are supported.'});
  const p=providers('full',{completeStructured:async(messages:any[])=>{
    const line=messages[1].content.split('\n').find((value:string)=>value.startsWith('{"id"'));
    const evidence=JSON.parse(line);return {evidence:[{id:evidence.id,quote:evidence.text,support:'present'}]};
  }});
  const m=manager(p);const job=await finished(m,m.enqueue({projectId:'default',mode:'feature',query:'UART_CAP'}).id);
  expect(job.status).toBe('completed');const row=job.result.rows[0];
  expect(row.spec.state).toBe('supported');expect(row.code.state).toBe('unknown');expect(row.build.state).toBe('unknown');expect(row.state).toBe('unknown');
});

test('build evidence candidates accept diverse configuration and release records but not ordinary source functions',()=>{
  const hit=(path:string,text:string)=>({id:path,documentId:path,path,text} as Hit);
  const implementation=hit('build/trace.c','int TRACE_EXPORT(void) { return 1; }');
  const ordinary=hit('config/parser.ts','function build() { return enabled(); }');
  const code=[implementation,ordinary,hit('uart/build.cmake','set(TRACE_EXPORT_INCLUDED FALSE)'),hit('Makefile','UART_FEATURE := TRACE_EXPORT'),hit('configs/product_defconfig','CONFIG_TRACE_EXPORT=n')];
  const references=[hit('releases/v3.md','TRACE_EXPORT is excluded from the release artifact.'),hit('shipping-record.txt','The signed binary build explicitly excludes TRACE_EXPORT.'),hit('settings.txt','TRACE_EXPORT_INCLUDED=FALSE'),hit('guide.md','TRACE_EXPORT supports CSV export.')];
  const candidates=selectFeatureCandidates(code,references);
  expect(candidates.code.map(h=>h.path)).toEqual([implementation.path,ordinary.path]);
  expect(candidates.build.map(h=>h.path)).toEqual(['uart/build.cmake','Makefile','configs/product_defconfig','releases/v3.md','shipping-record.txt','settings.txt']);
});

test('source implementation remains present while its release manifest explicitly excludes the build',async()=>{
  const owner=source('code','code');
  const implementation='int TRACE_EXPORT(void) { return 1; }';
  const exclusion='Confirmed release v3: TRACE_EXPORT is explicitly excluded from this release artifact.\nset(TRACE_EXPORT_INCLUDED FALSE)';
  const snap=snapshot(owner,{'uart/trace.c':implementation,'uart/build.cmake':exclusion});
  kb.saveVersion({name:'v3',projectId:'default',snapshots:{code:snap.id}});
  const inspected:{check:string;paths:string[]}[]=[];
  const p=providers('full',{completeStructured:async(messages:any[])=>{
    const lines=messages[1].content.split('\n'),header=JSON.parse(lines[0]);
    const context=lines.filter((line:string)=>line.startsWith('{"id"')).map((line:string)=>JSON.parse(line));
    inspected.push({check:header.check,paths:context.map((hit:any)=>hit.path)});
    // Reproduce the contamination bug: a generic function would become a positive build vote.
    return {evidence:context.map((hit:any)=>({id:hit.id,quote:hit.text,support:hit.path.endsWith('.cmake')?'absent':'present'}))};
  }});
  const m=manager(p),job=await finished(m,m.enqueue({projectId:'default',mode:'feature',query:'TRACE_EXPORT'}).id);
  expect(job.status).toBe('completed');const row=job.result.rows[0];
  expect(row.code.state).toBe('supported');expect(row.build.state).toBe('absent');expect(row.state).toBe('absent');
  expect(row.code.citations.map((hit:Hit)=>hit.path)).toEqual(['uart/trace.c']);
  expect(row.build.citations.map((hit:Hit)=>hit.path)).toEqual(['uart/build.cmake']);
  expect(inspected).toEqual([{check:'code',paths:['uart/trace.c']},{check:'build',paths:['uart/build.cmake']}]);
});

test('implementation alone never invokes a build verdict and build-only records never imply source implementation',async()=>{
  const owner=source('code','code');
  version('source-only',{'feature.c':'int TRACE_EXPORT(void) { return 1; }'},owner);
  version('build-only',{'release-manifest.json':'{"TRACE_EXPORT_INCLUDED":true,"release":"v2"}'},owner);
  const p=providers('full',{completeStructured:async(messages:any[])=>{
    const evidence=JSON.parse(messages[1].content.split('\n').find((line:string)=>line.startsWith('{"id"')));
    return {evidence:[{id:evidence.id,quote:evidence.text,support:'present'}]};
  }});
  const m=manager(p),job=await finished(m,m.enqueue({projectId:'default',mode:'feature',query:'TRACE_EXPORT'}).id);
  expect(job.status).toBe('completed');
  const [sourceOnly,buildOnly]=job.result.rows;
  expect(sourceOnly.code.state).toBe('supported');expect(sourceOnly.build.state).toBe('unknown');
  expect(buildOnly.code.state).toBe('unknown');expect(buildOnly.build.state).toBe('supported');
});

test('explicit code identifiers reject unrelated vector candidates and partial identifier matches while Korean feature questions remain semantic',async()=>{
  const owner=source('code','code');
  const saved=version('v1',{'uart/trace.c':'int uart_ready(void) { return 1; }\nint TRACE_EXPORT_V2(void) { return 2; }'},owner);
  const hits=kb.lexical({query:'uart_ready',projectId:'default',versionId:saved.id});
  let classified=0;
  const p=providers('full',{embed:async()=>[1],request:async()=>({result:{points:hits.map(hit=>({id:hit.id}))}}),completeStructured:async(messages:any[])=>{
    classified++;const evidence=JSON.parse(messages[1].content.split('\n').find((line:string)=>line.startsWith('{"id"')));
    return {evidence:[{id:evidence.id,quote:evidence.text,support:'present'}]};
  }});
  const m=manager(p);
  const exact=await finished(m,m.enqueue({projectId:'default',query:'TRACE_EXPORT 기능',mode:'feature',versionIds:[saved.id]}).id);
  expect(exact.status).toBe('completed');expect(exact.result.rows[0].code.state).toBe('unknown');expect(exact.result.rows[0].code.evidence).toEqual([]);expect(classified).toBe(0);
  const semantic=await finished(m,m.enqueue({projectId:'default',query:'준비 상태 확인 기능',mode:'feature',versionIds:[saved.id]}).id);
  expect(semantic.status).toBe('completed');expect(semantic.result.rows[0].code.state).toBe('supported');expect(classified).toBe(1);
});

test('code evidence quotes must contain the exact requested identifier even when the surrounding chunk does',()=>{
  const hit={id:'chunk',documentId:'doc',text:'int TRACE_EXPORT(void) { return 1; }\nint uart_ready(void) { return 1; }\nint TRACE_EXPORT_V2(void) { return 1; }'} as Hit;
  const context=new Map([['E1',hit]]);
  for(const quote of ['int uart_ready(void) { return 1; }','int TRACE_EXPORT_V2(void) { return 1; }'])
    expect(()=>validateFeatureEvidence({evidence:[{id:'E1',quote,support:'present'}]},context,['TRACE_EXPORT'])).toThrow('식별자');
  expect(validateFeatureEvidence({evidence:[{id:'E1',quote:'int TRACE_EXPORT(void) { return 1; }',support:'present'}]},context,['TRACE_EXPORT']).state).toBe('supported');
});

test('contradictory spec/code findings remain visible and normal generation runs between analysis steps',async()=>{
  const spec=snapshot(source('spec','spec'),{'s.md':'UART_CAP is supported.'});
  const code=snapshot(source('code','code'),{'c.md':'UART_CAP is explicitly not implemented.'});
  kb.saveVersion({name:'v1',projectId:'default',snapshots:{spec:spec.id,code:code.id}});
  const events:string[]=[];let release!:()=>void,started!:()=>void;
  const blocked=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
  const p=providers('full',{completeStructured:async(messages:any[])=>{
    const lines=messages[1].content.split('\n'),header=JSON.parse(lines[0]);events.push(header.check);
    if(header.check==='spec'){started();await blocked;}
    if(header.check==='build')return {evidence:[]};
    const evidence=JSON.parse(lines.find((line:string)=>line.startsWith('{"id"')));
    return {evidence:[{id:evidence.id,quote:evidence.text,support:header.check==='spec'?'present':'absent'}]};
  }});
  const m=manager(p),job=m.enqueue({projectId:'default',mode:'feature',query:'UART_CAP'});
  await began;const normal=p.generationGate.run(async()=>{events.push('normal');});release();await normal;
  const result=await finished(m,job.id),row=result.result.rows[0];
  expect(result.status).toBe('completed');expect(events.slice(0,3)).toEqual(['spec','normal','code']);
  expect(row.state).toBe('conflict');expect(row.spec.state).toBe('supported');expect(row.code.state).toBe('absent');expect(row.build.state).toBe('unknown');
  expect(row.spec.evidence[0].quote).toBe('UART_CAP is supported.');expect(row.code.evidence[0].quote).toBe('UART_CAP is explicitly not implemented.');
});

test('text diff preserves every changed line and numeric spelling, including dense fallback',()=>{
  const before='title\nCLOCK = 48 MHz\nunchanged\nOFFSET = 0x4000\nend';
  const after='title\nCLOCK = 96 MHz\nunchanged\nOFFSET = 0x8000\nend';
  const diff=diffText(before,after);
  expect(diff.hunks).toHaveLength(2);expect(diff.hunks[0]!.beforeStart).toBe(2);
  expect(diff.hunks[0]!.numbers).toEqual({before:['48 MHz'],after:['96 MHz']});
  expect(diff.hunks[1]!.numbers).toEqual({before:['0x4000'],after:['0x8000']});
  const dense=diffText(Array.from({length:11000},(_,i)=>'old '+i).join('\n'),Array.from({length:11000},(_,i)=>'new '+i).join('\n'));
  expect(dense.method).toBe('bounded_replace');expect(dense.hunks[0]!.removed).toHaveLength(11000);expect(dense.hunks[0]!.added).toHaveLength(11000);
  // Reconstruct both inputs from the hunk coordinates for additions, deletions and separated edits.
  for(const [a,b] of [['a\nb\nc','a\nx\nb\nc'],['a\nb\nc','a\nc'],['a\nb\nc','x\nb\ny'],['','one'],['one',''],['x\ny\nx','y\nx\ny']]) {
    const changes=diffText(a!,b!);const lines=a!.split('\n');let offset=0;
    for(const hunk of changes.hunks){lines.splice(hunk.beforeStart-1+offset,hunk.removed.length,...hunk.added);offset+=hunk.added.length-hunk.removed.length;}
    expect(lines.join('\n')).toBe(b!);
  }
});

test('keyword comparison covers full spec documents regardless of question top-k and preserves tables',async()=>{
  const owner=source();
  const a=snapshot(owner,{'clock.md':'Clock\n48 MHz','other.md':'Limit 20 mA'},{'clock.md':[{text:'Clock\n48 MHz',startLine:1,endLine:2,table:1}]});
  const va=kb.saveVersion({name:'v1',projectId:'default',snapshots:{spec:a.id}});
  const b=snapshot(owner,{'clock.md':'Clock\n96 MHz','other.md':'Limit 40 mA'},{'clock.md':[{text:'Clock\n96 MHz',startLine:1,endLine:2,table:1}]});
  const vb=kb.saveVersion({name:'v2',projectId:'default',snapshots:{spec:b.id}});
  const m=manager();const job=await finished(m,m.enqueue({projectId:'default',mode:'compare',query:'Clock',versionIds:[va.id,vb.id]}).id);
  expect(job.status).toBe('completed');expect(job.result.documents).toHaveLength(2);
  expect(job.result.documents.every((d:any)=>d.status==='modified'&&d.beforeCitations.length&&d.afterCitations.length)).toBe(true);
  const clock=job.result.documents.find((d:any)=>d.before.path==='clock.md');
  expect(clock.tables.before).toEqual([{table:1,text:'Clock\n48 MHz'}]);expect(clock.tables.after).toEqual([{table:1,text:'Clock\n96 MHz'}]);
  expect(job.result.documents.some((d:any)=>d.before.path==='other.md')).toBe(true);
});

test('ambiguous document keys are not guessed and unilateral summaries cannot claim a comparison',async()=>{
  const a=version('v1',{'spec.md':'Clock 48 MHz'}),b=version('v2',{'spec.md':'Clock 96 MHz'});
  const docs=kb.comparisonDocuments({query:'',versionId:a.id});
  const alignment=compareDocuments([...docs,{...docs[0]!,id:'another'}],kb.comparisonDocuments({query:'',versionId:b.id}));
  expect(alignment.every(d=>d.status==='ambiguous')).toBe(true);
  const p=providers('full',{complete:async()=>({answerable:true,answer:'Clock doubled',citations:['A']})});
  const m=manager(p);const job=await finished(m,m.enqueue({projectId:'default',query:'Clock',mode:'compare',versionIds:[a.id,b.id]}).id);
  expect(job.status).toBe('completed');expect(job.result.documents[0].summaries).toEqual([]);
  expect(job.result.documents[0].hunks.length).toBeGreaterThan(0);
  expect(job.result.documents[0].warnings.join(' ')).toContain('양쪽');
});

test('query planning resolves exact registered labels in request order and asks on ambiguous scope',async()=>{
  const a=version('v1',{'s.md':'a'}),b=version('v10',{'s.md':'b'});
  const p=providers();
  const single=await planQuery(kb,p,{query:'v10의 UART 사양을 알려줘'});
  expect(single).toMatchObject({mode:'general',versionIds:[b.id]});
  const comparison=await planQuery(kb,p,{query:'v10과 v1의 사양 비교'});
  expect(comparison).toMatchObject({mode:'compare',versionIds:[b.id,a.id]});
  expect(await planQuery(kb,p,{query:'버전 비교'})).toHaveProperty('clarification');
  expect(await planQuery(kb,p,{query:'v999의 UART 사양을 알려줘'})).toHaveProperty('clarification');
  expect(await planQuery(kb,p,{query:'UART가 어느 버전에 포함되었어?'})).toMatchObject({mode:'feature',versionIds:[a.id,b.id]});
  expect(await planQuery(kb,p,{query:'UART 자동복구 기능이 들어간 SW 버전이 어디야?'})).toMatchObject({mode:'feature',versionIds:[a.id,b.id]});
  const named=version('A',{'s.md':'UART spec'});
  expect(await planQuery(kb,p,{query:'버전 A UART 사양?'})).toMatchObject({mode:'general',versionIds:[named.id]});
  kb.addProject('second');expect(await planQuery(kb,p,{query:'UART 사양 알려줘'})).toHaveProperty('clarification');
});

test('cancellation survives an in-flight model response and releases the generation gate',async()=>{
  version('v1',{'spec.md':'UART_CAP is supported.'});
  let release!:()=>void,started!:()=>void;
  const blocked=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
  const p=providers('full',{completeStructured:async()=>{started();await blocked;return {evidence:[]};}});
  const m=manager(p);const job=m.enqueue({projectId:'default',mode:'feature',query:'UART_CAP'});
  await began;m.cancel(job.id);release();
  for(let i=0;i<100&&m.state().running;i++)await new Promise(r=>setTimeout(r,2));
  expect(m.get(job.id)?.status).toBe('cancelled');expect(m.state().running).toBe(0);
  expect(await p.generationGate.run(async()=>'available')).toBe('available');
});

test('persisted interrupted analyses restart from immutable version bindings',async()=>{
  const a=version('v1',{'spec.md':'Clock 48 MHz'}),b=version('v2',{'spec.md':'Clock 96 MHz'});
  const m=manager();m.stop();const job=m.enqueue({projectId:'default',mode:'compare',query:'Clock',versionIds:[a.id,b.id]});
  kb.db.query('UPDATE analysis_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,status:'running',processed:77}),job.id);
  m.resume();const result=await finished(m,job.id);
  expect(result.status).toBe('completed');expect(result.processed).toBe(1);expect(result.versionIds).toEqual([a.id,b.id]);
});
