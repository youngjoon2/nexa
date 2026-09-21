import type {Hono} from '../vendor/hono/src/index';
import {AppError,type Source} from './types';
import type {KnowledgeBase} from './knowledge';
import type {Indexer} from './indexer';
import type {Providers} from './providers';
import type {Config} from './config';
import {AnalysisManager,planQuery} from './analysis';
import {askKnowledge} from './knowledge-retrieval';
import {validateGitSettings,gitCachePath} from './connectors';

export function mountKnowledgeAPI(app:Hono,services:{knowledge:KnowledgeBase;indexer:Indexer;analyses:AnalysisManager;providers:Providers;config:Config;json:(c:any)=>Promise<any>}) {
  const {knowledge:kb,indexer,analyses,providers,config,json}=services;
  const source=(id:string)=>{const s=kb.source(id);if(!s)throw new AppError('NOT_FOUND','자료 연결을 찾을 수 없습니다.',404);return s;};
  app.get('/api/v1/projects',c=>c.json({projects:kb.projects()}));
  app.post('/api/v1/projects',async c=>c.json({project:kb.addProject((await json(c))?.name)},201));
  app.get('/api/v1/projects/:id/modules',c=>{kb.requireProject(c.req.param('id'));return c.json({modules:kb.modules(c.req.param('id'))});});
  app.post('/api/v1/projects/:id/modules',async c=>{const m=kb.addModule(c.req.param('id'),await json(c));for(const s of kb.sources().filter(s=>s.projectId===m.projectId))indexer.requestAuto(s.id);return c.json({module:m},201);});
  app.post('/api/v1/projects/:id/modules/:moduleId',async c=>{const m=kb.addModule(c.req.param('id'),await json(c),c.req.param('moduleId'));for(const s of kb.sources().filter(s=>s.projectId===m.projectId))indexer.requestAuto(s.id);return c.json({module:m});});
  app.get('/api/v1/projects/:id/versions',c=>{const id=c.req.param('id');kb.requireProject(id);return c.json({versions:kb.versions(id),candidates:kb.candidates(id)});});
  app.post('/api/v1/projects/:id/versions',async c=>{const body=await json(c);if(body?.sourceIds!==undefined&&(!Array.isArray(body.sourceIds)||body.sourceIds.some((x:any)=>typeof x!=='string')))throw new AppError('INVALID_SOURCES','자료 ID 목록을 확인하세요.');if(body?.snapshots!==undefined&&(!body.snapshots||typeof body.snapshots!=='object'||Array.isArray(body.snapshots)||Object.values(body.snapshots).some(x=>typeof x!=='string')))throw new AppError('INVALID_SNAPSHOT','스냅샷 선택을 확인하세요.');return c.json({job:indexer.enqueueVersion({...body,projectId:c.req.param('id')})},202);});
  app.get('/api/v1/versions/:id',c=>{const v=kb.version(c.req.param('id'));if(!v)throw new AppError('NOT_FOUND','SW 버전을 찾을 수 없습니다.',404);return c.json({version:v,documents:Object.values(v.snapshots).flatMap(id=>kb.snapshotFiles(id).map(f=>({id:f.id,path:f.path,sourceId:f.sourceId,moduleId:f.moduleId,role:f.role,snapshotId:id})))});});
  app.delete('/api/v1/versions/:id',c=>{const id=c.req.param('id');if(indexer.versionBusy(id)||analyses.list().some(j=>['queued','running'].includes(j.status)&&j.versionIds.includes(id)))throw new AppError('VERSION_BUSY','이 버전을 사용하는 색인·보존·분석 작업이 끝난 뒤 삭제하세요.',409);kb.deleteVersion(id);return c.json({deleted:true});});
  app.post('/api/v1/versions/:id/reindex',c=>c.json({job:indexer.enqueueVersionReindex(c.req.param('id'))},202));
  app.post('/api/v1/sources/git',async c=>{
    const body=await json(c),git=validateGitSettings({url:body?.url,branch:body?.branch||'main',tagPattern:body?.tagPattern});
    const projectId=body?.projectId||'default';kb.requireProject(projectId);
    if(kb.sources().some(s=>s.projectId===projectId&&s.git?.url===git.url&&s.git?.branch===git.branch))throw new AppError('DUPLICATE_SOURCE','같은 저장소·브랜치가 이미 연결되어 있습니다.',409);
    const id=crypto.randomUUID(),fallbackName=git.url.split('/').at(-1)!.replace(/\.git$/,'');
    const rawName=body?.name??'';
    if(typeof rawName!=='string'||rawName.length>120||/[\x00-\x1f]/.test(rawName))throw new AppError('INVALID_FIELD','자료 이름을 확인하세요.');
    const name=rawName.trim()||fallbackName;
    const s:Source={id,name,kind:'git',path:gitCachePath(config.dataDir,id),board:'',revision:'',status:'queued'};
    const role=kb.role(body?.role||'code');
    const job=kb.db.transaction(()=>{
      kb.store.addSource(s);kb.saveConnection(id,{projectId,role,git});
      return indexer.enqueue(id);
    })();
    return c.json({source:kb.source(id),job},201);
  });
  for(const action of ['sync','retry'])app.post(`/api/v1/sources/:id/${action}`,c=>{source(c.req.param('id'));return c.json({job:indexer.enqueue(c.req.param('id'))},202);});
  app.post('/api/v1/sources/:id/settings',async c=>{
    const s=source(c.req.param('id')),body=await json(c);if(body?.paused!==undefined&&typeof body.paused!=='boolean')throw new AppError('INVALID_FIELD','일시정지 상태를 확인하세요.');
    if(body?.documentLinks!==undefined){if(!body.documentLinks||Array.isArray(body.documentLinks)||typeof body.documentLinks!=='object'||Object.entries(body.documentLinks).some(([p,v])=>typeof v!=='string'||p.length>1024||v.length>1024||/[\x00-\x1f]/.test(p+v)))throw new AppError('INVALID_LINKS','현재 경로와 이전 문서 경로의 연결을 확인하세요.');}
    const settings=kb.saveConnection(s.id,{...(body?.paused!==undefined?{paused:body.paused}:{}),...(body?.role?{role:kb.role(body.role)}:{}),...(body?.documentLinks?{documentLinks:body.documentLinks}:{})});
    if(!settings.paused)indexer.requestAuto(s.id);return c.json({source:kb.source(s.id)});
  });
  app.get('/api/v1/sources/:id/preview',c=>{source(c.req.param('id'));return c.json(kb.preview(c.req.param('id')));});
  app.post('/api/v1/sources/:id/candidates',async c=>{source(c.req.param('id'));return c.json({candidate:kb.proposeTag(c.req.param('id'),(await json(c))?.tag)},201);});
  app.get('/api/v1/analyses',c=>c.json({jobs:analyses.list(c.req.query('projectId'))}));
  app.get('/api/v1/analyses/:id',c=>{const job=analyses.get(c.req.param('id'));if(!job)throw new AppError('NOT_FOUND','분석 작업을 찾을 수 없습니다.',404);return c.json({job});});
  app.post('/api/v1/analyses/:id/cancel',c=>c.json({job:analyses.cancel(c.req.param('id'))}));
  app.post('/api/v1/query',async c=>{
    const body=await json(c),plan=await planQuery(kb,providers,body);
    if('clarification' in plan)return c.json({type:'clarification',...plan.clarification});
    if(plan.mode==='general')return c.json({type:'answer',...await askKnowledge(kb,providers,{query:plan.query,projectId:plan.projectId,versionId:plan.versionIds[0],moduleId:plan.moduleId,board:body.board,revision:body.revision})});
    return c.json({type:'analysis',job:analyses.enqueue({...plan,mode:plan.mode})},202);
  });
}
