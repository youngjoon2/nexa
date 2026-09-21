/**
 * Opt-in synthetic KB metadata / FTS / content-sharing check, without model calls.
 * bun --no-install tests/scale-smoke.ts --run
 * Small script check: add --versions=3 --files=100. Never opens the user's data dir.
 * The generated temporary directory is retained for inspection; no files are deleted.
 */
import {strict as assert} from 'node:assert';
import {mkdtempSync,readdirSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir,cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config';
import {Store} from '../src/storage';
import {KnowledgeBase,type SnapshotFile,type SoftwareVersion} from '../src/knowledge';
import type {Source,Hit} from '../src/types';

const args=process.argv.slice(2);
if(!args.includes('--run')) {
  console.log('Opt-in only: bun --no-install tests/scale-smoke.ts --run [--versions=50] [--files=10000]');
  console.log('Uses a new OS temporary directory. Tests metadata/FTS/shared storage; no models, Git, watchers, or default data.');
  process.exit(0);
}
for(const arg of args)if(arg!=='--run'&&!/^--(?:versions|files)=\d+$/.test(arg))throw new Error(`Unsupported option: ${arg}`);
function count(name:string,fallback:number,max:number) {
  const values=args.filter(a=>a.startsWith(`--${name}=`));
  if(values.length>1)throw new Error(`Specify --${name} once.`);
  const n=values.length?Number(values[0]!.split('=')[1]):fallback;
  if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error(`--${name} must be 1..${max}.`);
  return n;
}
const versionCount=count('versions',50,100),filesPerVersion=count('files',10_000,100_000);
if(filesPerVersion%20!==0)throw new Error('--files must be a multiple of 20 so exactly 95% can be shared.');
if(versionCount*filesPerVersion>1_000_000)throw new Error('This smoke script is limited to 1,000,000 file occurrences.');
const sharedCount=filesPerVersion*19/20,changedCount=filesPerVersion-sharedCount;
const dataDir=mkdtempSync(join(tmpdir(),'nexa-scale-smoke-'));
const dbPath=join(dataDir,'scale.sqlite'),reportPath=join(dataDir,'scale-results.json');
console.log(JSON.stringify({stage:'start',dataDir,versionCount,filesPerVersion,sharedCount,changedCount}));
// A fresh explicit environment prevents inherited NEXA_DATA_DIR or service settings from being used.
const config=loadConfig({NEXA_DATA_DIR:dataDir,NEXA_MODE:'keyword',NEXA_ADMIN_KEY:'synthetic-scale-smoke-key-only'});
const store=new Store(dbPath),kb=new KnowledgeBase(store,config);
let server:ReturnType<typeof Bun.serve>|undefined;
let report:Record<string,unknown>={status:'running',dataDir};
const started=performance.now();
try {
  const project=kb.addProject('Synthetic scale fixture');
  const source:Source={id:crypto.randomUUID(),name:'Generated small text',kind:'folder',path:join(dataDir,'synthetic-source'),board:'SYNTHETIC',revision:'',status:'ready'};
  store.addSource(source);kb.saveConnection(source.id,{projectId:project.id,role:'spec',paused:true});
  const module=kb.addModule(project.id,{name:'Synthetic documents',rules:[{sourceId:source.id,pattern:'docs/**',role:'spec'}]});
  const versions:SoftwareVersion[]=[],shared:SnapshotFile[]=[];
  const uniqueRaw=new Map<string,number>();let sharedBytes=0,changedBytes=0;
  const encoder=new TextEncoder(),pad=(n:number)=>String(n).padStart(6,'0');
  function fixture(path:string,marker:string,value:number):SnapshotFile {
    const text=`${marker}\nSynthetic UART specification ${value}. Baud is 115200. Timeout is 20 ms.\n`;
    const bytes=encoder.encode(text),title=path.split('/').at(-1)!;
    const content=kb.putParsed(bytes,{title,text,chunks:[{text,startLine:1,endLine:2}],warnings:[]},'synthetic-scale-fixture-v1',title);
    uniqueRaw.set(content.rawHash,bytes.length);
    return {path,...content,moduleId:module.id,role:'spec'};
  }
  for(let i=0;i<sharedCount;i++) {
    const file=fixture(`docs/common-${pad(i)}.md`,`SCALE_COMMON_${pad(i)}`,i);
    shared.push(file);sharedBytes+=uniqueRaw.get(file.rawHash)!;
  }
  const snapshotTimes:number[]=[];
  for(let v=0;v<versionCount;v++) {
    const before=performance.now(),files=[...shared];
    for(let i=0;i<changedCount;i++) {
      const file=fixture(`docs/changing-${pad(i)}.md`,`SCALE_VERSION_${pad(v)}_${pad(i)}`,v*changedCount+i);
      files.push(file);changedBytes+=uniqueRaw.get(file.rawHash)!;
    }
    const snapshot=kb.createSnapshot(source,files,{errors:[],excluded:[]});
    versions.push(kb.saveVersion({projectId:project.id,name:`synthetic-v${pad(v)}`,snapshots:{[source.id]:snapshot.id}}));
    snapshotTimes.push(performance.now()-before);
    if((v+1)%5===0||v===versionCount-1)console.log(JSON.stringify({stage:'snapshots',completed:v+1,total:versionCount,elapsedMs:Math.round(performance.now()-started)}));
  }
  // Exercise retention after 30 snapshots; every version must retain its original files.
  kb.activate(source.id,Object.values(versions.at(-1)!.snapshots)[0]!);
  const buildMs=performance.now()-started;
  const scalar=(sql:string)=>(kb.db.query(sql).get() as {n:number}).n;
  const counts={versions:scalar('SELECT count(*) n FROM kb_versions'),snapshots:scalar('SELECT count(*) n FROM kb_snapshots'),fileOccurrences:scalar('SELECT count(*) n FROM kb_files'),parsedContents:scalar('SELECT count(*) n FROM kb_parsed'),chunks:scalar('SELECT count(*) n FROM kb_chunks'),ftsRows:scalar('SELECT count(*) n FROM kb_fts'),rawObjects:readdirSync(kb.blobDir).length};
  const expectedUnique=sharedCount+versionCount*changedCount;
  assert.equal(counts.versions,versionCount);assert.equal(counts.snapshots,versionCount);
  assert.equal(counts.fileOccurrences,versionCount*filesPerVersion);
  for(const n of [counts.parsedContents,counts.chunks,counts.ftsRows,counts.rawObjects,uniqueRaw.size])assert.equal(n,expectedUnique);
  assert.equal(scalar("SELECT count(DISTINCT parsedKey) n FROM kb_files WHERE path LIKE 'docs/common-%'"),sharedCount);
  for(const version of versions)assert.equal(kb.scopeInfo({query:'UART',projectId:project.id,versionId:version.id,moduleId:module.id}).coverage.documents,filesPerVersion);

  // Five real concurrent loopback requests enter one SQLite-owning process, like the API.
  // Synchronous SQL still runs serially on that process; this is not five database workers.
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if(request.method!=='POST'||new URL(request.url).pathname!=='/lexical')return new Response('Not found',{status:404});
    const input=await request.json() as {query:string;versionId:string};
    if(!versions.some(v=>v.id===input.versionId))return new Response('Invalid fixture version',{status:400});
    const began=performance.now();
    const hits=kb.lexical({query:input.query,projectId:project.id,versionId:input.versionId,moduleId:module.id,role:'spec'},5);
    return Response.json({hits,sqlAndHydrationMs:performance.now()-began});
  }});
  const queryBatchStarted=performance.now();
  const queries=await Promise.all(Array.from({length:5},async(_,i)=>{
    const index=Math.floor(i*(versionCount-1)/4),version=versions[index]!,marker=`SCALE_VERSION_${pad(index)}`;
    const before=performance.now();
    const response=await fetch(`http://127.0.0.1:${server!.port}/lexical`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:marker,versionId:version.id})});
    assert.equal(response.status,200);
    const result=await response.json() as {hits:Hit[];sqlAndHydrationMs:number};
    assert.equal(result.hits.length,Math.min(5,changedCount));
    for(const hit of result.hits){assert.equal(hit.versionId,version.id);assert.equal(hit.moduleId,module.id);assert.equal(hit.role,'spec');assert.ok(hit.text.includes(marker+'_'));assert.ok(hit.documentId);}
    return {versionName:version.name,hits:result.hits.length,elapsedMs:performance.now()-before,sqlAndHydrationMs:result.sqlAndHydrationMs};
  }));
  const queryBatchMs=performance.now()-queryBatchStarted;
  await server.stop(true);server=undefined;
  const commonHits=kb.lexical({query:'SCALE_COMMON_000000',projectId:project.id,versionId:versions[0]!.id},5);
  assert.equal(commonHits.length,1);assert.ok(commonHits[0]!.text.includes('SCALE_COMMON_000000'));
  const wrongVersion=versionCount>1?kb.lexical({query:`SCALE_VERSION_${pad(versionCount-1)}`,projectId:project.id,versionId:versions[0]!.id},5):[];
  assert.equal(wrongVersion.length,0);
  kb.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const rawLogicalBytes=readdirSync(kb.blobDir).reduce((n,file)=>n+statSync(join(kb.blobDir,file)).size,0);
  assert.equal(rawLogicalBytes,[...uniqueRaw.values()].reduce((a,b)=>a+b,0));
  const unsharedRawLogicalBytes=sharedBytes*versionCount+changedBytes;
  report={status:'passed',kind:'synthetic-metadata-fts-content-sharing',createdAt:new Date().toISOString(),dataDir,reportPath,
    environment:{bun:Bun.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},
    fixture:{versionCount,filesPerVersion,totalFileOccurrences:versionCount*filesPerVersion,sharedFilesPerVersion:sharedCount,changedFilesPerVersion:changedCount,sharedFractionPerVersion:0.95,expectedUniqueContents:expectedUnique,generatedTextOnly:true},
    counts,storage:{rawLogicalBytes,unsharedRawLogicalBytes,rawLogicalBytesSaved:unsharedRawLogicalBytes-rawLogicalBytes,rawLogicalSavingFraction:1-rawLogicalBytes/unsharedRawLogicalBytes,databaseBytes:statSync(dbPath).size,walBytes:existsSync(dbPath+'-wal')?statSync(dbPath+'-wal').size:0},
    timing:{buildMs,snapshotTimesMs:snapshotTimes,concurrentLexicalRequests:5,queryBatchMs,queries,totalMs:performance.now()-started},
    checks:{retainsAllConfirmedVersions:true,sharesRawParsedAndFtsContent:true,versionAndModuleScope:true,wrongVersionExcluded:true},
    limitations:['Synthetic small text and directly supplied parsed chunks; no source IO or parser benchmark.','No embeddings, vector database, LLM, Git remote, watcher, or full application indexing.','Five concurrent local HTTP callers share synchronous SQLite in one process.','One run with five selective queries is not a throughput SLA, realistic user load, or full production performance test.','Raw byte figures are logical file sizes; filesystem allocation and application backup size are not measured.'],
    retained:'Temporary fixtures and report remain available for inspection; user data was never opened.'};
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  report={...report,status:'failed',dataDir,reportPath,elapsedMs:performance.now()-started,error:error instanceof Error?error.message:String(error)};
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  throw error;
} finally {
  if(server)await server.stop(true);
  store.close();
}
