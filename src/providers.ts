import type {Config} from './config';
import {join} from 'node:path';
import {AppError, type Chunk, type SearchInput} from './types';

type ChatMessage = {role:string;content:string};

/** One request at a time per llama slot; bounded waiting prevents unbounded team load. */
export class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();
  waiting=0; running=0;
  constructor(private limit=32) {}
  async run<T>(work:()=>Promise<T>): Promise<T> {
    if(this.waiting+this.running>=this.limit) throw new AppError('QUEUE_FULL','The request queue is full. Try again shortly.',429);
    this.waiting++;
    const previous=this.tail; let release!:()=>void;
    this.tail=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    this.waiting--;this.running++;
    try{return await work();}finally{this.running--;release();}
  }
}

function contentText(value: unknown): string {
  if(typeof value==='string') return value;
  if(Array.isArray(value)) return value.map(part=>typeof part==='string'?part:(part&&typeof part==='object'&&typeof (part as any).text==='string'?(part as any).text:'')).join('');
  return '';
}

function parseJsonText(value: unknown, errorMessage: string): any {
  const text=contentText(value).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try{return JSON.parse(text);}
  catch {
    const start=text.indexOf('{'), end=text.lastIndexOf('}');
    if(start>=0&&end>start) {
      try{return JSON.parse(text.slice(start,end+1));}catch{}
    }
    throw new AppError('MODEL_RESPONSE',errorMessage,502);
  }
}

function schemaInstruction(schema: unknown): string {
  return 'Return only one valid JSON object. Do not use markdown fences or explanatory text. The JSON must match this JSON Schema exactly:\n'+JSON.stringify(schema);
}

function appendSchema(messages: ChatMessage[], schema: unknown): ChatMessage[] {
  const instruction=schemaInstruction(schema);
  const systemIndex=messages.findIndex(message=>message.role==='system');
  if(systemIndex>=0) return messages.map((message,index)=>index===systemIndex?{...message,content:message.content+'\n\n'+instruction}:message);
  return [{role:'system',content:instruction},...messages];
}

export class Providers {
  readonly embeddingGate=new SerialGate(128);
  readonly generationGate=new SerialGate(12);
  constructor(readonly config: Config) {}

  private generationProvider() { return this.config.llmProvider || 'local'; }
  private externalGeneration() { return this.generationProvider() !== 'local'; }

  async request(base:string,path:string,body?:unknown,method=body===undefined?'GET':'POST',timeout=30_000): Promise<any> {
    if(this.config.mode==='keyword') throw new AppError('KEYWORD_MODE','Keyword mode is active. Restart with the models enabled to use AI answers.',503);
    let response:Response;
    try {response=await fetch(base+path,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
    catch {throw new AppError('SERVICE_UNAVAILABLE','Cannot connect to the local model or vector service. Check that it is running.',503);}
    if(!response.ok) {
      await response.body?.cancel();
      throw new AppError('PROVIDER_ERROR',`Local service request to ${path.split('?')[0]} failed (HTTP ${response.status}).`,503);
    }
    try{return await response.json();}
    catch{throw new AppError('PROVIDER_RESPONSE','The local service returned an invalid response format.',502);}
  }

  private async externalJSON(path:string,body:unknown): Promise<any> {
    const provider=this.generationProvider();
    const base=this.config.llmBaseURL || '';
    const url=base+path;
    const headers:Record<string,string>={
      'Content-Type':'application/json',
      ...(provider==='openai'?{'Authorization':`Bearer ${this.config.llmApiKey}`}:{'x-api-key':this.config.llmApiKey,'anthropic-version':'2023-06-01'}),
    };
    let response:Response;
    try {
      response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(this.config.llmTimeoutMs || 120_000)});
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE',`Cannot connect to the ${provider} LLM provider. Check the network and provider URL.`,503);
    }
    if(!response.ok) {
      await response.body?.cancel();
      const message=response.status===401||response.status===403?'Authentication was rejected by the external LLM provider.':`The ${provider} LLM provider rejected the request (HTTP ${response.status}).`;
      throw new AppError('PROVIDER_ERROR',message,503);
    }
    try{return await response.json();}
    catch{throw new AppError('PROVIDER_RESPONSE',`The ${provider} LLM provider returned an invalid response format.`,502);}
  }

  async health() {
    const [embedding,vector]=await Promise.all([
      this.request(this.config.embeddingURL,'/health',undefined,'GET',2000),
      this.request(this.config.qdrantURL,'/',undefined,'GET',2000)
    ].map(p=>p.then(()=>({ok:true})).catch(()=>({ok:false}))));
    const generation=this.externalGeneration()
      ? {ok:this.config.mode!=='keyword'&&Boolean(this.config.llmApiKey)}
      : await this.request(this.config.generationURL,'/health',undefined,'GET',2000).then(()=>({ok:true})).catch(()=>({ok:false}));
    return {embedding,generation,vector};
  }

  async tokens(text:string,kind:'embedding'|'generation') {
    if(this.config.mode==='keyword') throw new AppError('KEYWORD_MODE','Keyword mode is active. Restart with the models enabled to use AI answers.',503);
    if(kind==='generation'&&this.externalGeneration()) {
      // Provider-neutral estimate used only to keep oversized RAG prompts bounded.
      return Math.max(1,Math.ceil(Array.from(text).length/3));
    }
    const result=await this.request(kind==='embedding'?this.config.embeddingURL:this.config.generationURL,'/tokenize',{content:text,add_special:false});
    if(!Array.isArray(result?.tokens)) throw new AppError('MODEL_RESPONSE','The model returned an invalid token count response.',502);
    return result.tokens.length as number;
  }

  async embed(text:string,query=false) {
    return this.embeddingGate.run(async()=>{
      let input=(query?'task: search result | query: ':'')+text;
      let size=await this.tokens(input,'embedding');
      let attempts=0;
      while(size>1900){
        const length=Math.max(1,Math.floor(input.length*1800/size));
        if(length>=input.length||attempts++>=16)throw new AppError('MODEL_RESPONSE','The model token count could not be used to adjust the input length.',502);
        input=input.slice(0,length);size=await this.tokens(input,'embedding');
      }
      const result=await this.request(this.config.embeddingURL,'/v1/embeddings',{input});
      const vector=result?.data?.[0]?.embedding;
      if(!Array.isArray(vector)||vector.length!==768||vector.some((x:unknown)=>typeof x!=='number'||!Number.isFinite(x)))
        throw new AppError('EMBEDDING_DIMENSION','A 768-dimensional EmbeddingGemma response is required.',502);
      return vector as number[];
    });
  }

  collectionPath() {return '/collections/'+this.config.collection;}
  async ensureCollection(): Promise<boolean> {
    const list=await this.request(this.config.qdrantURL,'/collections');
    if(list.result?.collections?.some((x:any)=>x.name===this.config.collection)) {
      const info=await this.request(this.config.qdrantURL,this.collectionPath());
      if(info.result?.config?.params?.vectors?.size!==768) throw new AppError('VECTOR_SCHEMA','The vector collection has an incompatible dimension.',503);
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
    const points=result?.result?.points;
    if(!Array.isArray(points)||points.some((point:any)=>!point||!['string','number'].includes(typeof point.id)||typeof point.score!=='number'||!Number.isFinite(point.score)))
      throw new AppError('PROVIDER_RESPONSE','Vector search returned an invalid response format.',502);
    return points.map((point:any)=>({id:String(point.id),score:point.score}));
  }

  private async completeLocal(messages:ChatMessage[],schema:unknown,maxTokens:number,schemaName:string,errorMessage:string) {
    const result=await this.request(this.config.generationURL,'/v1/chat/completions',{
      messages,temperature:0,max_tokens:maxTokens,chat_template_kwargs:{enable_thinking:false},
      response_format:{type:'json_schema',json_schema:{name:schemaName,strict:true,schema}}
    },'POST',this.config.llmTimeoutMs || 120_000);
    if(result.choices?.[0]?.finish_reason==='length') throw new AppError('ANSWER_TRUNCATED',errorMessage,502);
    return parseJsonText(result?.choices?.[0]?.message?.content,errorMessage);
  }

  private async completeOpenAI(messages:ChatMessage[],schema:unknown,maxTokens:number) {
    const result=await this.externalJSON('/chat/completions',{
      model:this.config.llmModel,
      messages:appendSchema(messages,schema),
      max_completion_tokens:maxTokens,
      response_format:{type:'json_schema',json_schema:{name:'nexa_response',strict:true,schema}},
    });
    if(result.choices?.[0]?.finish_reason==='length') throw new AppError('ANSWER_TRUNCATED','The answer reached the length limit. Narrow your question.',502);
    return parseJsonText(result?.choices?.[0]?.message?.content,'The external model answer format could not be verified. Try again.');
  }

  private async completeAnthropic(messages:ChatMessage[],schema:unknown,maxTokens:number) {
    const augmented=appendSchema(messages,schema);
    const system=augmented.filter(message=>message.role==='system').map(message=>message.content).join('\n\n');
    const compact: {role:'user'|'assistant';content:string}[]=[];
    for(const message of augmented) {
      if(message.role==='system') continue;
      const role=message.role==='assistant'?'assistant':'user';
      const previous=compact[compact.length-1];
      if(previous?.role===role) previous.content+='\n\n'+message.content;
      else compact.push({role,content:message.content});
    }
    if(!compact.length) compact.push({role:'user',content:schemaInstruction(schema)});
    const path=(this.config.llmBaseURL || '').endsWith('/v1')?'/messages':'/v1/messages';
    const result=await this.externalJSON(path,{model:this.config.llmModel,max_tokens:maxTokens,temperature:0,...(system?{system}:{}),messages:compact});
    if(result?.stop_reason==='max_tokens') throw new AppError('ANSWER_TRUNCATED','The Claude response reached the length limit. Narrow your question.',502);
    return parseJsonText(result?.content,'The external Claude answer format could not be verified. Try again.');
  }

  private async completeCopilot(messages:ChatMessage[],schema:unknown) {
    let sdk:any;
    try {sdk=await import('@github/copilot-sdk');}
    catch {throw new AppError('PROVIDER_ERROR','GitHub Copilot support requires the @github/copilot-sdk package. Run the external provider setup command and restart Nexa.',503);}
    const environment={...process.env,COPILOT_GITHUB_TOKEN:this.config.llmApiKey};
    const options:any={env:environment,useLoggedInUser:false,mode:'empty',baseDirectory:join(this.config.dataDir,'.copilot')};
    if(this.config.copilotCliPath) {
      options.connection=sdk.RuntimeConnection.forStdio({path:this.config.copilotCliPath,env:environment});
      delete options.env;
    }
    const client=new sdk.CopilotClient(options);
    let session:any;
    try {
      session=await client.createSession({model:this.config.llmModel,availableTools:[]});
      const prompt=messages.map(message=>message.role.toUpperCase()+':\n'+message.content).join('\n\n')+'\n\n'+schemaInstruction(schema);
      const response=await session.sendAndWait({prompt});
      return parseJsonText(response?.data?.content,'The external GitHub Copilot answer format could not be verified. Try again.');
    } catch(error) {
      if(error instanceof AppError) throw error;
      throw new AppError('PROVIDER_ERROR','GitHub Copilot rejected the request. Check the token, model, and Copilot access.',503);
    } finally {
      try {await session?.disconnect?.();} catch {}
      try {await client.stop();} catch {}
    }
  }

  private async completeExternal(messages:ChatMessage[],schema:unknown,maxTokens:number) {
    switch(this.generationProvider()) {
      case 'openai': return this.completeOpenAI(messages,schema,maxTokens);
      case 'anthropic': return this.completeAnthropic(messages,schema,maxTokens);
      case 'github-copilot': return this.completeCopilot(messages,schema);
      default: throw new AppError('PROVIDER_ERROR','The configured external LLM provider is not supported.',503);
    }
  }

  async complete(messages:ChatMessage[],ids:string[]) {
    const schema={type:'object',properties:{answerable:{type:'boolean'},answer:{type:'string'},citations:{type:'array',items:{type:'string',enum:ids}}},required:['answerable','answer','citations'],additionalProperties:false};
    if(this.externalGeneration()) return this.completeExternal(messages,schema,512);
    return this.completeLocal(messages,schema,512,'grounded_answer','The answer reached the length limit. Narrow your question.');
  }

  /** Callers acquire generationGate for each bounded step, allowing other requests between analysis steps. */
  async completeStructured(messages:ChatMessage[],schema:unknown,maxTokens=512) {
    if(this.externalGeneration()) return this.completeExternal(messages,schema,maxTokens);
    return this.completeLocal(messages,schema,maxTokens,'analysis_step','The analysis response reached the length limit.');
  }
}
