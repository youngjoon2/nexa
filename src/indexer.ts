import {watch,type FSWatcher} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,basename} from 'node:path';
import {discoverFiles,parseDocumentBytes,PARSER_PROFILE} from './ingestion';
import {readGitSource} from './connectors';
import {Store} from './storage';
import {Providers} from './providers';
import {KnowledgeBase,contentId,hashOf,type SnapshotFile,type Snapshot} from './knowledge';
import {AppError,type Job,type Source,type Chunk,type Document} from './types';
import type {Config} from './config';

export function inside(root:string,path:string){const rel=relative(resolve(root),resolve(path));return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../'));}
export function stableId(input:string){return contentId(input);}
const now=()=>new Date().toISOString();
type VersionRequest={projectId:string;name:string;candidateId?:string;sourceIds?:string[];snapshots?:Record<string,string>;parentVersionId?:string;notes?:string;reindexVersionId?:string};
type Work=Job&{request?:VersionRequest};

export class Indexer {
  private pending:Work[]=[];
  private active:Work|null=null;
  private stopped=false;
  private dirty=new Set<string>();
  private watchers=new Map<string,FSWatcher>();
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  private interval?:ReturnType<typeof setInterval>;
  readonly knowledge:KnowledgeBase;
  constructor(readonly store:Store,readonly providers:Providers,readonly config:Config,knowledge?:KnowledgeBase){this.knowledge=knowledge||new KnowledgeBase(store,config);}
  resume(){
    for(const job of this.store.pendingJobs())if(this.store.source(job.sourceId)){job.status='queued';job.processed=0;job.errors=[];this.pending.push(job);}
    for(const r of this.store.db.query('SELECT data FROM kb_version_jobs').all() as any[]){const j=JSON.parse(r.data);if(['queued','running'].includes(j.status)){j.status='queued';this.pending.push(j);}}
    this.interval=setInterval(()=>this.reconcile(),this.config.syncIntervalMs);this.interval.unref();
    this.reconcile();void this.pump();
  }
  stop(){this.stopped=true;if(this.interval)clearInterval(this.interval);for(const w of this.watchers.values())w.close();this.watchers.clear();for(const t of this.timers.values())clearTimeout(t);this.timers.clear();}
  state(){return {queued:this.pending.length,running:this.active?1:0};}
  busy(sourceId:string){return this.active?.sourceId===sourceId||this.pending.some(j=>j.sourceId===sourceId);}
  private save(job:Work){if(job.kind==='version')this.store.db.query('INSERT OR REPLACE INTO kb_version_jobs VALUES(?,?)').run(job.id,JSON.stringify(job));else this.store.saveJob(job);}
  jobs(){return [...this.store.jobs(),...this.store.db.query('SELECT data FROM kb_version_jobs ORDER BY rowid DESC LIMIT 100').all().map((r:any)=>JSON.parse(r.data))].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  enqueue(sourceId:string):Job {
    if(this.stopped)throw new AppError('STOPPING','서버가 종료 중입니다.',503);
    if(!this.store.source(sourceId))throw new AppError('NOT_FOUND','자료를 찾을 수 없습니다.',404);
    if(this.busy(sourceId))throw new AppError('SOURCE_BUSY','이 자료는 이미 처리 중입니다.',409);
    if(this.pending.length>=100)throw new AppError('INDEX_QUEUE_FULL','색인 대기열이 가득 찼습니다.',429);
    const job:Work={id:crypto.randomUUID(),sourceId,kind:'index',projectId:this.knowledge.connection(sourceId).projectId,status:'queued',processed:0,total:0,message:'변경 확인 대기 중',errors:[],createdAt:now()};
    this.save(job);this.store.updateSource(sourceId,'queued');this.pending.push(job);if(this.interval)this.watchSource(this.knowledge.source(sourceId)!);setTimeout(()=>void this.pump(),0);return {...job};
  }
  enqueueVersion(request:VersionRequest):Job {
    this.knowledge.requireProject(request.projectId);
    if(typeof request.name!=='string'||!request.name.trim()||request.name.length>120)throw new AppError('INVALID_VERSION','SW 버전 이름을 입력하세요.');
    if(this.knowledge.versions(request.projectId).some(v=>v.name===request.name.trim()))throw new AppError('DUPLICATE_VERSION','같은 SW 버전이 있습니다.',409);
    const candidate=request.candidateId?this.knowledge.candidate(request.candidateId):null;
    if(request.candidateId&&(!candidate||candidate.projectId!==request.projectId||candidate.status!=='pending'))throw new AppError('INVALID_CANDIDATE','버전 후보를 확인하세요.');
    const sourceId=candidate?.sourceId||request.sourceIds?.[0]||this.knowledge.sources().find(s=>s.projectId===request.projectId)?.id;
    if(!sourceId)throw new AppError('EMPTY_VERSION','자료를 먼저 연결하세요.');
    if(!candidate){
      const requestedIds=request.sourceIds||(request.snapshots?Object.keys(request.snapshots):undefined);
      const selected=this.knowledge.sources().filter(s=>s.projectId===request.projectId&&(!requestedIds||requestedIds.includes(s.id)));
      if(!selected.length||request.sourceIds?.some(id=>!selected.some(s=>s.id===id)))throw new AppError('INVALID_SOURCES','프로젝트의 자료를 선택하세요.');
      const bindings={...this.knowledge.currentBindings(request.projectId),...request.snapshots};
      if(selected.some(s=>!bindings[s.id]))throw new AppError('INCOMPLETE_VERSION','선택한 자료의 동기화가 완료되지 않았습니다.',409);
      request={...request,snapshots:Object.fromEntries(selected.map(s=>[s.id,bindings[s.id]!]))};
    }
    if(this.pending.length>=100)throw new AppError('INDEX_QUEUE_FULL','색인 대기열이 가득 찼습니다.',429);
    const job:Work={id:crypto.randomUUID(),sourceId,projectId:request.projectId,kind:'version',status:'queued',processed:0,total:0,message:'버전 자료 보존 대기 중',errors:[],createdAt:now(),request};
    this.save(job);this.pending.push(job);setTimeout(()=>void this.pump(),0);return {...job,request:undefined} as Job;
  }
  enqueueVersionReindex(id:string):Job {
    const version=this.knowledge.version(id);if(!version)throw new AppError('NOT_FOUND','버전을 찾을 수 없습니다.',404);
    if(this.pending.length>=100)throw new AppError('INDEX_QUEUE_FULL','색인 대기열이 가득 찼습니다.',429);
    const job:Work={id:crypto.randomUUID(),sourceId:Object.keys(version.snapshots)[0]!,projectId:version.projectId,kind:'version',status:'queued',processed:0,total:0,message:'보존 원문으로 색인 재구축 대기 중',errors:[],createdAt:now(),request:{projectId:version.projectId,name:version.name,reindexVersionId:id}};
    this.save(job);this.pending.push(job);setTimeout(()=>void this.pump(),0);return {...job,request:undefined} as Job;
  }
  requestAuto(sourceId:string){
    const source=this.store.source(sourceId);if(!source||this.stopped||this.knowledge.connection(sourceId).paused)return;
    if(this.busy(sourceId)){this.dirty.add(sourceId);return;}
    try{this.enqueue(sourceId);}catch{/* Next reconciliation retries bounded queue overflow. */}
  }
  private watchSource(source:Source){
    if(source.kind!=='folder'||source.paused||this.watchers.has(source.id))return;
    try{const watcher=watch(source.path,{recursive:true},()=>{const previous=this.timers.get(source.id);if(previous)clearTimeout(previous);const t=setTimeout(()=>{this.timers.delete(source.id);this.requestAuto(source.id);},this.config.debounceMs);t.unref();this.timers.set(source.id,t);});watcher.on('error',()=>{watcher.close();this.watchers.delete(source.id);});watcher.unref();this.watchers.set(source.id,watcher);}catch{/* Reconciliation handles unsupported watchers and disconnected paths. */}
  }
  reconcile(){
    if(this.stopped)return;
    const current=this.knowledge.sources();
    for(const [id,w] of this.watchers)if(!current.some(s=>s.id===id&&!s.paused)){w.close();this.watchers.delete(id);}
    for(const source of current){
      if(source.paused)continue;
      this.watchSource(source);
      if(source.kind!=='upload'||!source.snapshotId)this.requestAuto(source.id);
    }
  }
  async flushDeletes(){try{for(let n=0;n<20;n++){const ids=this.store.pendingDeletes().map(x=>x.id);if(!ids.length)break;await this.providers.deletePoints(ids);this.store.acknowledgeDeletes(ids);}}catch{}}
  private async pump(){
    if(this.active||this.stopped)return;const job=this.pending.shift();if(!job)return;
    this.active=job;job.status='running';this.save(job);
    if(job.kind!=='version')this.store.updateSource(job.sourceId,'indexing');
    try{if(job.kind==='version')await this.runVersion(job);else {const source=this.store.source(job.sourceId);if(!source)throw new AppError('NOT_FOUND','자료 연결이 삭제되었습니다.',404);await this.build(source,job);}}
    catch(error:any){job.status='failed';job.message=error.message||'자료 처리 실패';job.errors.push(job.message);if(job.kind!=='version'){this.knowledge.recordFailure(job.sourceId,job.errors);this.store.updateSource(job.sourceId,'error',job.message);}}
    finally{job.finishedAt=now();this.save(job);this.active=null;if(this.dirty.delete(job.sourceId))this.requestAuto(job.sourceId);if(!this.stopped)setTimeout(()=>void this.pump(),0);}
  }
  private async build(source:Source,job:Work,commit?:string,activate=true):Promise<Snapshot> {
    const settings=this.knowledge.connection(source.id);const previous=settings.snapshotId?this.knowledge.snapshot(settings.snapshotId):null;
    const previousFiles=previous?this.knowledge.snapshotFiles(previous.id):[];const errors:string[]=[],excluded:string[]=[];
    let inputs:Array<{path:string;bytes?:Uint8Array;absolute?:string}>;let gitCommit:string|undefined;let tags:{name:string;commit:string}[]=[];
    if(source.kind==='git'){
      if(!settings.git)throw new Error('Git 연결 설정이 없습니다.');
      const git=await readGitSource(settings.git,{dataDir:this.config.dataDir,sourceId:source.id,gitPath:this.config.gitPath,maxFileBytes:this.config.maxFileBytes,maxFiles:this.config.maxFiles,commit});
      inputs=git.files;gitCommit=git.commit;tags=git.tags;errors.push(...git.warnings);
    }else{
      const found=await discoverFiles(source.path,{maxFiles:this.config.maxFiles});errors.push(...found.warnings);
      const protectedRoots=[this.config.dataDir,resolve(this.config.root,'.runtime'),resolve(this.config.root,'.models'),resolve(this.config.root,'vendor')];
      inputs=found.files.filter(p=>!basename(p).startsWith('~$')&&(source.kind==='upload'||!protectedRoots.some(root=>inside(root,p)))).map(absolute=>({absolute,path:relative(source.path,absolute).replaceAll('\\','/')}));
    }
    job.total=inputs.length;this.save(job);const files:SnapshotFile[]=[];let changed=0,reused=0;
    const previousByPath=new Map(previousFiles.map(f=>[f.path,f]));
    const previousByHash=new Map<string,typeof previousFiles>();for(const f of previousFiles){const list=previousByHash.get(f.rawHash)||[];list.push(f);previousByHash.set(f.rawHash,list);}
    for(const input of inputs){
      if(this.stopped)throw new Error('서버 종료로 중단되었습니다. 재시작 후 자동 복구합니다.');
      try{
        let bytes=input.bytes;
        if(!bytes){const stat=await lstat(input.absolute!);if(stat.isSymbolicLink()||!inside(await realpath(source.path),await realpath(input.absolute!)))throw new Error('연결 경로 밖 파일입니다.');if(stat.size>this.config.maxFileBytes)throw new Error('파일당 20 MiB 제한을 초과했습니다.');bytes=new Uint8Array(await Bun.file(input.absolute!).arrayBuffer());const after=await lstat(input.absolute!);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error('저장 중인 파일입니다. 다음 동기화에서 재시도합니다.');}
        if(bytes.length>this.config.maxFileBytes)throw new Error('파일 크기 제한 초과');
        const rawHash=hashOf(bytes);let key=this.knowledge.parsedKey(rawHash,PARSER_PROFILE,basename(input.path));
        let parsed=this.knowledge.parsed(key);
        if(parsed)reused++;else{parsed=await parseDocumentBytes(input.path,bytes,this.config);const profile=parsed.warnings.length?PARSER_PROFILE+':warning:'+hashOf(JSON.stringify(parsed.warnings)):PARSER_PROFILE;key=this.knowledge.putParsed(bytes,parsed,profile,basename(input.path)).parsedKey;changed++;}
        for(const warning of parsed.warnings)errors.push(input.path+': '+warning);
        const existing=previousByPath.get(input.path),renamed=previousByHash.get(rawHash)||[];
        files.push({path:input.path,parsedKey:key,rawHash,logicalKey:settings.documentLinks?.[input.path]?source.id+':'+settings.documentLinks[input.path]:existing?.logicalKey||(renamed.length===1?renamed[0]!.logicalKey:undefined)});
      }catch(error:any){errors.push(input.path+': '+(error.message||'파일 처리 실패'));}
      job.processed++;job.message=`${job.processed}/${job.total} · 변경 ${changed} · 재사용 ${reused}`;this.save(job);
    }
    if(errors.some(e=>/Could not read directory|discovery stopped|Could not inspect/.test(e))){const seen=new Set(inputs.map(x=>x.path));for(const f of previousFiles)if(!seen.has(f.path))files.push(f);}
    const signature=(fs:SnapshotFile[],existing=false)=>JSON.stringify(fs.map(f=>[f.path,f.parsedKey,f.logicalKey||source.id+':'+f.path,existing?{moduleId:f.moduleId,role:f.role}:this.knowledge.mapFile(source,f.path)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
    const same=previous&&previous.commit===gitCommit&&signature(files)===signature(previousFiles,true)&&JSON.stringify(errors)===JSON.stringify(previous.errors);
    const snapshot=same?previous!:this.knowledge.createSnapshot(source,files,{commit:gitCommit,errors,excluded});
    if(activate){this.materialize(source,snapshot);this.knowledge.activate(source.id,snapshot.id);if(source.kind==='git')this.knowledge.discoverTags(source,tags);}
    await this.embedSnapshot(snapshot.id,job);
    job.errors.push(...errors.slice(0,100));job.status='completed';job.message=`${inputs.length}개 확인 · 변경 ${changed} · 재사용 ${reused} · 진단 ${job.errors.length}`;
    if(activate)this.store.updateSource(source.id,job.errors.length?'warning':'ready',job.errors.slice(0,3).join('\n'),now());
    await this.flushDeletes();return snapshot;
  }
  private materialize(source:Source,snapshot:Snapshot){
    const files=this.knowledge.snapshotFiles(snapshot.id),previous=this.store.documents(source.id),byPath=new Map(previous.map(d=>[d.path,d])),paths=new Set(files.map(f=>f.path));
    this.store.db.transaction(()=>{
      for(const old of previous)if(!paths.has(old.path))this.store.removeDocument(old.id);
      for(const f of files){
        const old=byPath.get(f.path);if(old?.hash===f.rawHash)continue;
        const parsed=this.knowledge.parsed(f.parsedKey)!;const id=old?.id||stableId(source.id+'\0'+f.path);
        const doc:Document={id,sourceId:source.id,path:f.path,title:parsed.title,text:parsed.text,hash:f.rawHash,embedded:0,board:source.board,revision:source.revision};
        const chunks:Chunk[]=parsed.chunks.map((c,i)=>({...c,id:stableId(id+'\0'+f.rawHash+'\0'+i),documentId:id,sourceId:source.id,path:f.path,title:doc.title,board:source.board,revision:source.revision}));this.store.replaceDocument(doc,chunks);
      }
    })();
  }
  async embedSnapshot(snapshotId:string,job?:Work){
    if(this.config.mode==='keyword')return;
    try{
      if(await this.providers.ensureCollection())this.knowledge.resetVectors();
      const modelKey='embeddinggemma-300M-Q8_0-768-v1';const points:any[]=[];const payloadHashes=new Map<string,string>();
      const flush=async()=>{if(!points.length)return;const batch=points.splice(0);await this.providers.request(this.config.qdrantURL,this.providers.collectionPath()+'/points?wait=true',{points:batch},'PUT');for(const p of batch)this.knowledge.markVector(p.id,modelKey,payloadHashes.get(p.id)!);};
      for(const c of this.knowledge.vectorChunks(snapshotId)){
        if(this.stopped)break;
        const memberships=this.knowledge.memberships(c.id);
        const payload={snapshotIds:[...new Set(memberships.map(m=>m.snapshotId))].sort(),projectId:[...new Set(memberships.map(m=>m.projectId))].sort(),moduleIds:[...new Set(memberships.map(m=>m.moduleId))].sort(),roles:[...new Set(memberships.map(m=>m.role))].sort(),kind:'knowledge'};
        const payloadHash=hashOf(JSON.stringify(payload)),stored=this.knowledge.vectorState(c.id);
        if(stored?.modelKey===modelKey&&stored.membershipHash===payloadHash)continue;
        const input=`title: ${c.title} | text: ${c.text}`,key=hashOf(modelKey+'\0'+input);
        let vector=this.knowledge.embedding(key);if(!vector){vector=await this.providers.embed(input);this.knowledge.cacheEmbedding(key,vector);}
        payloadHashes.set(c.id,payloadHash);points.push({id:c.id,vector,payload});
        if(points.length>=16)await flush();
      }
      await flush();const snapshot=this.knowledge.snapshot(snapshotId);
      if(snapshot&&this.knowledge.connection(snapshot.sourceId).snapshotId===snapshotId)for(const d of this.store.documents(snapshot.sourceId))this.store.markEmbedded(d.id);
    }catch(error:any){job?.errors.push('벡터 색인 보류: '+error.message);}
  }
  private async runVersion(job:Work){
    const request=job.request!;
    if(request.reindexVersionId){await this.reindexVersion(job,request.reindexVersionId);return;}
    const candidate=request.candidateId?this.knowledge.candidate(request.candidateId):null;let bindings:Record<string,string>={};
    if(candidate){
      bindings={...candidate.snapshots,...request.snapshots};
      if(request.sourceIds)bindings=Object.fromEntries(Object.entries(bindings).filter(([sourceId])=>request.sourceIds!.includes(sourceId)));
      if(!candidate.automatic&&!request.snapshots)throw new AppError('SPEC_SELECTION_REQUIRED','과거 태그에 해당하는 사양서 스냅샷을 선택하세요.');
      const source=this.store.source(candidate.sourceId);if(!source)throw new Error('Git 연결이 삭제되었습니다.');
      const snapshot=await this.build(source,job,candidate.commit,false);bindings[source.id]=snapshot.id;
    }else{bindings=request.snapshots||this.knowledge.currentBindings(request.projectId);if(request.sourceIds)bindings=Object.fromEntries(Object.entries(bindings).filter(([id])=>request.sourceIds!.includes(id)));}
    const version=this.knowledge.saveVersion({projectId:request.projectId,name:request.name,snapshots:bindings,parentVersionId:request.parentVersionId,notes:request.notes});
    if(candidate)this.knowledge.saveCandidate({...candidate,status:'confirmed',versionId:version.id});
    job.versionId=version.id;job.status='completed';job.message=`${version.name} 버전 자료를 보존했습니다.`;
  }
  private async reindexVersion(job:Work,id:string){
    const version=this.knowledge.version(id);if(!version)throw new AppError('NOT_FOUND','버전을 찾을 수 없습니다.',404);
    const overrides:Record<string,string>={};
    job.total=Object.values(version.snapshots).reduce((n,s)=>n+this.knowledge.snapshotFiles(s).length,0);
    for(const originalId of Object.values(version.snapshots)){
      const original=this.knowledge.snapshot(originalId)!;if(original.legacy)throw new AppError('LEGACY_ORIGINAL','이관된 추출 텍스트에는 원본이 없습니다. 자료를 다시 동기화하세요.',409);
      const stored=this.knowledge.snapshotFiles(originalId),files:SnapshotFile[]=[];
      for(const f of stored){
        if(this.stopped)throw new Error('서버 종료로 중단되었습니다.');const bytes=this.knowledge.raw(f.rawHash);
        const parsed=await parseDocumentBytes(f.path,bytes,this.config);
        if(parsed.warnings.length)throw new AppError('REPARSE_WARNING',`${f.path}: ${parsed.warnings.join('; ')}`,409);
        const saved=this.knowledge.putParsed(bytes,parsed,PARSER_PROFILE,basename(f.path));files.push({...f,...saved});job.processed++;job.message=`보존 원문 재처리 ${job.processed}/${job.total}`;this.save(job);
      }
      const first=stored[0];const source:Source=this.store.source(original.sourceId)||{id:original.sourceId,name:'보존 자료',kind:'folder',path:'',board:first?.board||'',revision:first?.revision||'',status:'ready'};
      // Deleted connections still have immutable ownership, metadata and originals in their versions.
      const connection=this.knowledge.connection(source.id);if(connection.projectId!==original.projectId)this.knowledge.saveConnection(source.id,{projectId:original.projectId});
      const derived=this.knowledge.createSnapshot(source,files,{commit:original.commit,errors:[],excluded:original.excluded,derivedFrom:originalId});
      overrides[originalId]=derived.id;await this.embedSnapshot(derived.id,job);
    }
    this.knowledge.setIndexOverrides(overrides);job.status='completed';job.versionId=id;job.message=`${version.name} 원본을 유지하고 색인을 재구축했습니다.`;
  }
}
