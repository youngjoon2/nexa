import {afterEach,beforeEach,test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApplication} from '../src/app';
import {loadConfig} from '../src/config';
import {AppError,type Job} from '../src/types';

let directory:string,runtime:ReturnType<typeof createApplication>,admin:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'nexa-http-knowledge-'));admin=crypto.randomUUID();runtime=createApplication(loadConfig({NEXA_DATA_DIR:join(directory,'data'),NEXA_MODE:'keyword',NEXA_ADMIN_KEY:admin,NEXA_SYNC_INTERVAL_MS:'1000',NEXA_DEBOUNCE_MS:'30'},resolve(import.meta.dir,'..')),{resume:false});});
async function idle(){const deadline=Date.now()+15000;while(runtime.indexer.state().running||runtime.indexer.state().queued||runtime.analyses.state().running||runtime.analyses.state().queued){if(Date.now()>deadline)throw new Error('Worker deadline');await Bun.sleep(10);}await Bun.sleep(15);}
afterEach(async()=>{runtime.indexer.stop();runtime.analyses.stop();await idle();runtime.store.close();await rm(directory,{recursive:true,force:true});});
async function req(path:string,body?:any,method=body===undefined?'GET':'POST',key=admin){const response=await runtime.app.request('/api/v1'+path,{method,headers:{'content-type':'application/json','x-nexa-admin-key':key},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};}
async function setup(){const project=(await req('/projects',{name:'네트워크 제품'})).body.project;const folder=join(directory,'specs');await mkdir(folder);await writeFile(join(folder,'uart.md'),'# UART\n통신 속도는 115200 baud입니다.\n자동복구 기능은 지원하지 않습니다.\n');const registered=await req('/sources/folder',{projectId:project.id,path:folder,name:'사양서',role:'spec'});expect(registered.status).toBe(201);await idle();return {project,folder,source:registered.body.source};}
async function freeze(projectId:string,name:string,sourceId:string){const response=await req('/projects/'+projectId+'/versions',{name,sourceIds:[sourceId],snapshots:{}});expect(response.status).toBe(202);await idle();const job=runtime.indexer.jobs().find(j=>j.id===response.body.job.id)!;expect(job.status).toBe('completed');return runtime.knowledge.version(job.versionId!)!;}

test('project/module/source management requires admin while query and analysis remain shared reads',async()=>{expect((await req('/projects',{name:'forbidden'},'POST','')).status).toBe(403);const {project,source}=await setup();expect((await req('/projects/'+project.id+'/modules',{name:'UART',rules:[{sourceId:source.id,pattern:'*.md',role:'spec'}]})).status).toBe(201);await idle();const preview=await req('/sources/'+source.id+'/preview');expect(preview.body.total).toBe(1);expect(preview.body.documents[0].moduleId).toBeTruthy();expect((await req('/sources/'+source.id+'/settings',{paused:true},'POST','')).status).toBe(403);expect((await req('/sources/'+source.id+'/settings',{paused:true})).body.source.paused).toBe(true);expect((await req('/sources/git',{url:'https://secret:token@github.com/org/repo',projectId:project.id})).status).toBe(400);expect(runtime.store.counts().sources).toBe(1);});

test('HTTP version comparison uses preserved documents and reindex survives original source deletion',async()=>{const {project,folder,source}=await setup();const a=await freeze(project.id,'A',source.id);await writeFile(join(folder,'uart.md'),'# UART\n통신 속도는 921600 baud입니다.\n자동복구 기능을 지원합니다.\n');await req('/sources/'+source.id+'/sync',{});await idle();const b=await freeze(project.id,'B',source.id);const search=await req('/search',{query:'115200',projectId:project.id,versionId:a.id});expect(search.body.hits[0].text).toContain('115200');const citation=search.body.hits[0];expect((await req('/documents/'+citation.documentId)).body.text).toContain('115200');const response=await req('/query',{query:'A에서 B로 UART 사양 변경점은?',projectId:project.id,mode:'compare',versionIds:[a.id,b.id]});expect(response.status).toBe(202);await idle();const job=(await req('/analyses/'+response.body.job.id)).body.job;expect(job.status).toBe('completed');expect(job.result.documents[0].hunks[0].removed.join('\n')).toContain('115200');expect(job.result.documents[0].hunks[0].added.join('\n')).toContain('921600');await req('/sources/'+source.id,undefined,'DELETE');expect((await req('/documents/'+citation.documentId)).status).toBe(200);const rebuilt=await req('/versions/'+a.id+'/reindex',{});expect(rebuilt.status).toBe(202);await idle();expect(runtime.indexer.jobs().find(j=>j.id===rebuilt.body.job.id)?.status).toBe('completed');expect(runtime.knowledge.version(a.id)?.snapshots).toEqual(a.snapshots);expect((await req('/search',{query:'115200',projectId:project.id,versionId:a.id})).body.hits[0].text).toContain('115200');});

test('feature API emits every selected version and does not call missing evidence absent',async()=>{const {project,source}=await setup();await freeze(project.id,'A',source.id);await freeze(project.id,'B',source.id);const result=await req('/query',{projectId:project.id,query:'자동복구 기능이 들어간 SW 버전이 어디야?',mode:'auto'});expect(result.body.type).toBe('analysis');await idle();const job=(await req('/analyses/'+result.body.job.id)).body.job;expect(job.result.rows).toHaveLength(2);expect(job.result.rows.every((r:any)=>r.state==='unknown')).toBe(true);expect((await req('/query',{projectId:project.id,query:'A와 없는 버전 비교',mode:'compare'})).body.type).toBe('clarification');});

test('version deletion waits for queued or running reindex work to finish',async()=>{
  const {project,source}=await setup();const version=await freeze(project.id,'A',source.id);
  let release!:()=>void,started!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const embed=runtime.indexer.embedSnapshot.bind(runtime.indexer);
  runtime.indexer.embedSnapshot=async(...args)=>{started();await blocked;return embed(...args);};
  try {
    const job=runtime.indexer.enqueueVersionReindex(version.id);
    expect((await req('/versions/'+version.id,undefined,'DELETE')).status).toBe(409);
    await entered;
    expect((await req('/versions/'+version.id,undefined,'DELETE')).status).toBe(409);
    expect(runtime.knowledge.version(version.id)).not.toBeNull();
    release();await idle();
    expect(runtime.indexer.jobs().find(item=>item.id===job.id)?.status).toBe('completed');
    expect((await req('/versions/'+version.id,undefined,'DELETE')).status).toBe(200);
  } finally {release();runtime.indexer.embedSnapshot=embed;await idle();}
});

test('malformed module rules return a validation error without creating a module',async()=>{
  const {project}=await setup();
  for(const rule of [null,[],false,42,'*.md'])expect((await req('/projects/'+project.id+'/modules',{name:'invalid',rules:[rule]})).status).toBe(400);
  expect(runtime.knowledge.modules(project.id)).toHaveLength(0);
});

test('failed Git source enqueue rolls back registration and allows retry',async()=>{
  const enqueue=runtime.indexer.enqueue;
  runtime.indexer.enqueue=()=>{throw new AppError('INDEX_QUEUE_FULL','Queue filled during Git registration.',429);};
  try {
    for(let attempt=0;attempt<2;attempt++){
      const response=await req('/sources/git',{url:'https://github.com/example/firmware',name:' Firmware '});
      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe('INDEX_QUEUE_FULL');
      expect(runtime.store.counts().sources).toBe(0);
      expect(runtime.store.jobs()).toEqual([]);
      expect(runtime.store.db.query('SELECT sourceId FROM kb_connections').all()).toEqual([]);
    }
  } finally {runtime.indexer.enqueue=enqueue;}
});

test('Git source names trim optional input and use the repository name when blank',async()=>{
  const enqueue=runtime.indexer.enqueue;
  runtime.indexer.enqueue=sourceId=>{
    const job:Job={id:crypto.randomUUID(),sourceId,status:'queued',processed:0,total:0,message:'queued',errors:[],createdAt:new Date().toISOString()};
    runtime.store.saveJob(job);return job;
  };
  try {
    for(const [repository,name,expected] of [['default-name',undefined,'default-name'],['blank-name','   ','blank-name'],['custom-name','  Firmware  ','Firmware']]){
      const response=await req('/sources/git',{url:`https://github.com/example/${repository}`,name});
      expect(response.status).toBe(201);
      expect(response.body.source.name).toBe(expected);
      expect(runtime.store.source(response.body.source.id)?.name).toBe(expected);
      expect(runtime.store.jobs().some(job=>job.id===response.body.job.id)).toBe(true);
    }
  } finally {runtime.indexer.enqueue=enqueue;}
});

test('automatic folder reconciliation reflects changes and pause prevents automatic queueing',async()=>{const {project,folder,source}=await setup();runtime.indexer.resume();await idle();await writeFile(join(folder,'uart.md'),'# UART\nAUTO_CHANGED_REGISTER is enabled.\n');const deadline=Date.now()+5000;while(!runtime.knowledge.lexical({query:'AUTO_CHANGED_REGISTER',projectId:project.id}).length){if(Date.now()>deadline)throw new Error('Automatic sync not observed');await Bun.sleep(50);}expect(runtime.store.counts().sources).toBe(1);await idle();await req('/sources/'+source.id+'/settings',{paused:true});await writeFile(join(folder,'uart.md'),'# UART\nPAUSED_REGISTER\n');runtime.indexer.reconcile();await Bun.sleep(100);await idle();expect(runtime.knowledge.lexical({query:'PAUSED_REGISTER',projectId:project.id})).toHaveLength(0);await req('/sources/'+source.id+'/settings',{paused:false});await idle();expect(runtime.knowledge.lexical({query:'PAUSED_REGISTER',projectId:project.id})).toHaveLength(1);});
