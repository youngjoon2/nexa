import {Hono} from '../vendor/hono/src/index';
import {bodyLimit} from '../vendor/hono/src/middleware/body-limit';
import {timingSafeEqual} from 'node:crypto';
import {basename, isAbsolute, join, resolve} from 'node:path';
import {lstat, mkdir, realpath, rm} from 'node:fs/promises';
import type {Config} from './config';
import {Store} from './storage';
import {Providers} from './providers';
import {Indexer, inside} from './indexer';
import {ask, search, validateSearch} from './retrieval';
import {AppError, type Source} from './types';
import {isSupportedFile} from './ingestion';
import {KnowledgeBase} from './knowledge';
import {searchKnowledge,askKnowledge} from './knowledge-retrieval';
import {AnalysisManager} from './analysis';
import {mountKnowledgeAPI} from './knowledge-api';

function equalKey(actual:string,expected:string) {
  const a=Buffer.from(actual),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function field(value:unknown,name:string,fallback='') {
  if(value===undefined||value===null||value==='')return fallback;
  if(typeof value!=='string'||value.length>120||/[\x00-\x1f]/.test(value))throw new AppError('INVALID_FIELD',`${name}은 120자 이하의 문자열이어야 합니다.`);
  return value.trim();
}
async function json(c:any) {
  if(!c.req.header('content-type')?.includes('application/json'))throw new AppError('CONTENT_TYPE','application/json 본문이 필요합니다.',415);
  try{return await c.req.json();}catch{throw new AppError('INVALID_JSON','JSON 형식을 확인하세요.');}
}

export function createApplication(config:Config,options:{providers?:Providers;resume?:boolean}={}) {
  const store=new Store(join(config.dataDir,'nexa.sqlite'));
  const providers=options.providers||new Providers(config);
  const knowledge=new KnowledgeBase(store,config);
  const indexer=new Indexer(store,providers,config,knowledge);
  const analyses=new AnalysisManager(knowledge,providers);
  const app=new Hono();
  app.onError((error,c)=>{
    if(error instanceof AppError)return c.json({error:{code:error.code,message:error.message}},error.status as any);
    console.error('[nexa]',error.name,error.message);
    return c.json({error:{code:'INTERNAL_ERROR',message:'요청 처리 중 오류가 발생했습니다. 서버 로그를 확인하세요.'}},500);
  });
  app.use('*',async(c,next)=>{
    c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');
    c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    await next();
  });
  app.use('/api/*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    const origin=c.req.header('origin');
    if(origin) {
      const own=new URL(c.req.url).origin;
      if(origin!==own&&!config.allowedOrigins.includes(origin))throw new AppError('ORIGIN_DENIED','허용되지 않은 웹 클라이언트 주소입니다.',403);
      c.header('Access-Control-Allow-Origin',origin);c.header('Vary','Origin');
      c.header('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers','Content-Type, Authorization, X-Nexa-Admin-Key');
    }
    if(c.req.method==='OPTIONS')return c.body(null,204);
    if(config.apiKey&&!equalKey((c.req.header('authorization')||'').replace(/^Bearer /,''),config.apiKey))
      throw new AppError('UNAUTHORIZED','연결 설정에 API 키를 입력하세요.',401);
    const mutation=['POST','DELETE'].includes(c.req.method)&&/^\/api\/v1\/(sources|projects|versions)(\/|$)/.test(c.req.path);
    if(mutation&&!equalKey(c.req.header('x-nexa-admin-key')||'',config.adminKey))
      throw new AppError('ADMIN_REQUIRED','자료 관리에는 관리자 키가 필요합니다. 연결 설정에 입력하세요.',403);
    await next();
  });
  app.use('/api/*',async(c,next)=>bodyLimit({maxSize:c.req.path==='/api/v1/sources/upload'?config.maxUploadBytes:64*1024,
    onError:()=>{throw new AppError('BODY_TOO_LARGE','요청 크기 제한을 초과했습니다.',413);}})(c,next));
  app.get('/api/v1/health',async c=>{
    const services=await providers.health();
    return c.json({status:Object.values(services).every(x=>x.ok)?'ok':'degraded',services,counts:store.counts(),queue:indexer.state(),generationQueue:{queued:providers.generationGate.waiting,running:providers.generationGate.running},mode:config.mode,pendingEmbeddings:knowledge.pendingEmbeddings(),analysisQueue:analyses.state()});
  });
  app.get('/api/v1/meta',c=>c.json({...store.meta(),auth:{required:!!config.apiKey,adminConfigured:!!config.adminKey}}));
  app.get('/api/v1/sources',c=>c.json({sources:knowledge.sources()}));
  app.get('/api/v1/jobs',c=>c.json({jobs:indexer.jobs().map(({request,...job}:any)=>job)}));
  app.get('/api/v1/documents/:id',c=>{
    const doc=knowledge.document(c.req.param('id'))||store.document(c.req.param('id'));if(!doc)throw new AppError('NOT_FOUND','문서를 찾을 수 없습니다.',404);
    const {hash,embedded,...publicDoc}=doc;
    return c.json(publicDoc);
  });
  app.post('/api/v1/search',async c=>c.json(await searchKnowledge(knowledge,providers,validateSearch(await json(c)))));
  app.post('/api/v1/ask',async c=>c.json(await askKnowledge(knowledge,providers,validateSearch(await json(c)))));
  mountKnowledgeAPI(app,{knowledge,indexer,analyses,providers,config,json});
  app.post('/api/v1/sources/folder',async c=>{
    const body=await json(c);
    const projectId=field(body?.projectId,'프로젝트','default');knowledge.requireProject(projectId);const role=knowledge.role(body?.role);
    if(typeof body?.path!=='string'||!isAbsolute(body.path)||body.path.length>1024)throw new AppError('INVALID_PATH','서버에 있는 폴더의 절대 경로를 입력하세요.');
    let path:string;
    try{
      const stat=await lstat(body.path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error();
      path=await realpath(body.path);
    }catch{throw new AppError('INVALID_PATH','읽을 수 있는 일반 폴더가 필요합니다. 링크·junction은 등록할 수 없습니다.');}
    if([config.dataDir,join(config.root,'.runtime'),join(config.root,'.models'),join(config.root,'vendor')].some(root=>inside(root,path)))
      throw new AppError('PROTECTED_PATH','Nexa 내부 저장 폴더는 등록할 수 없습니다.');
    if(store.sources().some(s=>resolve(s.path).toLowerCase()===resolve(path).toLowerCase()))throw new AppError('DUPLICATE_SOURCE','이미 등록한 폴더입니다.',409);
    if(indexer.state().queued>=100)throw new AppError('INDEX_QUEUE_FULL','색인 대기열이 가득 찼습니다.',429);
    const source:Source={id:crypto.randomUUID(),name:field(body.name,'소스 이름',basename(path)),kind:'folder',path,board:field(body.board,'보드'),revision:field(body.revision,'리비전'),status:'queued'};
    store.addSource(source);
    knowledge.saveConnection(source.id,{projectId,role});
    return c.json({source,job:indexer.enqueue(source.id)},201);
  });
  app.post('/api/v1/sources/upload',async c=>{
    let form:FormData;
    try{form=await c.req.formData();}catch{throw new AppError('INVALID_MULTIPART','파일 업로드 형식을 확인하세요.');}
    const files=form.getAll('files');
    const projectId=field(form.get('projectId'),'프로젝트','default');knowledge.requireProject(projectId);const role=knowledge.role(form.get('role')||undefined);
    if(!files.length||files.length>100||files.some(f=>!(f instanceof File)))throw new AppError('INVALID_FILES','files 필드에 1~100개의 파일을 첨부하세요.');
    for(const f of files as File[]) {
      if(f.size>config.maxFileBytes)throw new AppError('FILE_TOO_LARGE',`${f.name}: 파일당 20 MiB까지 업로드할 수 있습니다.`,413);
      if(!f.size||!isSupportedFile(f.name))throw new AppError('UNSUPPORTED_FILE',`${f.name}: 지원하지 않거나 비어 있는 파일입니다.`);
      if(f.name.length>160||/[\\/:*?"<>|\x00-\x1f]/.test(f.name)||/[. ]$/.test(f.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(f.name))
        throw new AppError('INVALID_FILENAME','경로나 Windows 예약 이름이 포함된 파일 이름은 사용할 수 없습니다.');
    }
    if(indexer.state().queued>=100)throw new AppError('INDEX_QUEUE_FULL','색인 대기열이 가득 찼습니다.',429);
    const id=crypto.randomUUID();const path=join(config.dataDir,'uploads',id);
    const source:Source={id,name:field(form.get('name'),'소스 이름',(files[0] as File).name.slice(0,110)+(files.length>1?` 외 ${files.length-1}개`:'')),kind:'upload',path,board:field(form.get('board'),'보드'),revision:field(form.get('revision'),'리비전'),status:'queued'};
    await mkdir(path,{recursive:true});
    try {
      for(const [i,f] of (files as File[]).entries())await Bun.write(join(path,String(i+1).padStart(3,'0')+'-'+f.name),f);
      store.addSource(source);
      knowledge.saveConnection(source.id,{projectId,role});
    }catch(error){await rm(path,{recursive:true,force:true});throw error;}
    return c.json({source,job:indexer.enqueue(id)},201);
  });
  app.post('/api/v1/sources/:id/reindex',c=>{
    const source=store.source(c.req.param('id'));if(!source)throw new AppError('NOT_FOUND','소스를 찾을 수 없습니다.',404);
    return c.json({job:indexer.enqueue(source.id)},202);
  });
  app.delete('/api/v1/sources/:id',async c=>{
    const source=store.source(c.req.param('id'));if(!source)throw new AppError('NOT_FOUND','소스를 찾을 수 없습니다.',404);
    if(indexer.busy(source.id))throw new AppError('SOURCE_BUSY','색인 작업이 끝난 뒤 삭제하세요.',409);
    store.removeSource(source.id);
    knowledge.removeConnection(source.id);
    if(source.kind==='upload') {
      const expected=join(config.dataDir,'uploads',source.id);
      if(resolve(source.path)===resolve(expected)&&inside(join(config.dataDir,'uploads'),expected))
        await rm(expected,{recursive:true,force:true});
    }
    void indexer.flushDeletes();
    return c.json({deleted:true});
  });
  for(const path of ['/','/index.html','/styles.css','/app.js','/knowledge.js']) {
    app.get(path,async c=>{
      const file=Bun.file(join(config.root,'web',path==='/'?'index.html':path.slice(1)));
      if(!await file.exists())throw new AppError('NOT_FOUND','웹 파일이 없습니다.',404);
      return new Response(file,{headers:{'Content-Type':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'}});
    });
  }
  app.notFound(c=>c.json({error:{code:'NOT_FOUND',message:'요청 경로를 찾을 수 없습니다.'}},404));
  if(options.resume!==false){indexer.resume();analyses.resume();}
  return {app,store,providers,indexer,knowledge,analyses};
}
