import type {Config} from './config';
import {AppError, type Chunk, type SearchInput} from './types';

/** One request at a time per llama slot; bounded waiting prevents unbounded team load. */
export class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();
  waiting=0; running=0;
  constructor(private limit=32) {}
  async run<T>(work:()=>Promise<T>): Promise<T> {
    if(this.waiting+this.running>=this.limit) throw new AppError('QUEUE_FULL','요청 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.',429);
    this.waiting++;
    const previous=this.tail; let release!:()=>void;
    this.tail=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    this.waiting--;this.running++;
    try{return await work();}finally{this.running--;release();}
  }
}
export class Providers {
  readonly embeddingGate=new SerialGate(128);
  readonly generationGate=new SerialGate(12);
  constructor(readonly config: Config) {}
  async request(base:string,path:string,body?:unknown,method=body===undefined?'GET':'POST',timeout=30_000): Promise<any> {
    if(this.config.mode==='keyword') throw new AppError('KEYWORD_MODE','키워드 전용 모드입니다. AI 답변을 사용하려면 모델을 포함해 다시 실행하세요.',503);
    let response:Response;
    try {response=await fetch(base+path,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
    catch {throw new AppError('SERVICE_UNAVAILABLE','로컬 모델 또는 벡터 서비스에 연결할 수 없습니다. 실행 상태를 확인하세요.',503);}
    if(!response.ok) {
      await response.body?.cancel();
      throw new AppError('PROVIDER_ERROR',`로컬 서비스 ${path.split('?')[0]} 요청 실패 (HTTP ${response.status}).`,503);
    }
    try{return await response.json();}
    catch{throw new AppError('PROVIDER_RESPONSE','로컬 서비스의 응답 형식이 잘못되었습니다.',502);}
  }
  async health() {
    const [embedding,generation,vector]=await Promise.all([
      this.request(this.config.embeddingURL,'/health',undefined,'GET',2000),
      this.request(this.config.generationURL,'/health',undefined,'GET',2000),
      this.request(this.config.qdrantURL,'/',undefined,'GET',2000)
    ].map(p=>p.then(()=>({ok:true})).catch(()=>({ok:false}))));
    return {embedding,generation,vector};
  }
  async tokens(text:string,kind:'embedding'|'generation') {
    const result=await this.request(kind==='embedding'?this.config.embeddingURL:this.config.generationURL,'/tokenize',{content:text,add_special:false});
    if(!Array.isArray(result.tokens)) throw new AppError('MODEL_RESPONSE','모델의 토큰 계산 응답이 잘못되었습니다.',502);
    return result.tokens.length as number;
  }
  async embed(text:string,query=false) {
    return this.embeddingGate.run(async()=>{
      let input=(query?'task: search result | query: ':'')+text;
      let size=await this.tokens(input,'embedding');
      while(size>1900){input=input.slice(0,Math.max(1,Math.floor(input.length*1800/size)));size=await this.tokens(input,'embedding');}
      const result=await this.request(this.config.embeddingURL,'/v1/embeddings',{input});
      const vector=result.data?.[0]?.embedding;
      if(!Array.isArray(vector)||vector.length!==768||vector.some((x:unknown)=>typeof x!=='number'||!Number.isFinite(x)))
        throw new AppError('EMBEDDING_DIMENSION','768차원 EmbeddingGemma 응답이 필요합니다.',502);
      return vector as number[];
    });
  }
  collectionPath() {return '/collections/'+this.config.collection;}
  async ensureCollection(): Promise<boolean> {
    const list=await this.request(this.config.qdrantURL,'/collections');
    if(list.result?.collections?.some((x:any)=>x.name===this.config.collection)) {
      const info=await this.request(this.config.qdrantURL,this.collectionPath());
      if(info.result?.config?.params?.vectors?.size!==768) throw new AppError('VECTOR_SCHEMA','벡터 컬렉션 차원이 맞지 않습니다.',503);
      return false;
    }
    await this.request(this.config.qdrantURL,this.collectionPath(),{vectors:{size:768,distance:'Cosine'}},'PUT');
    for(const field of ['sourceId','documentId','board','revision'])
      await this.request(this.config.qdrantURL,this.collectionPath()+'/index?wait=true',{field_name:field,field_schema:'keyword'},'PUT');
    return true;
  }
  async upsert(chunks:Chunk[],vectors:number[][]) {
    await this.request(this.config.qdrantURL,this.collectionPath()+'/points?wait=true',{points:chunks.map((c,i)=>({id:c.id,vector:vectors[i],payload:{sourceId:c.sourceId,documentId:c.documentId,board:c.board,revision:c.revision}}))},'PUT');
  }
  async deletePoints(ids:string[]) {if(ids.length) await this.request(this.config.qdrantURL,this.collectionPath()+'/points/delete?wait=true',{points:ids});}
  async vectorSearch(vector:number[],input:SearchInput):Promise<{id:string;score:number}[]> {
    const must=[];
    if(input.board)must.push({key:'board',match:{value:input.board}});
    if(input.revision)must.push({key:'revision',match:{value:input.revision}});
    const result=await this.request(this.config.qdrantURL,this.collectionPath()+'/points/query',{query:vector,filter:must.length?{must}:undefined,limit:48,with_payload:false});
    return result.result?.points || [];
  }
  async complete(messages:{role:string;content:string}[],ids:string[]) {
    const schema={type:'object',properties:{answerable:{type:'boolean'},answer:{type:'string'},citations:{type:'array',items:{type:'string',enum:ids}}},required:['answerable','answer','citations'],additionalProperties:false};
    const result=await this.request(this.config.generationURL,'/v1/chat/completions',{
      messages,temperature:0,max_tokens:512,chat_template_kwargs:{enable_thinking:false},
      response_format:{type:'json_schema',json_schema:{name:'grounded_answer',strict:true,schema}}
    },'POST',120_000);
    if(result.choices?.[0]?.finish_reason==='length') throw new AppError('ANSWER_TRUNCATED','답변이 길이 제한에 도달했습니다. 질문 범위를 좁혀 주세요.',502);
    try{return JSON.parse(result.choices[0].message.content);}catch{throw new AppError('MODEL_RESPONSE','모델 답변 형식을 확인할 수 없습니다. 다시 시도하세요.',502);}
  }
  /** Callers acquire generationGate for each bounded step, allowing other requests between analysis steps. */
  async completeStructured(messages:{role:string;content:string}[],schema:unknown,maxTokens=512) {
    const result=await this.request(this.config.generationURL,'/v1/chat/completions',{
      messages,temperature:0,max_tokens:maxTokens,chat_template_kwargs:{enable_thinking:false},
      response_format:{type:'json_schema',json_schema:{name:'analysis_step',strict:true,schema}}
    },'POST',120_000);
    if(result.choices?.[0]?.finish_reason==='length')throw new AppError('ANSWER_TRUNCATED','분석 응답이 길이 제한에 도달했습니다.',502);
    try{return JSON.parse(result.choices[0].message.content);}catch{throw new AppError('MODEL_RESPONSE','분석 응답 형식을 검증할 수 없습니다.',502);}
  }
}
