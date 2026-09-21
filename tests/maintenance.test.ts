import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {Store} from '../src/storage';
import {KnowledgeBase,type Snapshot} from '../src/knowledge';
import {Indexer} from '../src/indexer';
import type {Config} from '../src/config';
import type {Providers} from '../src/providers';
import type {Source,Job} from '../src/types';

let directory:string,store:Store,kb:KnowledgeBase,indexer:Indexer,owner:Source;
let embeds:string[],upserts:any[];
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'nexa-maintenance-test-'));
  const dataDir=join(directory,'data');mkdirSync(dataDir);
  const config={root:directory,dataDir,mode:'full',maxFileBytes:20*1024*1024,maxFiles:1000,
    treeSitterDir:join(directory,'tree-sitter'),pdfToTextPath:'',qdrantURL:'http://127.0.0.1:16333',collection:'test',syncIntervalMs:60000,debounceMs:20} as Config;
  store=new Store(join(dataDir,'test.sqlite'));kb=new KnowledgeBase(store,config);
  embeds=[];upserts=[];
  const providers={ensureCollection:async()=>false,collectionPath:()=>'/collections/test',embed:async(text:string)=>{embeds.push(text);return Array(768).fill(0.1);},
    request:async(_base:string,_path:string,body:any)=>{upserts.push(body);return {result:{status:'completed'}};},deletePoints:async()=>{}} as unknown as Providers;
  indexer=new Indexer(store,providers,config,kb);
  owner={id:'source',name:'documents',kind:'folder',path:join(directory,'source'),board:'board',revision:'rev',status:'ready'};
  mkdirSync(owner.path);store.addSource(owner);kb.saveConnection(owner.id,{projectId:'default',role:'spec'});
});
afterEach(()=>{indexer.stop();store.close();rmSync(directory,{recursive:true,force:true});});

function write(path:string,text:string|Uint8Array) {const target=join(owner.path,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);}
async function done(job:Job) {
  for(let i=0;i<1000;i++){const value=indexer.jobs().find(j=>j.id===job.id)!;if(['completed','failed'].includes(value.status)&&!indexer.state().running)return value;await new Promise(r=>setTimeout(r,2));}
  throw new Error('index job did not finish');
}
async function sync(){return done(indexer.enqueue(owner.id));}
function current():Snapshot {return kb.snapshot(kb.connection(owner.id).snapshotId!)!;}
function freeze(name:string,snapshotId=current().id) {return kb.saveVersion({projectId:'default',name,snapshots:{[owner.id]:snapshotId}});}
function count(table:string) {return (store.db.query(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;}
function rawText(snapshotId:string,path:string) {const f=kb.snapshotFiles(snapshotId).find(f=>f.path===path)!;return new TextDecoder().decode(kb.raw(f.rawHash));}

test('confirmed versions retain exact original bytes and text through overwrite, deletion and source disconnection',async()=>{
  const original='UART_CAP 115200\r\n원문\r\n';write('spec.md',original);expect((await sync()).status).toBe('completed');
  const first=current(),v1=freeze('v1');
  write('spec.md','UART_CAP 921600\n수정\n');await sync();const second=current();expect(second.id).not.toBe(first.id);
  expect(rawText(first.id,'spec.md')).toBe(original);
  expect(kb.lexical({query:'115200',versionId:v1.id})).toHaveLength(1);expect(kb.lexical({query:'115200'})).toHaveLength(0);
  unlinkSync(join(owner.path,'spec.md'));await sync();
  expect(kb.scopeInfo({query:'UART_CAP'}).coverage.documents).toBe(0);
  expect(kb.lexical({query:'115200',versionId:v1.id})).toHaveLength(1);
  kb.removeConnection(owner.id);store.removeSource(owner.id);
  expect(kb.lexical({query:'UART_CAP'})).toHaveLength(0);
  expect(kb.lexical({query:'115200',versionId:v1.id})[0]!.snapshotId).toBe(first.id);
  expect(rawText(first.id,'spec.md')).toBe(original);
});

test('unchanged sync reuses parsed content and embeddings; only changed content is recomputed',async()=>{
  write('one.md','UART_CAP first implementation.');write('two.md','CLOCK_CAP 48 MHz.');
  const firstJob=await sync(),first=current();expect(firstJob.status).toBe('completed');
  expect(count('kb_parsed')).toBe(2);expect(embeds).toHaveLength(2);
  const originalChunks=kb.vectorChunks(first.id).map(c=>c.id);freeze('v1');
  const unchanged=await sync();expect(unchanged.status).toBe('completed');
  expect(current().id).toBe(first.id);expect(count('kb_parsed')).toBe(2);expect(embeds).toHaveLength(2);
  write('one.md','UART_CAP second implementation.');const changed=await sync();expect(changed.status).toBe('completed');
  expect(count('kb_parsed')).toBe(3);expect(embeds).toHaveLength(3);
  const oldFiles=kb.snapshotFiles(first.id),newFiles=kb.snapshotFiles(current().id);
  expect(oldFiles.find(f=>f.path==='two.md')!.parsedKey).toBe(newFiles.find(f=>f.path==='two.md')!.parsedKey);
  expect(oldFiles.find(f=>f.path==='one.md')!.parsedKey).not.toBe(newFiles.find(f=>f.path==='one.md')!.parsedKey);
  expect(upserts.flatMap(body=>body.points||[]).every(point=>Array.isArray(point.payload.snapshotIds)&&Array.isArray(point.payload.projectId))).toBe(true);
  expect(kb.vectorChunks(current().id).some(c=>originalChunks.includes(c.id))).toBe(true);
});

test('module rules and roles scope each occurrence and preserve confirmed version metadata',async()=>{
  kb.saveConnection(owner.id,{role:'reference'});
  const module=kb.addModule('default',{name:'UART',rules:[{sourceId:owner.id,pattern:'docs/uart/**',role:'spec'},{sourceId:owner.id,pattern:'src/uart/**',role:'code'}]});
  write('docs/uart/spec.md','UART_CAP specification.');write('src/uart/code.ts','export const UART_CAP = true;');write('notes.md','UART_CAP background reference.');
  await sync();const v1=freeze('v1');
  expect(kb.lexical({query:'UART_CAP',moduleId:module.id,role:'spec'}).map(h=>h.path)).toEqual(['docs/uart/spec.md']);
  expect(kb.lexical({query:'UART_CAP',moduleId:module.id,role:'code'}).map(h=>h.path)).toEqual(['src/uart/code.ts']);
  expect(kb.lexical({query:'UART_CAP',role:'reference'}).map(h=>h.path)).toEqual(['notes.md']);
  kb.saveConnection(owner.id,{role:'spec'});await sync();
  expect(kb.lexical({query:'UART_CAP',role:'spec'}).map(h=>h.path).sort()).toEqual(['docs/uart/spec.md','notes.md']);
  expect(kb.lexical({query:'UART_CAP',versionId:v1.id,role:'reference'}).map(h=>h.path)).toEqual(['notes.md']);
});

test('new module rules apply without changing raw content and do not rewrite earlier versions',async()=>{
  write('drivers/uart.md','UART_CAP specification.');await sync();const v1=freeze('v1');const previous=current().id;
  const module=kb.addModule('default',{name:'UART',rules:[{pattern:'drivers/**',role:'spec'}]});
  await sync();expect(current().id).not.toBe(previous);
  expect(kb.lexical({query:'UART_CAP',moduleId:module.id})).toHaveLength(1);
  expect(kb.lexical({query:'UART_CAP',versionId:v1.id,moduleId:module.id})).toHaveLength(0);
  expect(embeds).toHaveLength(1);
});

test('projection errors roll back the legacy projection and never activate a partly applied snapshot',async()=>{
  write('a.md','UART_OLD one.');write('b.md','UART_OLD two.');await sync();const original=current(),v1=freeze('v1');
  const initialIds=store.documents(owner.id).map(d=>d.id),replace=store.replaceDocument.bind(store);let calls=0;
  store.replaceDocument=((doc,chunks)=>{replace(doc,chunks);if(++calls===2)throw new Error('injected projection failure');}) as typeof store.replaceDocument;
  write('a.md','UART_NEW one.');write('b.md','UART_NEW two.');
  const failure=await sync();store.replaceDocument=replace;
  expect(failure.status).toBe('failed');expect(current().id).toBe(original.id);
  expect(store.documents(owner.id).map(d=>d.id)).toEqual(initialIds);
  expect(store.lexical({query:'UART_OLD'})).toHaveLength(2);expect(store.lexical({query:'UART_NEW'})).toHaveLength(0);
  expect(kb.lexical({query:'UART_OLD'})).toHaveLength(0);
  expect(kb.lexical({query:'UART_OLD',versionId:v1.id})).toHaveLength(2);
  expect(kb.scopeInfo({query:'UART_OLD'}).warnings.join(' ')).toContain('injected projection failure');
  expect((await sync()).status).toBe('completed');expect(kb.lexical({query:'UART_NEW'})).toHaveLength(2);
});

test('unreadable current sources cannot serve stale latest answers but preserve confirmed snapshots',async()=>{
  write('spec.md','UART_CAP current specification.');await sync();const v1=freeze('v1'),pinned=current().id;
  rmSync(owner.path,{recursive:true,force:true});const failure=await sync();
  expect(failure.status).toBe('failed');expect(kb.lexical({query:'UART_CAP'})).toHaveLength(0);
  expect(kb.currentBindings('default')).toEqual({});
  expect(kb.lexical({query:'UART_CAP',versionId:v1.id})[0]!.snapshotId).toBe(pinned);
  expect(kb.raw(kb.snapshotFiles(pinned)[0]!.rawHash).length).toBeGreaterThan(0);
});

test('parse failures remove invalid latest content and block freezing while older versions remain readable',async()=>{
  write('a.md','UART_CAP known text.');await sync();const v1=freeze('v1');
  write('a.md',new Uint8Array([0xff,0x00,0x81]));const result=await sync();
  expect(result.status).toBe('completed');expect(result.errors.length).toBeGreaterThan(0);
  expect(current().complete).toBe(false);expect(kb.lexical({query:'UART_CAP'})).toHaveLength(0);
  expect(kb.lexical({query:'UART_CAP',versionId:v1.id})).toHaveLength(1);
  expect(()=>freeze('v2')).toThrow();expect(kb.versions('default')).toHaveLength(1);
});

test('retention protects snapshots pinned by versions and candidates and cleans only unreferenced contents',()=>{
  const snapshots:Snapshot[]=[];
  for(let i=0;i<42;i++) {
    const text=`UART_CAP snapshot ${i}`,parsed=kb.putParsed(new TextEncoder().encode(text),{title:'spec.md',text,warnings:[],chunks:[{text,startLine:1,endLine:1}]},'retention','spec.md');
    const snapshot=kb.createSnapshot(owner,[{path:'spec.md',...parsed}],{errors:[],excluded:[]});snapshots.push(snapshot);
    if(i===0)freeze('pinned',snapshot.id);
    if(i===1)kb.saveCandidate({id:'candidate',projectId:'default',sourceId:owner.id,name:'pending',commit:'a'.repeat(40),createdAt:new Date().toISOString(),status:'pending',snapshots:{source:snapshot.id},warnings:[],automatic:true});
    kb.activate(owner.id,snapshot.id);
  }
  expect(kb.snapshot(snapshots[0]!.id)).not.toBeNull();expect(kb.snapshot(snapshots[1]!.id)).not.toBeNull();
  expect(rawText(snapshots[0]!.id,'spec.md')).toBe('UART_CAP snapshot 0');expect(rawText(snapshots[1]!.id,'spec.md')).toBe('UART_CAP snapshot 1');
  expect(kb.snapshot(snapshots[2]!.id)).toBeNull();
  expect(current().id).toBe(snapshots.at(-1)!.id);
  const protectedIds=[...kb.vectorChunks(snapshots[0]!.id),...kb.vectorChunks(snapshots[1]!.id)].map(c=>c.id);
  expect(store.pendingDeletes().every(p=>!protectedIds.includes(p.id))).toBe(true);
  expect(count('kb_parsed')).toBe(32);
});

test('snapshot and parsed-content transactions cannot leave partially inserted searchable rows',()=>{
  const text='UART_CAP retained',parsed=kb.putParsed(new TextEncoder().encode(text),{title:'s.md',text,warnings:[],chunks:[{text,startLine:1,endLine:1}]},'atomic');
  const before=count('kb_snapshots');
  expect(()=>kb.createSnapshot(owner,[{path:'duplicate.md',...parsed},{path:'duplicate.md',...parsed}],{errors:[],excluded:[]})).toThrow();
  expect(count('kb_snapshots')).toBe(before);expect(count('kb_files')).toBe(0);
  const parsedBefore=count('kb_parsed'),chunksBefore=count('kb_chunks'),ftsBefore=count('kb_fts');
  expect(()=>kb.putParsed(new TextEncoder().encode('UART_BROKEN'),{title:'bad.md',text:'UART_BROKEN',warnings:[],chunks:[{text:'UART_BROKEN',startLine:1,endLine:1},{text:null as any}]},'atomic')).toThrow();
  expect(count('kb_parsed')).toBe(parsedBefore);expect(count('kb_chunks')).toBe(chunksBefore);expect(count('kb_fts')).toBe(ftsBefore);
});

test('version creation binds the explicitly selected snapshot even after latest content changes',async()=>{
  write('s.md','UART_CAP first.');await sync();const selected=current().id;
  write('s.md','UART_CAP second.');await sync();expect(current().id).not.toBe(selected);
  const result=await done(indexer.enqueueVersion({projectId:'default',name:'selected',snapshots:{source:selected}}));
  expect(result.status).toBe('completed');const frozen=kb.version(result.versionId!)!;
  expect(frozen.snapshots.source).toBe(selected);expect(kb.lexical({query:'first',versionId:frozen.id})).toHaveLength(1);
  expect(kb.lexical({query:'second',versionId:frozen.id})).toHaveLength(0);
});

test('frozen reindex retains original bytes, retires superseded aliases and cleans disconnected unpinned data',async()=>{
  const original='UART_FROZEN 115200\r\n';write('s.md',original);await sync();const snapshot=current(),v1=freeze('v1');
  rmSync(owner.path,{recursive:true,force:true});
  const reprocessed=await done(indexer.enqueueVersionReindex(v1.id));expect(reprocessed.status).toBe('completed');
  const firstDerived=kb.indexedSnapshot(snapshot.id);expect(firstDerived).not.toBe(snapshot.id);
  expect(rawText(snapshot.id,'s.md')).toBe(original);expect(rawText(firstDerived,'s.md')).toBe(original);
  for(let i=0;i<34;i++) {
    const derived=kb.createSnapshot(owner,kb.snapshotFiles(snapshot.id),{errors:[],excluded:[],derivedFrom:snapshot.id});
    kb.setIndexOverrides({[snapshot.id]:derived.id});
  }
  expect(count('kb_snapshots')).toBeLessThanOrEqual(31);expect(kb.snapshot(firstDerived)).toBeNull();
  const latest=kb.indexedSnapshot(snapshot.id);expect(kb.lexical({query:'UART_FROZEN',versionId:v1.id})[0]!.snapshotId).toBe(latest);
  kb.removeConnection(owner.id);store.removeSource(owner.id);
  expect(count('kb_snapshots')).toBe(2);expect(count('kb_snapshot_indexes')).toBe(1);
  expect(rawText(snapshot.id,'s.md')).toBe(original);expect(rawText(latest,'s.md')).toBe(original);
  const originalHash=kb.snapshotFiles(snapshot.id)[0]!.rawHash;
  kb.deleteVersion(v1.id);
  expect(count('kb_snapshots')).toBe(0);expect(count('kb_snapshot_indexes')).toBe(0);expect(count('kb_parsed')).toBe(0);
  expect(()=>kb.raw(originalHash)).toThrow();expect(count('kb_blob_deletes')).toBe(0);
  expect(count('kb_embeddings')).toBeGreaterThan(0); // Reusable model cache has a separate retention policy.
});

test('reindex aliases reject replacements with different original content',async()=>{
  write('s.md','UART_ORIGINAL immutable.');await sync();const snapshot=current(),v1=freeze('v1');
  const text='UART_REPLACED wrong bytes',saved=kb.putParsed(new TextEncoder().encode(text),{title:'s.md',text,warnings:[],chunks:[{text,startLine:1,endLine:1}]},'replacement');
  const bad=kb.createSnapshot(owner,[{path:'s.md',...saved}],{errors:[],excluded:[],derivedFrom:snapshot.id});
  expect(()=>kb.setIndexOverrides({[snapshot.id]:bad.id})).toThrow();
  expect(kb.indexedSnapshot(snapshot.id)).toBe(snapshot.id);expect(kb.lexical({query:'UART_ORIGINAL',versionId:v1.id})).toHaveLength(1);
});

test('raw deletion waits for the outer SQLite commit and is rolled back with metadata',()=>{
  const bytes=new TextEncoder().encode('UART_ORPHAN original bytes');
  const saved=kb.putParsed(bytes,{title:'orphan.md',text:'UART_ORPHAN original bytes',warnings:[],chunks:[{text:'UART_ORPHAN original bytes'}]},'rollback-gc');
  expect(()=>store.db.transaction(()=>{kb.prune(owner.id);expect(new TextDecoder().decode(kb.raw(saved.rawHash))).toBe('UART_ORPHAN original bytes');throw new Error('rollback after prune');})()).toThrow('rollback after prune');
  expect(kb.parsed(saved.parsedKey)).not.toBeNull();expect(kb.raw(saved.rawHash)).toEqual(bytes);
  kb.prune(owner.id);expect(kb.parsed(saved.parsedKey)).toBeNull();expect(()=>kb.raw(saved.rawHash)).toThrow();
});

test('pruning another source preserves in-flight parsed content until its indexing work completes',()=>{
  store.saveJob({id:'other-work',sourceId:'other-source',status:'running',processed:0,total:1,message:'parsing',errors:[],createdAt:new Date().toISOString()});
  const text='UART_STAGED pending snapshot',saved=kb.putParsed(new TextEncoder().encode(text),{title:'staged.md',text,warnings:[],chunks:[{text}]},'staging');
  kb.prune(owner.id);expect(kb.parsed(saved.parsedKey)).not.toBeNull();expect(new TextDecoder().decode(kb.raw(saved.rawHash))).toBe(text);
  const job=store.jobs().find(j=>j.id==='other-work')!;store.saveJob({...job,status:'completed'});kb.prune(owner.id);
  expect(kb.parsed(saved.parsedKey)).toBeNull();expect(()=>kb.raw(saved.rawHash)).toThrow();
});

test('queued version creation pins its selected snapshots beyond rolling history retention',()=>{
  let pinned:string|undefined;
  for(let i=0;i<35;i++) {
    const text=`UART_QUEUE ${i}`,saved=kb.putParsed(new TextEncoder().encode(text),{title:'s.md',text,warnings:[],chunks:[{text}]},'queued-pin');
    const snapshot=kb.createSnapshot(owner,[{path:'s.md',...saved}],{errors:[],excluded:[]});
    if(i===0){pinned=snapshot.id;store.db.query('INSERT INTO kb_version_jobs VALUES(?,?)').run('version-pending',JSON.stringify({id:'version-pending',sourceId:owner.id,status:'queued',request:{snapshots:{source:pinned}}}));}
    kb.activate(owner.id,snapshot.id);
  }
  expect(kb.snapshot(pinned!)).not.toBeNull();expect(rawText(pinned!,'s.md')).toBe('UART_QUEUE 0');
  store.db.query("UPDATE kb_version_jobs SET data=json_set(data,'$.status','completed') WHERE id='version-pending'").run();kb.prune(owner.id);
  expect(kb.snapshot(pinned!)).toBeNull();
});

test('editing an earlier module preserves its rule precedence over later overlapping modules',()=>{
  const first=kb.addModule('default',{name:'first',rules:[{pattern:'docs/**',role:'spec'}]});
  const second=kb.addModule('default',{name:'second',rules:[{pattern:'docs/**',role:'reference'}]});
  expect(kb.mapFile(owner,'docs/spec.md').moduleId).toBe(first.id);
  kb.addModule('default',{name:'first edited',rules:[{pattern:'docs/**',role:'code'}]},first.id);
  expect(kb.modules('default').map(m=>m.id)).toEqual([first.id,second.id]);
  expect(kb.mapFile(owner,'docs/spec.md')).toEqual({moduleId:first.id,role:'code'});
});
