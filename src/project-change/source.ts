import {mkdir,writeFile,readFile,readdir,lstat,readlink,symlink} from 'node:fs/promises';
import {join,dirname,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {git} from '../fixture-runner/fixture.ts';
import {Files,paths,Commit} from './contracts.ts';
export const byteHash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
export async function sourceFiles(checkout:string,commit:string) {
  Commit.parse(commit);return Files.parse(Object.fromEntries(await Promise.all(paths.map(async p=>[p,await git(checkout,['show',commit+':'+p])]))));
}
export async function snapshot(checkout:string,commit:string,directory:string) {
  Commit.parse(commit);await mkdir(directory,{mode:0o755});
  const entries=(await git(checkout,['ls-tree','-rz',commit])).split('\0').filter(Boolean);let bytes=0;
  if(entries.length>2000)throw new Error('Source exceeds profile bound');
  for(const entry of entries) {
    const m=/^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if(!m||m[3].split('/').some(p=>['.','..','.git','node_modules'].includes(p))||/[^\w./-]/.test(m[3]))throw new Error('Unsupported source entry');
    const path=join(directory,m[3]),content=await git(checkout,['cat-file','blob',m[2]]);if(content.includes('\u0000')||content.includes('\ufffd'))throw new Error('Only lossless UTF-8 source is supported');bytes+=Buffer.byteLength(content);
    if(bytes>8000000)throw new Error('Source exceeds profile bound');
    await mkdir(dirname(path),{recursive:true,mode:0o755});
    if(m[1]==='120000') {
      const target=resolve(dirname(path),content);if(relative(directory,target).startsWith('..')||content.startsWith('/'))throw new Error('Source symlink escapes');await symlink(content,path);
    }else await writeFile(path,content,{mode:m[1]==='100755'?0o555:0o444,flag:'wx'});
  }
}
export async function treeDigest(root:string):Promise<string> {
  const entries:Array<[string,string,string]>=[];let count=0,bytes=0;
  const walk=async(dir:string)=>{
    for(const name of (await readdir(dir)).sort()) {
      const path=join(dir,name),info=await lstat(path),rel=relative(root,path);
      if(++count>50000)throw new Error('Dependency tree too large');
      if(info.isDirectory())await walk(path);
      else if(info.isSymbolicLink()) {
        const value=await readlink(path),target=resolve(dirname(path),value);if(value.startsWith('/')||relative(root,target).startsWith('..'))throw new Error('Dependency link escapes');entries.push([rel,'link',value]);
      }else if(info.isFile()) {bytes+=info.size;if(bytes>400000000)throw new Error('Dependency bytes exceeded');entries.push([rel,String(info.mode&0o777),byteHash(await readFile(path))]);}
      else throw new Error('Unsupported dependency entry');
    }
  };await walk(root);return byteHash(JSON.stringify(entries));
}
