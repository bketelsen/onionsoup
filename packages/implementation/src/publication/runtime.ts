import {join} from 'node:path';
import {atomicJson} from '@onionsoup/runtime/storage';
import {hash} from '@onionsoup/repository-analysis/contracts';
import {Approval,validateState,type PublicationConfig,type Bundle,type State,type Pull} from './contracts.ts';
import {locked,loadBundle,loadState,directory,assertConfig,validateCommit} from './bundle.ts';
import {githubTransport,type PublisherTransport,type Remote} from './github.ts';
type Dependencies={transport?:PublisherTransport;persist?:typeof atomicJson;now?:()=>Date};
const time=(d:Dependencies)=> (d.now?.()??new Date()).toISOString();
function transition(s:State,status:State['status'],at:string,reason:State['events'][number]['reason']) {
  s.status=status;s.events.push({sequence:s.events.length,at,type:status,reason});
}
export async function approvePublication(c:PublicationConfig,id:string,expectedHash:string,authorization:{authority:'console_operator'|'explicit_user_session';reason:string},d:Dependencies={}) {
  return locked(c,async()=>{
    const b=await loadBundle(c,id),s=await loadState(c,b);assertConfig(c,b);
    if(hash(b)!==expectedHash||!['prepared','approved'].includes(s.status)) throw new Error('Stale or consumed approval');
    await validateCommit(c,b);const at=time(d);
    s.approval=Approval.parse({bundleHash:expectedHash,configHash:hash(c),approvedAt:at,expiresAt:new Date(Date.parse(at)+86400000).toISOString(),...authorization});
    transition(s,'approved',at,'operator_authorized');await(d.persist??atomicJson)(join(directory(c,id),'state.json'),validateState(s,b));return s;
  });
}
function exactPull(p:Pull,b:Bundle) {
  return p.repositoryId===b.target.repositoryId&&p.headRepositoryId===b.target.repositoryId&&p.baseRepositoryId===b.target.repositoryId&&
    p.url===`https://github.com/${b.target.repository}/pull/${p.number}`&&p.head===b.branch&&p.headCommit===b.headCommit&&p.base===b.target.baseBranch&&
    p.baseCommit===b.target.baseCommit&&p.title===b.title&&p.body===b.body&&p.draft&&p.state==='open'&&!p.merged;
}
export async function publish(c:PublicationConfig,id:string,expectedHash:string,d:Dependencies={}) {
  return locked(c,async()=>{
    const b=await loadBundle(c,id),s=await loadState(c,b);assertConfig(c,b);
    if(hash(b)!==expectedHash||!s.approval||s.status==='prepared') throw new Error('Exact bundle approval required');
    const repo=await validateCommit(c,b),remote=d.transport??githubTransport;
    const save=async(status:State['status'],reason:State['events'][number]['reason'])=>{
      transition(s,status,time(d),reason);await(d.persist??atomicJson)(join(directory(c,id),'state.json'),validateState(s,b));return s;
    };
    // A recorded create intent is a permanent fence against another create request.
    const attempted=()=>s.events.some(e=>e.type==='pr_intent');
    const inspect=async():Promise<Remote|undefined>=>{try{return await remote.inspect(b);}catch{return undefined;}};
    const reconcile=async(r:Remote):Promise<State|undefined>=>{
      if(r.repositoryId!==b.target.repositoryId||r.headCommit!==undefined&&r.headCommit!==b.headCommit||r.pulls.length>1) return save('blocked','remote_conflict');
      if(r.pulls.length) {
        s.pull=r.pulls[0];
        if(!attempted()||r.headCommit!==b.headCommit||!exactPull(s.pull,b)) return save('blocked','remote_conflict');
        if(r.baseCommit!==b.target.baseCommit) return save('blocked','stale_base');
        if(s.status==='published') return s;
        return save('published','remote_observed');
      }
      if(s.pull||s.status==='published') return save('blocked','remote_conflict');
      if(r.baseCommit!==b.target.baseCommit) return save('blocked','stale_base');
      return undefined;
    };
    let r=await inspect();if(!r) return save('unknown','remote_uncertain');
    const observed=await reconcile(r);if(observed)return observed;
    if(s.status==='blocked') return s;
    if(attempted()) return save('unknown','remote_uncertain');
    // Expiry prevents new writes; it does not prevent observing an already-created PR.
    if(Date.parse(s.approval.expiresAt)<=Date.parse(time(d))||Date.parse(s.approval.approvedAt)>Date.parse(time(d))) return save('blocked','stale_approval');
    if(!r.headCommit) {
      await save('push_intent','effect_intent');
      try {await remote.push(b,repo);}catch {/* Only remote observation can resolve a lost response. */}
      r=await inspect();if(!r)return save('unknown','remote_uncertain');
      const result=await reconcile(r);if(result)return result;
      if(!r.headCommit)return save('unknown','remote_uncertain');
    }
    await save('branch_published','remote_observed');
    // Recheck immediately before create. GitHub offers no transaction locking the base.
    r=await inspect();if(!r)return save('unknown','remote_uncertain');
    const result=await reconcile(r);if(result)return result;
    if(r.headCommit!==b.headCommit)return save('blocked','remote_conflict');
    if(Date.parse(s.approval.expiresAt)<=Date.parse(time(d)))return save('blocked','stale_approval');
    await save('pr_intent','effect_intent');
    let created:Pull|undefined;
    try {created=await remote.create(b);}catch {/* Never blindly repeat this POST. */}
    if(created) {s.pull=created;if(!exactPull(created,b))return save('blocked','remote_conflict');}
    r=await inspect();if(!r)return save('unknown','remote_uncertain');
    return await reconcile(r)??save('unknown','remote_uncertain');
  });
}
