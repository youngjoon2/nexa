import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../src/storage';
import {loadConfig} from '../src/config';
import {createApplication} from '../src/app';

test('legacy migration backs up the old database and requires real source sync for original bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'nexa-migration-')),dataDir=join(root,'data'),folder=join(root,'specs');
  await mkdir(dataDir);await mkdir(folder);
  const bytes=new TextEncoder().encode('# UART\nREAL_SOURCE 115200\n');await writeFile(join(folder,'uart.md'),bytes);
  const legacy=new Store(join(dataDir,'nexa.sqlite'));
  legacy.addSource({id:'legacy',kind:'folder',path:folder,name:'Legacy specs',board:'',revision:'',status:'ready'});
  const doc={id:'old-doc',sourceId:'legacy',path:join(folder,'uart.md'),title:'UART',text:'OLD_EXTRACTED 9600',hash:'old-hash',embedded:0,board:'',revision:''};
  legacy.replaceDocument(doc,[{...doc,id:'old-chunk',documentId:doc.id,startLine:1,endLine:1}]);legacy.close();
  const config=loadConfig({NEXA_DATA_DIR:dataDir,NEXA_MODE:'keyword',NEXA_ADMIN_KEY:crypto.randomUUID()},resolve(import.meta.dir,'..'));
  const runtime=createApplication(config,{resume:false});
  try {
    const backups=await readdir(join(dataDir,'backups'));expect(backups).toHaveLength(1);
    const backup=new Database(join(dataDir,'backups',backups[0]!),{readonly:true});
    try {expect((backup.query('SELECT count(*) n FROM documents').get() as any).n).toBe(1);expect(backup.query("SELECT name FROM sqlite_master WHERE name='kb_projects'").get()).toBeNull();}finally{backup.close();}
    const kb=runtime.knowledge,oldId=kb.connection('legacy').snapshotId!;
    expect(kb.snapshot(oldId)?.legacy).toBe(true);expect(kb.versions('default')).toHaveLength(0);expect(kb.lexical({query:'OLD_EXTRACTED'})).toHaveLength(1);
    expect(()=>kb.saveVersion({projectId:'default',name:'not-original-bytes',snapshots:{legacy:oldId}})).toThrow('원문');
    expect(kb.pendingEmbeddings()).toBe(0);
    runtime.indexer.enqueue('legacy');const deadline=Date.now()+10000;
    while(runtime.indexer.state().running||runtime.indexer.state().queued){if(Date.now()>deadline)throw new Error('Migration resync timeout');await Bun.sleep(10);}
    const current=kb.connection('legacy').snapshotId!;expect(current).not.toBe(oldId);expect(kb.snapshot(current)?.legacy).toBeUndefined();
    expect(kb.lexical({query:'REAL_SOURCE'})).toHaveLength(1);expect(kb.lexical({query:'OLD_EXTRACTED'})).toHaveLength(0);
    expect(kb.raw(kb.snapshotFiles(current)[0]!.rawHash)).toEqual(bytes);
    expect(kb.pendingEmbeddings()).toBe(1);
    expect(await readdir(join(dataDir,'backups'))).toHaveLength(1);
  } finally {runtime.indexer.stop();runtime.analyses.stop();runtime.store.close();await rm(root,{recursive:true,force:true});}
});
