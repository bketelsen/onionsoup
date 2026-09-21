// Fixed host entry point. Target scripts cannot select executable commands.
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const input=JSON.parse(await readFile('/harness/input.json','utf8'));
const run=(args,timeoutMs)=>new Promise(resolve=>{
 const child=spawn('/runtime/node',args,{cwd:'/work',env:process.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',bytes=0,overflow=false;
 if(timeoutMs)setTimeout(()=>child.kill('SIGKILL'),timeoutMs).unref();
 const read=which=>chunk=>{bytes+=chunk.length;if(bytes>200000){overflow=true;child.kill('SIGKILL');}else if(which==='stdout')stdout+=chunk;else stderr+=chunk;};
 child.stdout.on('data',read('stdout'));child.stderr.on('data',read('stderr'));
 child.on('error',()=>resolve({code:null,stdout,stderr,overflow}));
 child.on('close',code=>resolve({code,stdout,stderr,overflow}));
});
// Fixed commands per mode; the profile chooses the mode, never the executable.
const observed={};
if(input.mode==='build'){
 observed.build=await run(['--max-old-space-size=1024','/work/node_modules/.bin/'+input.build.bin,...input.build.args],input.build.timeoutMs);
}else{
 observed.typecheck=await run(['--max-old-space-size=1024','/work/node_modules/typescript/bin/tsc','--noEmit']);
 observed.tests=await run(['--max-old-space-size=512','--import','/work/node_modules/tsx/dist/loader.mjs','--test','--test-concurrency=1','--test-reporter=tap',...input.testFiles]);
}
const checks=[];let exports;
try{exports=await import('/harness/checks.mjs');}catch{}
for(const check of input.checks){
 try{
  if(typeof exports?.[check.function]!=='function')throw new Error('Missing check');
  await exports[check.function]();checks.push({id:check.id,status:'passed'});
 }catch{checks.push({id:check.id,status:'failed'});}
}
process.stdout.write(JSON.stringify({nonce:input.nonce,...observed,checks}));
