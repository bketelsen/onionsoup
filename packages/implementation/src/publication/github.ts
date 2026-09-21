import {spawn} from 'node:child_process';
import {Pull,Target,type Bundle} from './contracts.ts';
import {z} from 'zod';
// Auth remains in gh / the host SSH agent. Never expose subprocess output on failure.
async function processOutput(command:string,args:string[],cwd?:string,input?:string) {
  return new Promise<string>((resolve,reject)=>{
    const p=spawn(command,args,{cwd,env:{...process.env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_SSH_COMMAND:'ssh -oBatchMode=yes'},stdio:['pipe','pipe','pipe']});
    let output='',bytes=0,failed=false;
    const timer=setTimeout(()=>{failed=true;p.kill('SIGKILL');},45000);
    const receive=(chunk:Buffer,save:boolean)=>{bytes+=chunk.length;if(bytes>2000000){failed=true;p.kill('SIGKILL');}else if(save)output+=chunk.toString();};
    p.stdout.on('data',c=>receive(c,true));p.stderr.on('data',c=>receive(c,false));
    p.on('error',()=>{clearTimeout(timer);reject(new Error('GitHub transport unavailable'));});
    p.on('close',code=>{clearTimeout(timer);code===0&&!failed?resolve(output):reject(new Error('GitHub transport failed; reconcile remote state'));});
    p.stdin.on('error',()=>{});p.stdin.end(input);
  });
}
async function api(path:string,body?:unknown):Promise<any> {
  return JSON.parse(await processOutput('gh',['api','--hostname','github.com','-H','Accept: application/vnd.github+json',
    '-H','X-GitHub-Api-Version: 2022-11-28','--method',body===undefined?'GET':'POST',path,...(body===undefined?[]:['--input','-'])],undefined,body===undefined?undefined:JSON.stringify(body)));
}
export type Remote={repositoryId:number;baseCommit:string;headCommit?:string;pulls:Pull[]};
export interface PublisherTransport {inspect(b:Bundle):Promise<Remote>;push(b:Bundle,gitDirectory:string):Promise<void>;create(b:Bundle):Promise<Pull>}
function pull(p:any,repositoryId:number):Pull {
  return Pull.parse({number:p.number,url:p.html_url,repositoryId,headRepositoryId:p.head.repo?.id,baseRepositoryId:p.base.repo?.id,
    head:p.head.ref,headCommit:p.head.sha,base:p.base.ref,baseCommit:p.base.sha,title:p.title,body:p.body??'',draft:p.draft,state:p.state,merged:!!p.merged_at});
}
export const githubTransport:PublisherTransport={
  async inspect(b) {
    const t=Target.parse(b.target),repo=await api(`repos/${t.repository}`);
    if(repo.full_name!==t.repository||repo.id!==t.repositoryId||repo.archived||repo.fork||!repo.permissions?.push) throw new Error('Repository identity or permission changed');
    const base=await api(`repos/${t.repository}/git/ref/heads/${t.baseBranch}`);
    // matching-refs yields [] on absence; failures are never confused with an absent branch.
    const refs=await api(`repos/${t.repository}/git/matching-refs/heads/${b.branch}`);
    if(!Array.isArray(refs)) throw new Error('Invalid remote refs');
    const head=refs.find((r:any)=>r.ref===`refs/heads/${b.branch}`);
    const pulls=await api(`repos/${t.repository}/pulls?state=all&head=${encodeURIComponent('bketelsen:'+b.branch)}&per_page=100`);
    if(!Array.isArray(pulls)||pulls.length>=100) throw new Error('Incomplete pull request view');
    return {repositoryId:repo.id,baseCommit:z.string().regex(/^[a-f0-9]{40}$/).parse(base.object.sha),headCommit:head?.object.sha,pulls:pulls.map(p=>pull(p,repo.id))};
  },
  async push(b,gitDirectory) {
    Target.parse(b.target);
    // Empty lease means this branch must not exist. No existing ref can be overwritten.
    await processOutput('/usr/bin/git',['-C',gitDirectory,'-c','core.hooksPath=/dev/null','push','--porcelain',
      `--force-with-lease=refs/heads/${b.branch}:`,`git@github.com:${b.target.repository}.git`,`${b.headCommit}:refs/heads/${b.branch}`]);
  },
  async create(b) {
    const p=await api(`repos/${b.target.repository}/pulls`,{title:b.title,body:b.body,head:b.branch,base:b.target.baseBranch,draft:true,maintainer_can_modify:false});
    return pull(p,b.target.repositoryId);
  },
};
