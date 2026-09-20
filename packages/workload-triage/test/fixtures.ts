import { randomUUID } from 'node:crypto';
import { WorkloadObservation, type WorkloadFact } from '@onionsoup/kubernetes-source/workloads';
export const rid=(n:number)=>'r-'+n.toString(16).padStart(64,'0');
const base=(n:number)=>({id:rid(n),namespaceId:rid(100),createdAt:'2026-09-01T00:00:00Z',deletingAt:null,ownerId:null,ownerKind:null});
export function fixture(name:string,now=new Date()):WorkloadObservation{
  const pod:WorkloadFact={...base(1),kind:'Pod',ownerId:rid(2),ownerKind:'Job',phase:'Failed',ready:'False',reason:'None',containers:[{kind:'main',restarts:0,ready:false,waiting:'None',terminated:'Error',exitCode:1,finishedAt:'2026-09-10T00:00:00Z',lastTerminated:'None',lastExitCode:null,lastFinishedAt:null}]};
  let owner:WorkloadFact={...base(2),kind:'Job',complete:'True',failed:'Unknown',active:null,succeeded:1,failures:1};
  if(name==='replaced') {pod.ownerKind='ReplicaSet';owner={...base(2),kind:'ReplicaSet',generation:2,observedGeneration:2,desired:1,ready:1,available:1,updated:1};}
  if(name==='crashloop'){pod.phase='Running';pod.containers[0]={...pod.containers[0],waiting:'CrashLoopBackOff',terminated:'None',exitCode:null,finishedAt:null,restarts:7};owner={...base(2),kind:'Job',complete:'Unknown',failed:'Unknown',active:1,succeeded:null,failures:null};}
  const at=now.toISOString();
  const record=WorkloadObservation.parse({schemaVersion:1,kind:'workload-observation',runId:randomUUID(),assetId:'fixture-cluster',targetHash:'a'.repeat(64),commandVersion:'k3s-workloads-v1',startedAt:at,finishedAt:at,status:'completed',
    queries:['pods','jobs','replicasets','deployments'].map(section=>({section,commandHash:'b'.repeat(64),status:'collected',startedAt:at,finishedAt:at})),eligible:1,omitted:0,selected:[rid(1)],facts:name==='missing-owner'?[pod]:[pod,owner]});
  if(name==='incomplete'){record.status='partial';record.queries[1].status='failed';record.queries[1].failure='query_failed';record.facts=[pod];}
  if(name==='stale'){record.startedAt=record.finishedAt=new Date(now.getTime()-3600000).toISOString();}
  return WorkloadObservation.parse(record);
}
export const cases=[['completed-job','historical'],['replaced','historical'],['crashloop','attention_now'],['missing-owner','insufficient_evidence'],['incomplete','insufficient_evidence'],['stale','insufficient_evidence']] as const;
