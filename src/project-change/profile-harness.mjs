// Trusted profile harness: copied outside the candidate tree before execution.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
const request=JSON.parse(await readFile('/harness/input.json','utf8'));
const {consoleServer}=await import('/work/src/console/server.ts');
const {Operator}=await import('/work/src/console/actions.ts');
const root='/tmp/publication-profile';await mkdir(root);
for(const {bundle,state} of request.seeds) {
  const dir=root+'/'+bundle.publicationId;await mkdir(dir);
  await writeFile(dir+'/bundle.json',JSON.stringify(bundle));await writeFile(dir+'/state.json',JSON.stringify(state));
}
await mkdir(root+'/'+'f'.repeat(64));await writeFile(root+'/'+'f'.repeat(64)+'/bundle.json','{}');
const config={schemaVersion:1,stateDirectory:root,targets:request.targets};let writes=0;
const publisher={config:async()=>config,submit:async()=>{writes++;throw new Error('Forbidden mutation');}};
const operator=new Operator({schemaVersion:1,stateDirectory:'/tmp/operator',fixtureRoots:[],jobs:[]});
const server=consoleServer(operator,publisher);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const queries=['','?status=all',...request.statuses.map(s=>'?status='+s),'?status=bogus','?status=blocked&status=unknown','?status=','/'+request.seeds[0].bundle.publicationId+'?status=bogus'];
const responses=[];
try {for(const query of queries){const r=await fetch(origin+'/publications'+query);responses.push({query,status:r.status,html:await r.text()});}}
finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
const run=(args)=>new Promise(resolve=>{
 const p=spawn('/runtime/node',args,{cwd:'/work',env:process.env,stdio:['ignore','pipe','pipe']});let output='',bytes=0;
 const read=b=>{bytes+=b.length;if(bytes>200000)p.kill('SIGKILL');else output+=b;};p.stdout.on('data',read);p.stderr.on('data',read);
 p.on('error',()=>resolve({code:null,output:'spawn failed'}));p.on('close',code=>resolve({code,output}));
});
const typecheck=await run(['/work/node_modules/typescript/bin/tsc','--noEmit']);
const adjacent=await run(['--import','/work/node_modules/tsx/dist/loader.mjs','--test','--test-name-pattern=dashboard|HTTP rejects|run-now|pause is durable|stale configuration|investigation binds|a newly closed|initial checkpoint|concurrent action|delivery retry|history exposes|next occurrence|fixture views','test/console.test.ts']);
process.stdout.write(JSON.stringify({nonce:request.nonce,responses,writes,typecheck,adjacent}));
