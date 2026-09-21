import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {atomicJson} from '@onionsoup/runtime/storage';
import {git} from '../fixture/fixture.ts';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {Dependency} from './contracts.ts';
import {treeDigest,byteHash} from './source.ts';
export async function provisionDependencies(checkout:string,commit:string,directory:string) {
  directory=resolve(directory);await mkdir(directory,{mode:0o700});
  const pkg=await git(checkout,['show',commit+':package.json']),lock=await git(checkout,['show',commit+':package-lock.json']);
  const entries=Object.entries(JSON.parse(lock).packages) as Array<[string,any]>;
  for(const [path,p] of entries)if(path&&(!/^https:\/\/registry\.npmjs\.org\//.test(p.resolved??'')||!/^sha512-/.test(p.integrity??'')||p.link))throw new Error('Only integrity-pinned public npm registry dependencies are admitted');
  const work=join(directory,'packages'),home=join(directory,'home');await mkdir(work,{mode:0o755});await mkdir(home,{mode:0o700});
  await writeFile(join(work,'package.json'),pkg);await writeFile(join(work,'package-lock.json'),lock);
  const npm=resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  const npmHash=byteHash(await readFile(npm)),env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:home,NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:join(home,'empty-global.npmrc'),NPM_CONFIG_CACHE:join(directory,'cache')};
  await writeFile(join(home,'empty-global.npmrc'),'');
  const args=[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/'];
  await atomicJson(join(directory,'intent.json'),{schemaVersion:1,packageHash:hash(pkg),lockHash:hash(lock),command:[process.execPath,...args],environment:env,scripts:'disabled'});
  // Only trusted npm executes on the host. No target scripts, source, .npmrc or credentials are present.
  await promisify(execFile)(process.execPath,args,{cwd:work,env,timeout:180000,maxBuffer:1000000});
  if(await readFile(join(work,'package-lock.json'),'utf8')!==lock)throw new Error('Lockfile changed');
  const npmVersion=(await promisify(execFile)(process.execPath,[npm,'--version'],{env,timeout:10000})).stdout.trim();
  const d=Dependency.parse({schemaVersion:1,directory:join(work,'node_modules'),packageHash:hash(pkg),lockHash:hash(lock),treeHash:await treeDigest(join(work,'node_modules')),nodeHash:byteHash(await readFile(process.execPath)),npmHash,npmVersion,scripts:'disabled',registry:'https://registry.npmjs.org/',createdAt:new Date().toISOString()});
  await atomicJson(join(directory,'dependencies.json'),d);return d;
}
