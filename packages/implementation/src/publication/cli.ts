import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {loadPublicationConfig,preparePublication,loadBundle,loadState} from './bundle.ts';
import {approvePublication,publish} from './runtime.ts';
const usage='npm run publication -- prepare --config FILE --fixture DIRECTORY --target-index N\nnpm run publication -- inspect|approve|publish --config FILE --id DIGEST [--bundle-hash DIGEST] [--reason TEXT]\n';
try {
  const {positionals,values:v}=parseArgs({allowPositionals:true,options:{config:{type:'string'},fixture:{type:'string'},'target-index':{type:'string'},id:{type:'string'},'bundle-hash':{type:'string'},reason:{type:'string'},help:{type:'boolean'}}});
  if(v.help)process.stdout.write(usage);
  else {
    if(!v.config||positionals.length!==1)throw new Error('Arguments');const c=await loadPublicationConfig(resolve(v.config));
    if(positionals[0]==='prepare') {
      if(!v.fixture||!/^\d+$/.test(v['target-index']??''))throw new Error('Arguments');
      const b=await preparePublication(c,resolve(v.fixture),c.targets[Number(v['target-index'])]);
      process.stdout.write(JSON.stringify({publicationId:b.publicationId,bundleHash:hash(b),headCommit:b.headCommit})+'\n');
    } else {
      if(!v.id)throw new Error('Identity required');const b=await loadBundle(c,v.id);let state;
      if(positionals[0]==='inspect') {process.stdout.write(JSON.stringify({bundle:b,bundleHash:hash(b),state:await loadState(c,b)},null,2)+'\n');}
      else {
        if(!v['bundle-hash'])throw new Error('Exact hash required');
        if(positionals[0]==='approve') {
          if(!v.reason)throw new Error('Authorization provenance required');
          state=await approvePublication(c,v.id,v['bundle-hash'],{authority:'explicit_user_session',reason:v.reason});
        } else if(positionals[0]==='publish')state=await publish(c,v.id,v['bundle-hash']);else throw new Error('Unknown command');
        process.stdout.write(JSON.stringify({publicationId:b.publicationId,status:state.status,pull:state.pull?.url})+'\n');
        if(['blocked','unknown'].includes(state.status))process.exitCode=1;
      }
    }
  }
} catch {process.stderr.write('Publication unavailable. Inspect saved bundle/state and remote effects before retrying.\n'+usage);process.exitCode=1;}
