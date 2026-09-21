import {Database} from 'bun:sqlite';
import type {Source, Document, Chunk, Job, SearchInput, Hit} from './types';

export function lexicalQuery(query: string): string {
  const words = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].slice(0, 24);
  return words.filter(w=>w.length > 1 || /^[A-Za-z0-9]$/.test(w)).map(w=>'"'+w+'"*').join(' OR ');
}

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, {create:true, strict:true});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL UNIQUE,board TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,lastIndexedAt TEXT,lastError TEXT);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,path TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,embedded INTEGER NOT NULL DEFAULT 0,board TEXT NOT NULL,revision TEXT NOT NULL,UNIQUE(sourceId,path));
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,sourceId TEXT NOT NULL,text TEXT NOT NULL,title TEXT NOT NULL,path TEXT NOT NULL,board TEXT NOT NULL,revision TEXT NOT NULL,startLine INTEGER,endLine INTEGER,page INTEGER);
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(documentId);
      CREATE INDEX IF NOT EXISTS chunks_source ON chunks(sourceId);
      CREATE INDEX IF NOT EXISTS docs_source ON documents(sourceId);
      CREATE INDEX IF NOT EXISTS chunks_metadata ON chunks(board,revision);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,title,text,tokenize='unicode61 tokenchars _');
      CREATE TRIGGER IF NOT EXISTS chunk_insert AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,id,title,text) VALUES(new.rowid,new.id,new.title,new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunk_delete AFTER DELETE ON chunks BEGIN DELETE FROM chunks_fts WHERE rowid=old.rowid; END;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vector_deletes(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  sources(): Source[] {
    return this.db.query(`SELECT s.*, (SELECT count(*) FROM documents d WHERE d.sourceId=s.id) documentCount,
      (SELECT count(*) FROM chunks c WHERE c.sourceId=s.id) chunkCount FROM sources s ORDER BY name`).all() as Source[];
  }
  source(id: string) { return this.db.query('SELECT * FROM sources WHERE id=?').get(id) as Source | null; }
  addSource(source: Source) {
    this.db.query('INSERT INTO sources(id,name,kind,path,board,revision,status) VALUES(?,?,?,?,?,?,?)')
      .run(source.id,source.name,source.kind,source.path,source.board,source.revision,source.status);
  }
  updateSource(id: string, status: string, error = '', indexed?: string) {
    this.db.query('UPDATE sources SET status=?,lastError=?,lastIndexedAt=coalesce(?,lastIndexedAt) WHERE id=?').run(status,error,indexed||null,id);
  }
  documents(sourceId: string) { return this.db.query('SELECT id,sourceId,path,hash,embedded FROM documents WHERE sourceId=?').all(sourceId) as Document[]; }
  document(id: string) { return this.db.query('SELECT * FROM documents WHERE id=?').get(id) as Document | null; }
  chunks(documentId: string) { return this.db.query('SELECT * FROM chunks WHERE documentId=? ORDER BY rowid').all(documentId) as Chunk[]; }
  replaceDocument(doc: Document, chunks: Chunk[]) {
    this.db.transaction(()=> {
      this.removeDocument(doc.id);
      this.db.query('INSERT INTO documents(id,sourceId,path,title,text,hash,embedded,board,revision) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(doc.id,doc.sourceId,doc.path,doc.title,doc.text,doc.hash,doc.embedded,doc.board,doc.revision);
      const insert = this.db.query('INSERT INTO chunks(id,documentId,sourceId,text,title,path,board,revision,startLine,endLine,page) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const c of chunks) insert.run(c.id,c.documentId,c.sourceId,c.text,c.title,c.path,c.board,c.revision,c.startLine??null,c.endLine??null,c.page??null);
      // Identical document retries may reuse current point IDs: never delete the active version.
      const keep = this.db.query('DELETE FROM vector_deletes WHERE id=?');
      for (const c of chunks) keep.run(c.id);
    })();
  }
  removeDocument(id: string) {
    this.db.transaction(()=> {
      this.db.query('INSERT OR IGNORE INTO vector_deletes SELECT id FROM chunks WHERE documentId=?').run(id);
      this.db.query('DELETE FROM documents WHERE id=?').run(id);
    })();
  }
  removeSource(id: string) {
    this.db.transaction(()=> {
      this.db.query('INSERT OR IGNORE INTO vector_deletes SELECT id FROM chunks WHERE sourceId=?').run(id);
      this.db.query('DELETE FROM sources WHERE id=?').run(id);
      this.db.query('DELETE FROM jobs WHERE sourceId=?').run(id);
    })();
  }
  removeSourceDocuments(sourceId: string) {
    this.db.transaction(()=>{
      this.db.query('INSERT OR IGNORE INTO vector_deletes SELECT id FROM chunks WHERE sourceId=?').run(sourceId);
      this.db.query('DELETE FROM documents WHERE sourceId=?').run(sourceId);
    })();
  }
  markEmbedded(id: string) {this.db.query('UPDATE documents SET embedded=1 WHERE id=?').run(id);}
  resetEmbedded() {this.db.exec('UPDATE documents SET embedded=0');}
  pendingEmbeddings() {return (this.db.query('SELECT count(*) n FROM documents WHERE embedded=0').get() as any).n as number;}
  pendingDeletes() {return this.db.query('SELECT id FROM vector_deletes LIMIT 256').all() as {id:string}[];}
  acknowledgeDeletes(ids: string[]) { const q=this.db.query('DELETE FROM vector_deletes WHERE id=?'); this.db.transaction(()=>ids.forEach(id=>q.run(id)))(); }
  saveJob(job: Job) {this.db.query('INSERT OR REPLACE INTO jobs(id,sourceId,data) VALUES(?,?,?)').run(job.id,job.sourceId,JSON.stringify(job));}
  jobs(): Job[] {return this.db.query('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 200').all().map((x:any)=>JSON.parse(x.data));}
  pendingJobs(): Job[] {return this.db.query("SELECT data FROM jobs WHERE json_extract(data,'$.status') IN ('queued','running') ORDER BY rowid").all().map((x:any)=>JSON.parse(x.data));}
  counts() {
    return this.db.query('SELECT (SELECT count(*) FROM sources) sources,(SELECT count(*) FROM documents) documents,(SELECT count(*) FROM chunks) chunks').get() as {sources:number;documents:number;chunks:number};
  }
  meta() {
    return {boards:this.db.query("SELECT DISTINCT board FROM sources WHERE board<>'' ORDER BY board").all().map((x:any)=>x.board),
      revisions:this.db.query("SELECT DISTINCT revision FROM sources WHERE revision<>'' ORDER BY revision").all().map((x:any)=>x.revision)};
  }
  lexical(input: SearchInput, limit=40): Hit[] {
    const match=lexicalQuery(input.query); if (!match) return [];
    const where = ['chunks_fts MATCH ?']; const args:any[]=[match];
    if (input.board) {where.push('c.board=?');args.push(input.board);}
    if (input.revision) {where.push('c.revision=?');args.push(input.revision);}
    args.push(limit);
    return this.db.query(`SELECT c.*, bm25(chunks_fts,0,3,1) lexicalRank FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id WHERE ${where.join(' AND ')} ORDER BY lexicalRank LIMIT ?`).all(...args)
      .map((x:any)=>({...x,score:-x.lexicalRank,channels:['keyword']}));
  }
  hydrate(ids: string[], input: SearchInput): Chunk[] {
    if(!ids.length) return [];
    const conditions=[`id IN (${ids.map(()=>'?').join(',')})`];const args:any[]=[...ids];
    if(input.board){conditions.push('board=?');args.push(input.board);}
    if(input.revision){conditions.push('revision=?');args.push(input.revision);}
    return this.db.query('SELECT * FROM chunks WHERE '+conditions.join(' AND ')).all(...args) as Chunk[];
  }
}
