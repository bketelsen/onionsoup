import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {atomicJson} from '../batch-store.ts';
import {git} from '../fixture-runner/fixture.ts';
import {pinRuntime} from '../fixture-runner/sandbox.ts';
import {hash} from '../repository-brief/contracts.ts';
import {GoRuntime,GoDependency} from './contracts.ts';
import {treeDigest} from './source.ts';
const exec=promisify(execFile);
export async function pinGoRuntime(image:string,directory:string):Promise<GoRuntime> {
 const root=await realpath(directory),base=await pinRuntime(image,join(root,'bin/go'));
 const version=(await exec(join(root,'bin/go'),['version'],{env:{PATH:'/usr/bin:/bin',GOTOOLCHAIN:'local',GOENV:'off',GOTELEMETRY:'off'},timeout:10000})).stdout.trim();
 if(!/^go version go1\.\d+\.\d+ linux\/amd64$/.test(version))throw new Error('Pinned Linux Go release required');
 return GoRuntime.parse({schemaVersion:2,imageId:base.imageId,goDirectory:root,goHash:await treeDigest(root,1000000000),goVersion:version,podmanVersion:base.podmanVersion});
}
export async function validateGoRuntime(raw:unknown) {
 const r=GoRuntime.parse(raw);if(hash(await pinGoRuntime(r.imageId,r.goDirectory))!==hash(r))throw new Error('Go runtime changed');return r;
}
export function validateGoManifests(mod:string,sum:string) {
 // Deliberately narrow public dependency policy for this trial, not a general go.mod parser.
 if(!/^module github\.com\/bketelsen\/clippy\n/m.test(mod)||/^\s*(replace|exclude|toolchain|tool|godebug)\b/m.test(mod))throw new Error('Unsupported Go module policy');
 const entries=new Map<string,string>();
 for(const line of sum.trim().split('\n')){
  const m=/^((?:github\.com\/[\w.-]+\/[\w./-]+|golang\.org\/x\/[\w.-]+)) (v[\w.+-]+(?:\/go.mod)?) (h1:[A-Za-z0-9+/]{43}=)$/.exec(line);
  if(!m||entries.has(m[1]+' '+m[2]))throw new Error('Invalid public checksum entry');entries.set(m[1]+' '+m[2],m[3]);
 }
 if(entries.size<2||entries.size>100)throw new Error('Module bound');return entries;
}
export async function provisionGoDependencies(checkout:string,commit:string,directory:string,runtime:GoRuntime) {
 await validateGoRuntime(runtime);directory=resolve(directory);await mkdir(directory,{mode:0o700});
 const mod=await git(checkout,['show',commit+':go.mod']),sum=await git(checkout,['show',commit+':go.sum']),sums=validateGoManifests(mod,sum);
 const work=join(directory,'manifests'),home=join(directory,'home'),cache=join(directory,'modules');
 await mkdir(work);await mkdir(home);await mkdir(cache,{mode:0o755});await writeFile(join(work,'go.mod'),mod);await writeFile(join(work,'go.sum'),sum);
 const env={PATH:join(runtime.goDirectory,'bin')+':/usr/bin:/bin',HOME:home,GOENV:'off',GOWORK:'off',GOTOOLCHAIN:'local',GOTELEMETRY:'off',GOAUTH:'off',GOPATH:join(directory,'gopath'),GOMODCACHE:cache,GOCACHE:join(directory,'cache'),GOPROXY:'https://proxy.golang.org',GOSUMDB:'sum.golang.org',GOVCS:'*:off',CGO_ENABLED:'0'};
 const modules=[...sums.keys()].filter(k=>!k.endsWith('/go.mod')).map(k=>k.replace(' ','@'));
 const args=['mod','download','-json',...modules];await atomicJson(join(directory,'intent.json'),{command:[join(runtime.goDirectory,'bin/go'),...args],environment:env,packageHash:hash(mod),lockHash:hash(sum),runtimeHash:hash(runtime)});
 const output=(await exec(join(runtime.goDirectory,'bin/go'),args,{cwd:work,env,timeout:180000,maxBuffer:1000000})).stdout;
 const downloads=JSON.parse('['+output.trim().replace(/}\s*{/g,'},{')+']') as Array<{Path:string;Version:string;Sum:string;GoModSum:string;Error?:string}>;
 if(!downloads.length||downloads.some(d=>d.Error||sums.get(d.Path+' '+d.Version)!==d.Sum||sums.get(d.Path+' '+d.Version+'/go.mod')!==d.GoModSum)||new Set(downloads.map(d=>d.Path)).size!==downloads.length)throw new Error('Downloaded modules lack original checksums');
 if(await readFile(join(work,'go.mod'),'utf8')!==mod||await readFile(join(work,'go.sum'),'utf8')!==sum)throw new Error('Go manifests changed');
 const result=GoDependency.parse({schemaVersion:2,directory:cache,packageHash:hash(mod),lockHash:hash(sum),treeHash:await treeDigest(cache),goHash:runtime.goHash,goVersion:runtime.goVersion,registry:'https://proxy.golang.org',checksumDatabase:'sum.golang.org',createdAt:new Date().toISOString()});
 await atomicJson(join(directory,'downloads.json'),downloads);await atomicJson(join(directory,'dependencies.json'),result);return result;
}
