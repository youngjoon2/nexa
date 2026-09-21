export type Source = {
  id: string; name: string; kind: 'folder' | 'upload' | 'git'; path: string;
  board: string; revision: string; status: string; lastIndexedAt?: string;
  lastError?: string; documentCount?: number; chunkCount?: number;
  projectId?: string; role?: 'code'|'spec'|'reference'; paused?: boolean;
  lastCheckedAt?: string; errors?: string[]; snapshotId?: string;
  git?: {url:string;branch:string;tagPattern?:string};
};
export type Job = {
  id: string; sourceId: string; status: 'queued'|'running'|'completed'|'failed';
  processed: number; total: number; message: string; errors: string[];
  createdAt: string; finishedAt?: string;
  kind?: 'index'|'version'; projectId?: string; versionId?: string;
};
export type Document = {
  id: string; sourceId: string; path: string; title: string; text: string;
  hash: string; embedded: number; board: string; revision: string;
  projectId?:string; snapshotId?:string; moduleId?:string; role?:'code'|'spec'|'reference';
};
export type Chunk = {
  id: string; documentId: string; sourceId: string; title: string; text: string;
  path: string; board: string; revision: string; startLine?: number; endLine?: number; page?: number;
  projectId?:string; snapshotId?:string; versionId?:string; moduleId?:string; role?:'code'|'spec'|'reference';
  headingPath?:string[]; blockId?:string; table?:number; symbol?:string;
};
export type Hit = Chunk & {score: number; channels: string[]};
export type SearchInput = {query: string; board?: string; revision?: string; limit?: number; projectId?:string;versionId?:string;moduleId?:string;role?:'code'|'spec'|'reference'};
export type SearchResult = {hits: Hit[]; mode: 'hybrid'|'keyword'; warnings: string[]};
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
