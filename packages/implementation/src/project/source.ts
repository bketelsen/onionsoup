import {mkdir,writeFile,readFile,readdir,lstat,readlink,symlink} from 'node:fs/promises';
import {join,dirname,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {git} from '../fixture/fixture.ts';
import {Files,paths,Commit} from './contracts.ts';
export const byteHash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
export async function sourceFiles(checkout:string,commit:string,allowed:readonly string[]=paths) {
  Commit.parse(commit);return Files.parse(Object.fromEntries(await Promise.all(allowed.map(async p=>{if(!/^100644 blob [a-f0-9]{40}\t/.test(await git(checkout,['ls-tree',commit,'--',p])))throw new Error('Editable paths must be regular text files');return [p,await git(checkout,['show',commit+':'+p])];}))));
}
export const SNAPSHOT_LIMITS={entries:20000,bytes:64000000} as const;
export async function snapshot(checkout:string,commit:string,directory:string,binaryAssets=false,limits:{entries:number;bytes:number}|undefined=SNAPSHOT_LIMITS) {
  limits??=SNAPSHOT_LIMITS;
  Commit.parse(commit);await mkdir(directory,{mode:0o755});
  const entries=(await git(checkout,['ls-tree','-rz',commit])).split('\0').filter(Boolean);let bytes=0;
  if(entries.length>limits.entries)throw new Error('Source exceeds profile bound');
  for(const entry of entries) {
    const m=/^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    // Route files such as [slug].astro and [...route].ts are ordinary source; control characters, separators and shell metacharacters are not.
    if(!m||m[3].split('/').some(p=>['.','..','.git','node_modules'].includes(p))||/[^\w.\/@\[\]+-]/.test(m[3]))throw new Error('Unsupported source entry');
    const path=join(directory,m[3]);
    const data=(await promisify(execFile)('/usr/bin/git',['-C',checkout,'cat-file','blob',m[2]],{encoding:'buffer',timeout:10000,maxBuffer:64000000,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout;
    const content=data.toString('utf8');if((!binaryAssets||m[1]==='120000')&&(content.includes('\u0000')||!Buffer.from(content).equals(data)))throw new Error('Only lossless UTF-8 source is supported');bytes+=data.length;
    if(bytes>limits.bytes)throw new Error('Source exceeds profile bound');
    await mkdir(dirname(path),{recursive:true,mode:0o755});
    if(m[1]==='120000') {
      const target=resolve(dirname(path),content);if(relative(directory,target).startsWith('..')||content.startsWith('/'))throw new Error('Source symlink escapes');await symlink(content,path);
    }else await writeFile(path,data,{mode:m[1]==='100755'?0o555:0o444,flag:'wx'});
  }
}
export async function treeDigest(root:string,maxBytes=400000000):Promise<string> {
  const entries:Array<[string,string,string]>=[];let count=0,bytes=0;
  const walk=async(dir:string)=>{
    for(const name of (await readdir(dir)).sort()) {
      const path=join(dir,name),info=await lstat(path),rel=relative(root,path);
      if(++count>50000)throw new Error('Dependency tree too large');
      if(info.isDirectory())await walk(path);
      else if(info.isSymbolicLink()) {
        const value=await readlink(path),target=resolve(dirname(path),value);if(value.startsWith('/')||relative(root,target).startsWith('..'))throw new Error('Dependency link escapes');entries.push([rel,'link',value]);
      }else if(info.isFile()) {bytes+=info.size;if(bytes>maxBytes)throw new Error('Dependency bytes exceeded');entries.push([rel,String(info.mode&0o777),byteHash(await readFile(path))]);}
      else throw new Error('Unsupported dependency entry');
    }
  };await walk(root);return byteHash(JSON.stringify(entries));
}
