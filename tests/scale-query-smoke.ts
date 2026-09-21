/** Read-only query benchmark for an existing synthetic scale-smoke database. No fixture generation. */
import {Database} from 'bun:sqlite';
import assert from 'node:assert/strict';
import {basename,isAbsolute,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {KnowledgeBase,type KnowledgeSearchInput,type SoftwareVersion} from '../src/knowledge';
import {lexicalQuery} from '../src/storage';
import type {Hit} from '../src/types';

const args=process.argv.slice(2);
if(!args.includes('--run')){
  console.log('Opt-in: bun --no-install tests/scale-query-smoke.ts --run --db=<OS temp/nexa-scale-smoke-*/scale.sqlite> [--plan-only]');
  process.exit(0);
}
for(const arg of args)if(!['--run','--plan-only'].includes(arg)&&!arg.startsWith('--db='))throw new Error('Unsupported option: '+arg);
const paths=args.filter(arg=>arg.startsWith('--db='));assert.equal(paths.length,1,'Provide one existing synthetic fixture path.');
const dbPath=resolve(paths[0]!.slice(5)),rel=relative(resolve(tmpdir()),dbPath);
assert(rel&&!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('nexa-scale-smoke-')&&basename(dbPath)==='scale.sqlite','Only a retained temporary scale-smoke database may be benchmarked.');
const db=new Database(dbPath,{readonly:true,strict:true});
let server:ReturnType<typeof Bun.serve>|undefined;
try {
  const versions=db.query('SELECT data FROM kb_versions ORDER BY rowid').all().map((row:any)=>JSON.parse(row.data)) as SoftwareVersion[];
  assert(versions.length>=2&&versions.every(v=>/^synthetic-v\d+$/.test(v.name)),'Expected the synthetic scale fixture.');
  const projectId=versions[0]!.projectId;
  const module=JSON.parse((db.query('SELECT data FROM kb_modules WHERE projectId=? ORDER BY rowid LIMIT 1').get(projectId) as any).data);
  const columns='SELECT c.id chunkId,c.text,c.title,c.data chunkData,f.id fileId,f.sourceId,f.path,f.snapshotId,f.moduleId,f.role,f.board,f.revision';
  const originalFrom='FROM kb_chunks c JOIN kb_files f ON f.parsedKey=c.parsedKey JOIN kb_fts ON kb_fts.rowid=c.rowid';
  const ftsFirstFrom='FROM kb_fts CROSS JOIN kb_chunks c ON c.rowid=kb_fts.rowid CROSS JOIN kb_files f INDEXED BY kb_files_parsed ON f.parsedKey=c.parsedKey';
  // Constructor intentionally skipped: it creates/migrates tables and raw directories. This harness
  // calls only read methods, which depend on the existing db and the SELECT column list.
  const kb=Object.assign(Object.create(KnowledgeBase.prototype),{db,select:columns+' FROM kb_chunks c JOIN kb_files f ON f.parsedKey=c.parsedKey'}) as KnowledgeBase;
  const inputs:Array<KnowledgeSearchInput>=Array.from({length:5},(_,i)=>{
    const version=versions[Math.floor(i*(versions.length-1)/4)]!;
    return {query:'SCALE_VERSION_'+version.name.replace('synthetic-v',''),projectId,versionId:version.id,moduleId:module.id,role:'spec',limit:5};
  });
  function statement(input:KnowledgeSearchInput,optimized:boolean){
    const {where,args}=((kb as any).filter(input));
    return {sql:`${columns} ${optimized?ftsFirstFrom:originalFrom} WHERE kb_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(kb_fts,0,3,1),f.path,c.ordinal LIMIT ?`,args:[lexicalQuery(input.query),...args,input.limit]};
  }
  const old=statement(inputs[0]!,false),candidate=statement(inputs[0]!,true);
  const plans={original:db.query('EXPLAIN QUERY PLAN '+old.sql).all(...old.args),ftsFirst:db.query('EXPLAIN QUERY PLAN '+candidate.sql).all(...candidate.args)};
  console.log(JSON.stringify({stage:'plans',dbPath,plans},null,2));
  if(!args.includes('--plan-only')){
    const runQuery=(input:KnowledgeSearchInput,optimized:boolean)=>{
      const started=performance.now(),prepared=statement(input,optimized);
      const hits=db.query(prepared.sql).all(...prepared.args).map((row:any)=>({...((kb as any).hit(row,input)),channels:['keyword']})) as Hit[];
      return {hits,sqlAndHydrationMs:performance.now()-started};
    };
    server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      if(request.method!=='POST')return new Response('Not found',{status:404});
      const {index,optimized}=await request.json() as {index:number;optimized:boolean};
      if(!Number.isInteger(index)||index<0||index>=inputs.length)return new Response('Invalid query',{status:400});
      return Response.json(runQuery(inputs[index]!,optimized));
    }});
    const batch=async(optimized:boolean)=>{
      const start=performance.now();
      const requests=await Promise.all(inputs.map(async(input,index)=>{
        const began=performance.now();const response=await fetch(`http://127.0.0.1:${server!.port}/query`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index,optimized})});
        assert.equal(response.status,200);const result=await response.json() as {hits:Hit[];sqlAndHydrationMs:number};
        assert.equal(result.hits.length,5);
        for(const hit of result.hits){assert.equal(hit.versionId,input.versionId);assert.equal(hit.moduleId,input.moduleId);assert.equal(hit.role,'spec');assert(hit.text.includes(input.query+'_'));}
        return {version:versions.find(v=>v.id===input.versionId)!.name,query:input.query,elapsedMs:performance.now()-began,sqlAndHydrationMs:result.sqlAndHydrationMs,identities:result.hits.map(h=>h.documentId+'\0'+h.id)};
      }));
      return {batchMs:performance.now()-start,requests};
    };
    const before=await batch(false),after=await batch(true);
    assert.deepEqual(after.requests.map(r=>r.identities),before.requests.map(r=>r.identities),'Query reordering must preserve each ranked occurrence.');
    for(const input of inputs)assert.deepEqual(kb.lexical(input,5).map(h=>h.documentId+'\0'+h.id),runQuery(input,true).hits.map(h=>h.documentId+'\0'+h.id),'Application query must match the optimized benchmark.');
    console.log(JSON.stringify({status:'passed',dbPath,readOnly:true,concurrentCallers:5,before,after,speedup:before.batchMs/after.batchMs,limitations:'One warm-process batch before/after over five selective synthetic queries; not a production throughput guarantee.'},null,2));
  }
} finally {if(server)await server.stop(true);db.close();}
