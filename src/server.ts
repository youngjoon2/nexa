import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadConfig} from './config';
import {createApplication} from './app';

const config=loadConfig();
const lock=join(config.dataDir,'api.lock');
if(existsSync(lock)) {
  let alive=false;
  try{const pid=Number(readFileSync(lock,'utf8'));if(Number.isInteger(pid)&&pid>0){process.kill(pid,0);alive=true;}}catch{}
  if(alive)throw new Error('같은 데이터 폴더를 사용 중인 Nexa API가 있습니다. scripts/stop.ps1로 종료하세요.');
  unlinkSync(lock);
}
writeFileSync(lock,String(process.pid),{flag:'wx'});
process.on('exit',()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}catch{}});
const runtime=createApplication(config);
const server=Bun.serve({hostname:config.host,port:config.port,fetch:runtime.app.fetch,maxRequestBodySize:config.maxUploadBytes,idleTimeout:0});
console.log(`Nexa: http://${config.host}:${server.port}`);
console.log(`관리자 키 파일: ${config.adminKeyPath}`);
console.log(`실행 모드: ${config.mode}. 단일 API 프로세스가 SQLite와 색인 큐를 관리합니다.`);
async function shutdown() {
  runtime.indexer.stop();
  runtime.analyses.stop();
  await server.stop(true);
  process.exit(0);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
