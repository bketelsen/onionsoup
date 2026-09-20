import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '@onionsoup/runtime/storage';
import { boundedSshArguments, runSshProcess, type QueryResult } from '@onionsoup/runtime/ssh';
import { KubernetesTarget } from './index.ts';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ResourceId = z.string().regex(/^r-[a-f0-9]{64}$/);
const resourceId = (kind: string, ns: string, uid: string) => `r-${digest([kind, ns, uid])}`;
const LegacySection = z.enum(['pods','jobs','replicasets','deployments']);
export const WorkloadSection = z.enum([...LegacySection.options,'workflows.argoproj.io']);
export type WorkloadSection = z.infer<typeof WorkloadSection>;
const field = (s: string) => `{${s}}{"|"}`;
const common = ['.metadata.uid','.metadata.namespace','.metadata.name','.metadata.creationTimestamp','.metadata.deletionTimestamp',
  '.metadata.ownerReferences[?(@.controller==true)].kind','.metadata.ownerReferences[?(@.controller==true)].uid'].map(field).join('');
const container = (path: string, kind: string) => `{range ${path}[*]}{"${kind},"}{.restartCount}{","}{.ready}{","}{.state.waiting.reason}{","}{.state.terminated.reason}{","}{.state.terminated.exitCode}{","}{.state.terminated.finishedAt}{","}{.lastState.terminated.reason}{","}{.lastState.terminated.exitCode}{","}{.lastState.terminated.finishedAt}{";"}{end}`;
const templates: Record<WorkloadSection,string> = {
  'workflows.argoproj.io': common + ['.status.phase','.status.finishedAt'].map(field).join(''),
  pods: common + ['.status.phase','.status.conditions[?(@.type=="Ready")].status','.status.reason'].map(field).join('') + container('.status.initContainerStatuses','init') + container('.status.containerStatuses','main'),
  jobs: common + ['.status.conditions[?(@.type=="Complete")].status','.status.conditions[?(@.type=="Failed")].status','.status.active','.status.succeeded','.status.failed'].map(field).join(''),
  replicasets: common + ['.metadata.generation','.status.observedGeneration','.spec.replicas','.status.readyReplicas','.status.availableReplicas','.status.replicas'].map(field).join(''),
  deployments: common + ['.metadata.generation','.status.observedGeneration','.spec.replicas','.status.readyReplicas','.status.availableReplicas','.status.updatedReplicas'].map(field).join(''),
};
export function workloadCommand(raw: unknown, section: WorkloadSection) {
  const target=KubernetesTarget.parse(raw); WorkloadSection.parse(section);
  return `test -x /usr/bin/k3s || exit 69; exec ${target.access==='sudo'?'/usr/bin/sudo -n ':''}/usr/bin/k3s kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml --context=default --server=https://127.0.0.1:6443 --request-timeout=10s --cache-dir=/dev/null get ${section} --all-namespaces --chunk-size=200 -o 'jsonpath={"v2\\n"}{range .items[*]}${templates[section].replace(common,common+field('.metadata.ownerReferences[?(@.controller==true)].apiVersion'))}{"\\n"}{end}'`;
}
const Time=z.iso.datetime().nullable(), Count=z.number().int().min(0).max(1000000).nullable();
const Ready=z.enum(['True','False','Unknown']);
const Reason=z.enum(['Completed','Error','OOMKilled','ContainerCannotRun','DeadlineExceeded','Evicted','NodeLost','Shutdown','CrashLoopBackOff','ImagePullBackOff','ErrImagePull','CreateContainerConfigError','ContainerCreating','PodInitializing','Other','None']);
const Base={id:ResourceId,namespaceId:ResourceId,createdAt:Time,deletingAt:Time,ownerId:ResourceId.nullable(),ownerKind:z.enum(['Job','ReplicaSet','Deployment','StatefulSet','DaemonSet','CronJob','Workflow','Other']).nullable()};
export const PodFact=z.object({...Base,kind:z.literal('Pod'),phase:z.enum(['Pending','Running','Succeeded','Failed','Unknown']),ready:Ready,reason:Reason,
  containers:z.array(z.object({kind:z.enum(['init','main']),restarts:Count,ready:z.boolean().nullable(),waiting:Reason,terminated:Reason,exitCode:z.number().int().nullable(),finishedAt:Time,lastTerminated:Reason,lastExitCode:z.number().int().nullable(),lastFinishedAt:Time}).strict()).max(32)}).strict();
export const JobFact=z.object({...Base,kind:z.literal('Job'),complete:Ready,failed:Ready,active:Count,succeeded:Count,failures:Count}).strict();
export const ReplicaFact=z.object({...Base,kind:z.enum(['ReplicaSet','Deployment']),generation:Count,observedGeneration:Count,desired:Count,ready:Count,available:Count,updated:Count}).strict();
export const WorkflowFact=z.object({...Base,kind:z.literal('Workflow'),phase:z.enum(['Pending','Running','Succeeded','Failed','Error','Unknown']),finishedAt:Time}).strict();
export const WorkloadFact=z.union([PodFact,JobFact,ReplicaFact,WorkflowFact]); export type WorkloadFact=z.infer<typeof WorkloadFact>;
const known=(schema:typeof Ready|typeof Reason,value:string)=>{const p=schema.safeParse(value);return p.success?p.data:schema===Ready?'Unknown':value?'Other':'None';};
const count=(s:string)=>s===''?null:z.number().int().min(0).max(1000000).parse(Number(s));
const time=(s:string)=>s===''?null:z.iso.datetime().parse(s);
const exit=(s:string)=>s===''?null:z.number().int().min(-2147483648).max(2147483647).parse(Number(s));
export function parseWorkloadProjection(section:WorkloadSection,stdout:string) {
  WorkloadSection.parse(section);
  const version=stdout.startsWith('v2\n')?2:1;
  if(section==='workflows.argoproj.io'&&version!==2)throw new Error('Workflow requires v2');
  if(Buffer.byteLength(stdout)>256*1024||!stdout.startsWith(`v${version}\n`)||!stdout.endsWith('\n'))throw new Error('Invalid projection');
  const rows=stdout===`v${version}\n`?[]:stdout.slice(3,-1).split('\n');if(rows.length>5000)throw new Error('Row limit');
  const lookup:Record<string,{namespace:string;name:string;kind:string}>={};
  const facts=rows.map(row=>{
    const f=row.split('|'),kind={pods:'Pod',jobs:'Job',replicasets:'ReplicaSet',deployments:'Deployment','workflows.argoproj.io':'Workflow'}[section];
    const ownerApi=version===2?f.splice(7,1)[0]:'';
    if(version===2&&!/^[a-zA-Z0-9./-]{0,100}$/.test(ownerApi))throw new Error('Invalid owner API');
    if(f.length!==(section==='pods'?11:section==='jobs'?13:section==='workflows.argoproj.io'?10:14))throw new Error('Invalid columns');
    if(!/^[a-f0-9-]{36}$/.test(f[0])||![f[1],f[2]].every(s=>/^[a-z0-9][a-z0-9.-]{0,252}$/.test(s)))throw new Error('Invalid identity');
    if(f[6]&&!/^[a-f0-9-]{36}$/.test(f[6])||f[5]&&!/^[A-Za-z]{1,40}$/.test(f[5])||Boolean(f[5])!==Boolean(f[6]))throw new Error('Invalid owner');
    const id=resourceId(kind,f[1],f[0]); if(lookup[id])throw new Error('Duplicate identity'); lookup[id]={namespace:f[1],name:f[2],kind};
    const base={id,kind,namespaceId:resourceId('Namespace','',f[1]),createdAt:time(f[3]),deletingAt:time(f[4]),ownerId:f[6]?resourceId(f[5],f[1],f[6]):null,
      ownerKind:f[5]?(['Job','ReplicaSet','Deployment','StatefulSet','DaemonSet','CronJob'].includes(f[5])?f[5]:f[5]==='Workflow'&&ownerApi==='argoproj.io/v1alpha1'?'Workflow':'Other'):null};
    if(section==='pods'){
      if(![f[7],f[8],f[9]].every(s=>/^[A-Za-z]{0,80}$/.test(s)))throw new Error('Invalid status');
      const containers=f[10]?f[10].replace(/;$/,'').split(';').map(raw=>{const c=raw.split(',');if(c.length!==10||![c[3],c[4],c[7]].every(s=>/^[A-Za-z]{0,80}$/.test(s)))throw new Error('Invalid container');
        return {kind:c[0],restarts:count(c[1]),ready:c[2]===''?null:z.enum(['true','false']).parse(c[2])==='true',waiting:known(Reason,c[3]),terminated:known(Reason,c[4]),exitCode:exit(c[5]),finishedAt:time(c[6]),lastTerminated:known(Reason,c[7]),lastExitCode:exit(c[8]),lastFinishedAt:time(c[9])};}):[];
      return PodFact.parse({...base,phase:['Pending','Running','Succeeded','Failed'].includes(f[7])?f[7]:'Unknown',ready:known(Ready,f[8]),reason:known(Reason,f[9]),containers});
    }
    if(section==='workflows.argoproj.io')return WorkflowFact.parse({...base,phase:WorkflowFact.shape.phase.safeParse(f[7]).success?f[7]:'Unknown',finishedAt:time(f[8])});
    if(section==='jobs')return JobFact.parse({...base,complete:known(Ready,f[7]),failed:known(Ready,f[8]),active:count(f[9]),succeeded:count(f[10]),failures:count(f[11])});
    return ReplicaFact.parse({...base,generation:count(f[7]),observedGeneration:count(f[8]),desired:count(f[9]),ready:count(f[10]),available:count(f[11]),updated:count(f[12])});
  });
  return {facts,lookup};
}
const Query=z.object({section:WorkloadSection,commandHash:z.string().length(64),status:z.enum(['pending','running','collected','failed','not_attempted']),
  startedAt:z.iso.datetime().optional(),finishedAt:z.iso.datetime().optional(),failure:z.enum(['cli_unavailable','ssh_failed','query_failed','timeout','cancelled','output_limit','invalid_output']).optional()}).strict();
const observationShape={schemaVersion:z.literal(1),kind:z.literal('workload-observation'),runId:z.uuid(),assetId:KubernetesTarget.shape.assetId,
  targetHash:z.string().regex(/^[a-f0-9]{64}$/),commandVersion:z.literal('k3s-workloads-v1'),startedAt:z.iso.datetime(),finishedAt:z.iso.datetime().optional(),
  status:z.enum(['running','completed','partial','failed']),queries:z.array(Query).length(4),eligible:Count,omitted:Count,selected:z.array(ResourceId).max(10),facts:z.array(WorkloadFact).max(40),
};
const legacyOwner=z.enum(['Job','ReplicaSet','Deployment','StatefulSet','DaemonSet','CronJob','Other']).nullable();
const legacyFacts=z.union([PodFact.extend({ownerKind:legacyOwner}),JobFact.extend({ownerKind:legacyOwner}),ReplicaFact.extend({ownerKind:legacyOwner})]);
const observationV1=z.object({...observationShape,queries:z.array(Query.extend({section:LegacySection})).length(4),facts:z.array(legacyFacts).max(40)}).strict();
const observationV2=z.object({...observationShape,schemaVersion:z.literal(2),commandVersion:z.literal('k3s-workloads-v2'),queries:z.array(Query).length(5)}).strict();
export const WorkloadObservation=z.union([observationV1,observationV2]).superRefine((r,c)=>{
  const expected=r.schemaVersion===1?4:5;
  const ids=r.facts.map(f=>f.id),n=r.queries.filter(q=>q.status==='collected').length;
  if(new Set(ids).size!==ids.length||new Set(r.selected).size!==r.selected.length||new Set(r.queries.map(q=>q.section)).size!==expected||
    r.selected.some(id=>!r.facts.some(f=>f.id===id&&f.kind==='Pod'))||r.status!=='running'&&(!r.finishedAt||r.status!==(n===expected?'completed':n?'partial':'failed')||r.queries.some(q=>['pending','running'].includes(q.status)))||
    (r.eligible===null)!==(r.omitted===null)||r.eligible!==null&&r.eligible!==r.selected.length+r.omitted!||r.queries.some(q=>(['failed','not_attempted'].includes(q.status))!==Boolean(q.failure)))c.addIssue({code:'custom',message:'Invalid observation invariants'});
});
export type WorkloadObservation=z.infer<typeof WorkloadObservation>;
export function selectWorkloadFacts(facts:WorkloadFact[]){
  const pods=facts.filter((f):f is z.infer<typeof PodFact>=>f.kind==='Pod'&&(f.phase==='Failed'||f.phase==='Unknown'||f.phase==='Pending'||f.phase==='Running'&&(f.ready!=='True'||f.containers.some(c=>(c.restarts??0)>0))));
  const priority=(p:z.infer<typeof PodFact>)=>p.phase==='Failed'?0:p.phase==='Running'&&p.ready==='True'?2:1;
  pods.sort((a,b)=>priority(a)-priority(b)||a.id.localeCompare(b.id));
  const selected=pods.slice(0,10).map(p=>p.id),byId=new Map(facts.map(f=>[f.id,f])),retained=new Map<string,WorkloadFact>();
  for(const id of selected){let current=byId.get(id);for(let depth=0;current&&depth<3;depth++){retained.set(current.id,current);current=current.ownerId?byId.get(current.ownerId):undefined;}}
  return {eligible:pods.length,omitted:pods.length-selected.length,selected,facts:[...retained.values()]};
}
export type WorkloadTransport=(target:z.infer<typeof KubernetesTarget>,section:WorkloadSection,signal:AbortSignal)=>Promise<QueryResult>;
export async function collectWorkloads(raw:unknown,options:{directory:string;signal?:AbortSignal;transport?:WorkloadTransport}){
  const target=KubernetesTarget.parse(raw);const record:WorkloadObservation={schemaVersion:2,kind:'workload-observation',runId:randomUUID(),assetId:target.assetId,targetHash:digest(target),commandVersion:'k3s-workloads-v2',startedAt:new Date().toISOString(),status:'running',
    queries:WorkloadSection.options.map(section=>({section,commandHash:digest(workloadCommand(target,section)),status:'pending'})),eligible:null,omitted:null,selected:[],facts:[]};
  await mkdir(options.directory,{mode:0o700});const save=()=>atomicJson(join(options.directory,'observation.json'),WorkloadObservation.parse(record));await save();
  const deadline=AbortSignal.timeout(105000),signal=AbortSignal.any([deadline,...(options.signal?[options.signal]:[])]);
  const facts:WorkloadFact[]=[],lookup:Record<string,{namespace:string;name:string;kind:string}>={};
  for(const q of record.queries){
    if(signal.aborted){q.status='not_attempted';q.failure=deadline.aborted?'timeout':'cancelled';await save();continue;}
    q.status='running';q.startedAt=new Date().toISOString();await save();let stage:'query_failed'|'invalid_output'='query_failed';
    try{const response=await(options.transport??((t,s,a)=>runSshProcess(boundedSshArguments(t,workloadCommand(t,s)),a)))(target,q.section,signal);
      if(response.failure||signal.aborted){q.status='failed';q.failure=deadline.aborted?'timeout':signal.aborted?'cancelled':response.failure;}
      else if(response.code!==0){q.status='failed';q.failure=response.code===69?'cli_unavailable':response.code===255?'ssh_failed':'query_failed';}
      else{stage='invalid_output';if(!response.stdout.startsWith('v2\n'))throw new Error('Projection version mismatch');const parsed=parseWorkloadProjection(q.section,response.stdout);facts.push(...parsed.facts);Object.assign(lookup,parsed.lookup);q.status='collected';}
    }catch{q.status='failed';q.failure=stage;}
    q.finishedAt=new Date().toISOString();await save();
  }
  if(record.queries[0].status==='collected')Object.assign(record,selectWorkloadFacts(facts));
  const n=record.queries.filter(q=>q.status==='collected').length;record.status=n===5?'completed':n?'partial':'failed';record.finishedAt=new Date().toISOString();
  await atomicJson(join(options.directory,'resources.private.json'),Object.fromEntries(record.facts.map(f=>[f.id,lookup[f.id]])));
  await save();return record;
}
