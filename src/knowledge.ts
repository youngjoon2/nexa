import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Store,lexicalQuery} from './storage';
import {AppError,type Source,type Hit,type SearchInput} from './types';
import type {Config} from './config';
import type {ParsedDocument} from './ingestion';

export type KnowledgeSearchInput = SearchInput;
export type Role = 'code'|'spec'|'reference';
export type Project = {id:string;name:string;createdAt:string};
export type Module = {id:string;projectId:string;name:string;rules:{sourceId?:string;pattern:string;role?:Role}[]};
export type Connection = {projectId:string;role:Role;paused:boolean;git?:{url:string;branch:string;tagPattern?:string};snapshotId?:string;lastCheckedAt?:string;errors:string[];unavailable?:boolean;stalePaths?:string[];knownTags?:Record<string,string>;documentLinks?:Record<string,string>};
export type Snapshot = {id:string;sourceId:string;projectId:string;createdAt:string;commit?:string;errors:string[];excluded:string[];complete:boolean;legacy?:boolean;derivedFrom?:string};
export type SoftwareVersion = {id:string;projectId:string;name:string;createdAt:string;status:'confirmed';snapshots:Record<string,string>;parentVersionId?:string;notes?:string};
export type Candidate = {id:string;projectId:string;sourceId:string;name:string;commit:string;createdAt:string;status:'pending'|'confirmed';snapshots:Record<string,string>;warnings:string[];automatic:boolean;versionId?:string};
export type SnapshotFile = {path:string;parsedKey:string;rawHash:string;moduleId?:string;role?:Role;logicalKey?:string};
const now=()=>new Date().toISOString();
// Normalize only the old generated label; keep stored and user-authored names intact.
const displayProject=(project:Project):Project=>project.id==='default'&&project.name==='기본 프로젝트'?{...project,name:'Default project'}:project;
export const hashOf=(input:string|Uint8Array)=>createHash('sha256').update(input).digest('hex');
export function contentId(input:string) {const h=hashOf(input);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function matchesPattern(path:string,pattern:string) {
  if(pattern.length>512)return false;
  const escaped=pattern.replaceAll('\\','/').split('**').map(p=>p.split('*').map(q=>q.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')).join('.*');
  return new RegExp('^'+escaped+'$','i').test(path.replaceAll('\\','/'));
}
function label(value:unknown,name:string,max=120):string {if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw new AppError('INVALID_FIELD',`Enter a valid ${name}.`);return value.trim();}
const hitColumns='SELECT c.id chunkId,c.text,c.title,c.data chunkData,f.id fileId,f.sourceId,f.path,f.snapshotId,f.moduleId,f.role,f.board,f.revision';

/** Immutable source snapshots share parsed content and embedding inputs across versions. */
export class KnowledgeBase {
  readonly db;
  readonly blobDir:string;
  constructor(readonly store:Store,readonly config:Config) {
    this.db=store.db;this.blobDir=join(config.dataDir,'objects');mkdirSync(this.blobDir,{recursive:true});
    const installed=this.db.query("SELECT name FROM sqlite_master WHERE name='kb_projects'").get();
    if(!installed&&store.counts().documents>0) {
      const dir=join(config.dataDir,'backups');mkdirSync(dir,{recursive:true});
      this.db.query('VACUUM INTO ?').run(join(dir,`before-knowledge-${Date.now()}.sqlite`));
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_connections(sourceId TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_modules(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_parsed(key TEXT PRIMARY KEY,rawHash TEXT NOT NULL,profile TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_chunks(id TEXT PRIMARY KEY,parsedKey TEXT NOT NULL,ordinal INTEGER NOT NULL,text TEXT NOT NULL,title TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kb_chunks_parsed ON kb_chunks(parsedKey);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(id UNINDEXED,title,text,tokenize='unicode61 tokenchars _');
      CREATE TRIGGER IF NOT EXISTS kb_chunk_insert AFTER INSERT ON kb_chunks BEGIN INSERT INTO kb_fts(rowid,id,title,text) VALUES(new.rowid,new.id,new.title,new.text); END;
      CREATE TRIGGER IF NOT EXISTS kb_chunk_delete AFTER DELETE ON kb_chunks BEGIN DELETE FROM kb_fts WHERE rowid=old.rowid; END;
      CREATE TABLE IF NOT EXISTS kb_snapshots(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL,projectId TEXT NOT NULL,createdAt TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kb_snapshots_source ON kb_snapshots(sourceId,createdAt);
      CREATE TABLE IF NOT EXISTS kb_files(id TEXT PRIMARY KEY,snapshotId TEXT NOT NULL REFERENCES kb_snapshots(id) ON DELETE CASCADE,sourceId TEXT NOT NULL,path TEXT NOT NULL,parsedKey TEXT NOT NULL,rawHash TEXT NOT NULL,moduleId TEXT NOT NULL,role TEXT NOT NULL,logicalKey TEXT NOT NULL,board TEXT NOT NULL,revision TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kb_files_scope ON kb_files(snapshotId,moduleId,role);
      CREATE INDEX IF NOT EXISTS kb_files_parsed ON kb_files(parsedKey);
      CREATE TABLE IF NOT EXISTS kb_versions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(projectId,name));
      CREATE TABLE IF NOT EXISTS kb_candidates(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,sourceId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_embeddings(key TEXT PRIMARY KEY,vector TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_vectors(id TEXT PRIMARY KEY,modelKey TEXT NOT NULL,membershipHash TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS kb_version_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_snapshot_indexes(snapshotId TEXT PRIMARY KEY,derivedSnapshotId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_blob_deletes(rawHash TEXT PRIMARY KEY);
    `);
    this.db.query('INSERT OR IGNORE INTO kb_projects VALUES(?,?,?)').run('default','Default project',now());
    if(!installed)this.importLegacy();
  }
  projects():Project[]{return (this.db.query('SELECT * FROM kb_projects ORDER BY createdAt,id').all() as Project[]).map(displayProject);}
  project(id:string) {const project=this.db.query('SELECT * FROM kb_projects WHERE id=?').get(id) as Project|null;return project?displayProject(project):null;}
  addProject(name:unknown) {const p={id:crypto.randomUUID(),name:label(name,'project name'),createdAt:now()};if(this.projects().some(x=>x.name===p.name))throw new AppError('DUPLICATE_PROJECT','A project with this name already exists.',409);this.db.query('INSERT INTO kb_projects VALUES(?,?,?)').run(p.id,p.name,p.createdAt);return p;}
  modules(projectId:string):Module[]{return this.db.query('SELECT data FROM kb_modules WHERE projectId=? ORDER BY rowid').all(projectId).map((r:any)=>JSON.parse(r.data));}
  addModule(projectId:string,body:any,id?:string) {
    this.requireProject(projectId);const name=label(body?.name,'module name');
    if(!Array.isArray(body.rules)||!body.rules.length||body.rules.length>100)throw new AppError('INVALID_RULES','Provide 1 to 100 module path rules.');
    const rules=body.rules.map((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r))throw new AppError('INVALID_RULES','Provide valid module path rules.');
      return {pattern:label(r.pattern,'path rule',512),...(r.sourceId?{sourceId:label(r.sourceId,'source connection ID')} :{}),...(r.role?{role:this.role(r.role)}:{})};
    });
    for(const r of rules)if(r.sourceId&&this.connection(r.sourceId).projectId!==projectId)throw new AppError('INVALID_RULES','This source belongs to another project.');
    if(id&&!this.modules(projectId).some(m=>m.id===id))throw new AppError('NOT_FOUND','Module not found.',404);
    if(this.modules(projectId).some(m=>m.name===name&&m.id!==id))throw new AppError('DUPLICATE_MODULE','A module with this name already exists.',409);
    const m:Module={id:id||crypto.randomUUID(),projectId,name,rules};this.db.query('INSERT INTO kb_modules VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET projectId=excluded.projectId,data=excluded.data').run(m.id,projectId,JSON.stringify(m));return m;
  }
  role(value:unknown):Role {if(value!==undefined&&!['code','spec','reference'].includes(String(value)))throw new AppError('INVALID_ROLE','Select a valid source role.');return value as Role||'spec';}
  requireProject(id:string) {if(!this.project(id))throw new AppError('NOT_FOUND','Project not found.',404);}
  connection(sourceId:string):Connection {
    const r=this.db.query('SELECT data FROM kb_connections WHERE sourceId=?').get(sourceId) as any;
    return r?JSON.parse(r.data):{projectId:'default',role:'spec',paused:false,errors:[]};
  }
  saveConnection(sourceId:string,patch:Partial<Connection>) {
    const c={...this.connection(sourceId),...patch};this.requireProject(c.projectId);
    this.db.query('INSERT OR REPLACE INTO kb_connections VALUES(?,?)').run(sourceId,JSON.stringify(c));return c;
  }
  sources():Source[] {return this.store.sources().map(s=>({...s,...this.connection(s.id)}));}
  source(id:string) {const s=this.store.source(id);return s?{...s,...this.connection(id)}:null;}
  removeConnection(sourceId:string) {
    this.db.transaction(()=>{
      this.db.query('DELETE FROM kb_candidates WHERE sourceId=?').run(sourceId);
      this.db.query('DELETE FROM kb_connections WHERE sourceId=?').run(sourceId);
      this.pruneRecords(sourceId,false);
    })();
    this.flushBlobDeletes();
  }
  private importLegacy() {
    for(const s of this.store.sources()) {
      const files:SnapshotFile[]=[];
      for(const old of this.store.documents(s.id)) {
        const d=this.store.document(old.id)!;
        const chunks=this.store.chunks(d.id).map(({text,startLine,endLine,page})=>({text,startLine,endLine,page}));
        const key=this.putParsed(new TextEncoder().encode(d.text),{title:d.title,text:d.text,chunks,warnings:[]},'legacy-extracted-v1',d.title);
        files.push({path:d.path,...key});
      }
      this.saveConnection(s.id,{});
      if(files.length) {const snap=this.createSnapshot(s,files,{errors:[],excluded:[],legacy:true});this.activate(s.id,snap.id);}
    }
  }
  putRaw(bytes:Uint8Array) {const hash=hashOf(bytes);const path=join(this.blobDir,hash);if(!existsSync(path)){writeFileSync(path,bytes,{flag:'wx'});this.db.query('INSERT OR IGNORE INTO kb_blob_deletes VALUES(?)').run(hash);}return hash;}
  raw(hash:string) {if(!/^[a-f0-9]{64}$/.test(hash))throw new AppError('INVALID_HASH','Invalid original file reference.');return new Uint8Array(readFileSync(join(this.blobDir,hash)));}
  parsedKey(rawHash:string,profile:string,name='') {return hashOf(rawHash+'\0'+profile+'\0'+name);}
  parsed(key:string):ParsedDocument|null {const row=this.db.query('SELECT data FROM kb_parsed WHERE key=?').get(key) as any;return row?JSON.parse(row.data):null;}
  putParsed(bytes:Uint8Array,parsed:ParsedDocument,profile:string,name='') {
    const rawHash=this.putRaw(bytes),parsedKey=this.parsedKey(rawHash,profile,name);
    if(!this.parsed(parsedKey))this.db.transaction(()=>{
      this.db.query('INSERT INTO kb_parsed VALUES(?,?,?,?)').run(parsedKey,rawHash,profile,JSON.stringify(parsed));
      const q=this.db.query('INSERT INTO kb_chunks VALUES(?,?,?,?,?,?)');
      parsed.chunks.forEach((c,i)=>q.run(contentId(parsedKey+'\0'+i),parsedKey,i,c.text,parsed.title,JSON.stringify(c)));
    })();
    return {rawHash,parsedKey};
  }
  mapFile(source:Source,path:string):{moduleId:string;role:Role} {
    const settings=this.connection(source.id);
    for(const m of this.modules(settings.projectId))for(const r of m.rules)if((!r.sourceId||r.sourceId===source.id)&&matchesPattern(path,r.pattern))return {moduleId:m.id,role:r.role||settings.role};
    return {moduleId:'',role:settings.role};
  }
  createSnapshot(source:Source,files:SnapshotFile[],options:{commit?:string;errors:string[];excluded:string[];legacy?:boolean;derivedFrom?:string}) {
    const c=this.connection(source.id);const snapshot:Snapshot={id:crypto.randomUUID(),sourceId:source.id,projectId:c.projectId,createdAt:now(),...options,complete:options.errors.length===0};
    this.db.transaction(()=>{
      this.db.query('INSERT INTO kb_snapshots VALUES(?,?,?,?,?)').run(snapshot.id,source.id,c.projectId,snapshot.createdAt,JSON.stringify(snapshot));
      const insert=this.db.query('INSERT INTO kb_files VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for(const f of files) {
        const mapping=this.mapFile(source,f.path);
        insert.run(contentId(snapshot.id+'\0'+f.path),snapshot.id,source.id,f.path,f.parsedKey,f.rawHash,f.moduleId??mapping.moduleId,f.role||mapping.role,f.logicalKey||source.id+':'+f.path,source.board,source.revision);
      }
    })();return snapshot;
  }
  snapshot(id:string):Snapshot|null {const r=this.db.query('SELECT data FROM kb_snapshots WHERE id=?').get(id) as any;return r?JSON.parse(r.data):null;}
  indexedSnapshot(id:string) {return (this.db.query('SELECT derivedSnapshotId FROM kb_snapshot_indexes WHERE snapshotId=?').get(id) as any)?.derivedSnapshotId||id;}
  setIndexOverrides(bindings:Record<string,string>){
    const sources=new Set<string>();
    this.db.transaction(()=>{for(const [original,derived] of Object.entries(bindings)){
      const before=this.snapshot(original),s=this.snapshot(derived);
      if(!before||!s?.complete||s.derivedFrom!==original||s.sourceId!==before.sourceId||s.projectId!==before.projectId)throw new AppError('INVALID_INDEX','The rebuilt index does not match the original snapshot.',409);
      const manifest=(id:string)=>JSON.stringify(this.snapshotFiles(id).map(f=>[f.path,f.rawHash,f.moduleId,f.role,f.logicalKey,f.board,f.revision]));
      if(manifest(original)!==manifest(derived))throw new AppError('INVALID_INDEX','The preserved originals or metadata changed during reprocessing.',409);
      this.db.query('INSERT OR REPLACE INTO kb_snapshot_indexes VALUES(?,?)').run(original,derived);sources.add(before.sourceId);
    }})();
    // Reprocessing does not activate a live connection; explicitly retire superseded derived indexes.
    for(const sourceId of sources)this.prune(sourceId);
  }
  snapshotFiles(id:string) {return this.db.query('SELECT * FROM kb_files WHERE snapshotId=? ORDER BY path').all(id) as (SnapshotFile&{id:string;sourceId:string;board:string;revision:string})[];}
  activate(sourceId:string,id:string) {const s=this.snapshot(id);if(!s||s.sourceId!==sourceId)throw new AppError('INVALID_SNAPSHOT','The source snapshot does not match.');this.saveConnection(sourceId,{snapshotId:id,errors:s.errors,unavailable:false,stalePaths:[],lastCheckedAt:now()});this.prune(sourceId);}
  recordFailure(sourceId:string,errors:string[]) {this.saveConnection(sourceId,{errors,unavailable:true,lastCheckedAt:now()});}
  scopeInfo(input:KnowledgeSearchInput) {
    const version=input.versionId?this.version(input.versionId):null;
    if(input.versionId&&!version)throw new AppError('NOT_FOUND','Software version not found.',404);
    const projectId=input.projectId||version?.projectId||'default';this.requireProject(projectId);
    if(version&&version.projectId!==projectId)throw new AppError('INVALID_SCOPE','This software version belongs to another project.');
    if(input.moduleId&&!this.modules(projectId).some(x=>x.id===input.moduleId))throw new AppError('INVALID_SCOPE','Module not found.');
    const warnings:string[]=[];let failed=0;
    const snapshotIds=version?Object.values(version.snapshots).map(id=>this.indexedSnapshot(id)):this.sources().filter(s=>s.projectId===projectId).flatMap(s=>{
      const c=this.connection(s.id);if(c.errors.length){warnings.push(`${s.name}: ${c.errors.slice(0,2).join('; ')}`);failed+=c.errors.length;}
      if(c.unavailable){warnings.push(`${s.name}: Excluded from searches of current sources because its latest state could not be verified.`);return [];}
      return c.snapshotId?[c.snapshotId]:[];
    });
    for(const id of snapshotIds){const s=this.snapshot(id);if(s?.errors.length&&version){warnings.push(...s.errors);failed+=s.errors.length;}if(s?.legacy)warnings.push('This is migrated extracted text. Sync the source again to preserve its original files.');}
    const filters=(['moduleId','role','board','revision'] as const).filter(key=>input[key]);
    const documents=snapshotIds.length?(this.db.query(`SELECT count(*) n FROM kb_files WHERE snapshotId IN (${snapshotIds.map(()=>'?').join(',')})${filters.map(key=>` AND ${key}=?`).join('')}`).get(...snapshotIds,...filters.map(key=>input[key]!)) as any).n:0;
    return {snapshotIds,warnings:[...new Set(warnings)],coverage:{documents,failed},projectId};
  }
  private filter(input:KnowledgeSearchInput) {
    const scope=this.scopeInfo(input);const where=[`f.snapshotId IN (${scope.snapshotIds.map(()=>'?').join(',')||"''"})`];const args:any[]=[...scope.snapshotIds];
    for(const key of ['moduleId','role','board','revision'] as const)if(input[key]){where.push(`f.${key}=?`);args.push(input[key]);}
    return {scope,where,args};
  }
  private hit(row:any,input:KnowledgeSearchInput):Hit {
    const extra=JSON.parse(row.chunkData);return {...extra,id:row.chunkId,documentId:row.fileId,sourceId:row.sourceId,path:row.path,title:row.title,text:row.text,board:row.board,revision:row.revision,projectId:input.projectId||this.snapshot(row.snapshotId)?.projectId,snapshotId:row.snapshotId,versionId:input.versionId,moduleId:row.moduleId,role:row.role,score:0,channels:[]};
  }
  private select=hitColumns+' FROM kb_chunks c JOIN kb_files f ON f.parsedKey=c.parsedKey';
  lexical(input:KnowledgeSearchInput,limit=40):Hit[] {
    const match=lexicalQuery(input.query);if(!match)return [];const {where,args}=this.filter(input);
    // Search matching content first, then its occurrences. The scope index otherwise makes SQLite
    // scan every file in a selected version again for every matching FTS chunk on large projects.
    const rows=this.db.query(`${hitColumns} FROM kb_fts CROSS JOIN kb_chunks c ON c.rowid=kb_fts.rowid CROSS JOIN kb_files f INDEXED BY kb_files_parsed ON f.parsedKey=c.parsedKey WHERE kb_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(kb_fts,0,3,1),f.path,c.ordinal LIMIT ?`).all(match,...args,limit);
    return rows.map((r:any)=>({...this.hit(r,input),channels:['keyword']}));
  }
  hydrate(ids:string[],input:KnowledgeSearchInput):Hit[] {
    if(!ids.length)return [];const {where,args}=this.filter(input);
    return this.db.query(`${this.select} WHERE ${where.join(' AND ')} AND c.id IN (${ids.map(()=>'?').join(',')}) ORDER BY f.path,c.ordinal`).all(...args,...ids).map((r:any)=>this.hit(r,input));
  }
  document(id:string) {
    const row=this.db.query('SELECT f.*,p.data FROM kb_files f JOIN kb_parsed p ON p.key=f.parsedKey WHERE f.id=?').get(id) as any;
    if(!row)return null;const parsed=JSON.parse(row.data);const snap=this.snapshot(row.snapshotId)!;
    return {id:row.id,sourceId:row.sourceId,path:row.path,title:parsed.title,text:parsed.text,board:row.board,revision:row.revision,projectId:snap.projectId,snapshotId:snap.id,moduleId:row.moduleId,role:row.role,commit:snap.commit,createdAt:snap.createdAt,chunks:parsed.chunks,legacy:!!snap.legacy};
  }
  comparisonDocuments(input:KnowledgeSearchInput) {
    const {where,args}=this.filter(input);
    const rows=this.db.query(`SELECT f.*,p.data FROM kb_files f JOIN kb_parsed p ON p.key=f.parsedKey WHERE ${where.join(' AND ')} ORDER BY f.sourceId,f.path`).all(...args) as any[];
    return rows.map(r=>{const p=JSON.parse(r.data);const chunks=this.db.query(`${this.select} WHERE f.id=? ORDER BY c.ordinal`).all(r.id).map(x=>this.hit(x,input));return {id:r.id,path:r.path,sourceId:r.sourceId,logicalKey:r.logicalKey,moduleId:r.moduleId,role:r.role as Role,text:p.text,title:p.title,chunks};});
  }
  versions(projectId:string):SoftwareVersion[]{return this.db.query('SELECT data FROM kb_versions WHERE projectId=? ORDER BY rowid').all(projectId).map((r:any)=>JSON.parse(r.data));}
  version(id:string):SoftwareVersion|null {const r=this.db.query('SELECT data FROM kb_versions WHERE id=?').get(id) as any;return r?JSON.parse(r.data):null;}
  saveVersion(input:{projectId:string;name:string;snapshots:Record<string,string>;parentVersionId?:string;notes?:string}) {
    this.requireProject(input.projectId);const name=label(input.name,'software version name');
    if(this.versions(input.projectId).some(v=>v.name===name))throw new AppError('DUPLICATE_VERSION','A software version with this name already exists.',409);
    if(!Object.keys(input.snapshots).length)throw new AppError('EMPTY_VERSION','There are no sources to preserve.');
    if(input.parentVersionId&&this.version(input.parentVersionId)?.projectId!==input.projectId)throw new AppError('INVALID_PARENT','Select a valid previous revision.');
    for(const [sourceId,id] of Object.entries(input.snapshots)){const s=this.snapshot(id);if(!s||s.sourceId!==sourceId||s.projectId!==input.projectId||!s.complete)throw new AppError('INCOMPLETE_VERSION','Resolve source sync errors before confirming this version.',409);if(s.legacy)throw new AppError('LEGACY_SNAPSHOT','Migrated extracted text cannot be confirmed as a version with preserved originals. Select a snapshot synced from the original files.',409);}
    const version:SoftwareVersion={...input,name,id:crypto.randomUUID(),createdAt:now(),status:'confirmed'};
    this.db.query('INSERT INTO kb_versions VALUES(?,?,?,?)').run(version.id,version.projectId,name,JSON.stringify(version));return version;
  }
  deleteVersion(id:string) {const v=this.version(id);if(!v)throw new AppError('NOT_FOUND','Software version not found.',404);if(this.db.query("SELECT id FROM kb_versions WHERE json_extract(data,'$.parentVersionId')=?").get(id))throw new AppError('VERSION_REFERENCED','A later revision references this version.',409);this.db.query('DELETE FROM kb_versions WHERE id=?').run(id);for(const sid of Object.keys(v.snapshots))this.prune(sid);}
  currentBindings(projectId:string) {const bindings:Record<string,string>={};for(const s of this.sources().filter(s=>s.projectId===projectId)){const c=this.connection(s.id);if(c.snapshotId&&!c.unavailable)bindings[s.id]=c.snapshotId;}return bindings;}
  candidates(projectId:string):Candidate[]{return this.db.query('SELECT data FROM kb_candidates WHERE projectId=? ORDER BY rowid DESC').all(projectId).map((r:any)=>JSON.parse(r.data));}
  candidate(id:string):Candidate|null {const r=this.db.query('SELECT data FROM kb_candidates WHERE id=?').get(id) as any;return r?JSON.parse(r.data):null;}
  saveCandidate(c:Candidate) {this.db.query('INSERT OR REPLACE INTO kb_candidates VALUES(?,?,?,?)').run(c.id,c.projectId,c.sourceId,JSON.stringify(c));return c;}
  discoverTags(source:Source,tags:{name:string;commit:string}[]) {
    const c=this.connection(source.id),previous=c.knownTags,known:Record<string,string>={};
    for(const tag of tags){known[tag.name]=tag.commit;if(!previous||previous[tag.name]===tag.commit)continue;
      const id=contentId(source.id+'\0'+tag.name+'\0'+tag.commit);if(this.candidate(id))continue;
      const bindings=this.currentBindings(c.projectId);delete bindings[source.id];
      this.saveCandidate({id,sourceId:source.id,projectId:c.projectId,name:tag.name,commit:tag.commit,createdAt:now(),status:'pending',snapshots:bindings,warnings:previous[tag.name]?['The tag now points to a different commit. Previously confirmed versions are unchanged.']:[],automatic:true});
    }
    this.saveConnection(source.id,{knownTags:known});
  }
  proposeTag(sourceId:string,name:string) {const s=this.source(sourceId);if(!s||s.kind!=='git')throw new AppError('NOT_FOUND','Git source not found.',404);const c=this.connection(sourceId),commit=c.knownTags?.[name];if(!commit)throw new AppError('NOT_FOUND','Tag not found. Sync the source first.',404);const id=contentId(sourceId+'\0'+name+'\0'+commit);const old=this.candidate(id);if(old)return old;return this.saveCandidate({id,projectId:c.projectId,sourceId,name,commit,createdAt:now(),status:'pending',snapshots:{},warnings:['This is a historical tag. Select the specification snapshots for that version.'],automatic:false});}
  embedding(key:string):number[]|null {const r=this.db.query('SELECT vector FROM kb_embeddings WHERE key=?').get(key) as any;return r?JSON.parse(r.vector):null;}
  cacheEmbedding(key:string,vector:number[]) {this.db.query('INSERT OR REPLACE INTO kb_embeddings VALUES(?,?)').run(key,JSON.stringify(vector));}
  vectorChunks(snapshotId:string) {return this.db.query('SELECT DISTINCT c.id,c.text,c.title,c.parsedKey FROM kb_chunks c JOIN kb_files f ON f.parsedKey=c.parsedKey WHERE f.snapshotId=?').all(snapshotId) as {id:string;text:string;title:string;parsedKey:string}[];}
  memberships(chunkId:string) {return this.db.query('SELECT DISTINCT f.snapshotId,s.projectId,f.moduleId,f.role FROM kb_chunks c JOIN kb_files f ON f.parsedKey=c.parsedKey JOIN kb_snapshots s ON s.id=f.snapshotId WHERE c.id=?').all(chunkId) as {snapshotId:string;projectId:string;moduleId:string;role:Role}[];}
  vectorState(id:string) {return this.db.query('SELECT modelKey,membershipHash FROM kb_vectors WHERE id=?').get(id) as {modelKey:string;membershipHash:string}|null;}
  markVector(id:string,modelKey:string,membershipHash='') {this.db.query('INSERT OR REPLACE INTO kb_vectors VALUES(?,?,?)').run(id,modelKey,membershipHash);}
  pendingEmbeddings() {return (this.db.query("SELECT count(DISTINCT c.id) n FROM kb_chunks c JOIN kb_files f ON f.parsedKey=c.parsedKey JOIN kb_snapshots s ON s.id=f.snapshotId LEFT JOIN kb_vectors v ON v.id=c.id WHERE v.id IS NULL AND COALESCE(json_extract(s.data,'$.legacy'),0)=0").get() as any).n as number;}
  resetVectors() {this.db.exec('DELETE FROM kb_vectors');}
  snapshotList(sourceId:string) {return this.db.query('SELECT data FROM kb_snapshots WHERE sourceId=? ORDER BY createdAt DESC,rowid DESC LIMIT 100').all(sourceId).map((r:any)=>JSON.parse(r.data));}
  private pruneRecords(sourceId:string,retainRecent=true) {
    const keep=new Set<string>();
    for(const r of this.db.query('SELECT data FROM kb_versions UNION ALL SELECT data FROM kb_candidates').all() as any[])for(const id of Object.values(JSON.parse(r.data).snapshots||{}))keep.add(id as string);
    for(const r of this.db.query("SELECT data FROM kb_version_jobs WHERE json_extract(data,'$.status') IN ('queued','running')").all() as any[])for(const id of Object.values(JSON.parse(r.data).request?.snapshots||{}))keep.add(id as string);
    const snapshots=this.db.query('SELECT data FROM kb_snapshots WHERE sourceId=? ORDER BY createdAt DESC,rowid DESC').all(sourceId).map((r:any)=>JSON.parse(r.data));
    if(retainRecent&&this.store.source(sourceId)&&this.db.query('SELECT sourceId FROM kb_connections WHERE sourceId=?').get(sourceId)){
      const c=this.connection(sourceId);if(c.snapshotId)keep.add(c.snapshotId);
      snapshots.slice(0,30).forEach(s=>keep.add(s.id));
    }
    const aliases=this.db.query('SELECT snapshotId,derivedSnapshotId FROM kb_snapshot_indexes').all() as {snapshotId:string;derivedSnapshotId:string}[];
    let changed=true;while(changed){changed=false;for(const r of aliases)if(keep.has(r.snapshotId)&&!keep.has(r.derivedSnapshotId)){keep.add(r.derivedSnapshotId);changed=true;}}
    for(const s of snapshots)if(!keep.has(s.id))this.db.query('DELETE FROM kb_snapshots WHERE id=?').run(s.id);
    this.db.exec('DELETE FROM kb_snapshot_indexes WHERE snapshotId NOT IN (SELECT id FROM kb_snapshots) OR derivedSnapshotId NOT IN (SELECT id FROM kb_snapshots)');
    // Another source may have parsed files that have not yet been attached to its staged snapshot.
    // Its own activation will retry global content cleanup once those files are attached.
    if(this.db.query("SELECT id FROM jobs WHERE sourceId<>? AND json_extract(data,'$.status')='running' UNION ALL SELECT id FROM kb_version_jobs WHERE json_extract(data,'$.sourceId')<>? AND json_extract(data,'$.status')='running' LIMIT 1").get(sourceId,sourceId))return;
    // Cleanup only unreferenced content. Vector tombstones are retried by the existing worker.
    this.db.exec('INSERT OR IGNORE INTO vector_deletes SELECT id FROM kb_chunks WHERE parsedKey NOT IN (SELECT parsedKey FROM kb_files)');
    this.db.exec('DELETE FROM kb_vectors WHERE id IN (SELECT id FROM kb_chunks WHERE parsedKey NOT IN (SELECT parsedKey FROM kb_files))');
    this.db.exec('DELETE FROM kb_chunks WHERE parsedKey NOT IN (SELECT parsedKey FROM kb_files)');
    this.db.exec('INSERT OR IGNORE INTO kb_blob_deletes SELECT rawHash FROM kb_parsed WHERE key NOT IN (SELECT parsedKey FROM kb_files)');
    this.db.exec('DELETE FROM kb_parsed WHERE key NOT IN (SELECT parsedKey FROM kb_files)');
  }
  private flushBlobDeletes(){
    // A caller may have an outer SQLite transaction. Unlink only after the outer commit as well.
    if(this.db.inTransaction)return;
    const referenced=this.db.query('SELECT key FROM kb_parsed WHERE rawHash=? UNION ALL SELECT id FROM kb_files WHERE rawHash=? LIMIT 1');
    const acknowledge=this.db.query('DELETE FROM kb_blob_deletes WHERE rawHash=?');
    for(const {rawHash} of this.db.query('SELECT rawHash FROM kb_blob_deletes').all() as {rawHash:string}[]){
      if(!/^[a-f0-9]{64}$/.test(rawHash)||referenced.get(rawHash,rawHash)){acknowledge.run(rawHash);continue;}
      try{unlinkSync(join(this.blobDir,rawHash));acknowledge.run(rawHash);}catch(error:any){if(error.code==='ENOENT')acknowledge.run(rawHash);}
    }
  }
  prune(sourceId:string) {
    this.db.transaction(()=>this.pruneRecords(sourceId))();
    this.flushBlobDeletes();
  }
  preview(sourceId:string) {const c=this.connection(sourceId);const documents=c.snapshotId?this.db.query("SELECT f.id,f.path,f.sourceId,f.moduleId,f.role,f.snapshotId,json_extract(p.data,'$.title') title FROM kb_files f JOIN kb_parsed p ON p.key=f.parsedKey WHERE f.snapshotId=? ORDER BY f.path LIMIT 200").all(c.snapshotId):[];const total=c.snapshotId?(this.db.query('SELECT count(*) n FROM kb_files WHERE snapshotId=?').get(c.snapshotId) as any).n:0;return {documents,total,truncated:total>documents.length,errors:c.errors,tags:Object.entries(c.knownTags||{}).map(([name,commit])=>({name,commit})),snapshots:this.snapshotList(sourceId)};}
}
