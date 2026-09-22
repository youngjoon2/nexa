import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadConfig} from './config';
import {createApplication} from './app';

const config=loadConfig();
const lock=join(config.dataDir,'api.lock');
if(existsSync(lock)) {
  let alive=false;
  try{const pid=Number(readFileSync(lock,'utf8'));if(Number.isInteger(pid)&&pid>0){process.kill(pid,0);alive=true;}}catch{}
  if(alive)throw new Error('Another Nexa API is using this data folder. Stop it with scripts/stop.ps1.');
  unlinkSync(lock);
}
writeFileSync(lock,String(process.pid),{flag:'wx'});
process.on('exit',()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}catch{}});
const runtime=createApplication(config);
const server=Bun.serve({hostname:config.host,port:config.port,fetch:runtime.app.fetch,maxRequestBodySize:config.maxUploadBytes,idleTimeout:0});
console.log(`Nexa: http://${config.host}:${server.port}`);
console.log(`Admin key file: ${config.adminKeyPath}`);
console.log(`Mode: ${config.mode}. One API process manages SQLite and the indexing queue.`);
async function shutdown() {
  runtime.indexer.stop();
  runtime.analyses.stop();
  await server.stop(true);
  process.exit(0);
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
