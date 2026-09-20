import { z } from 'zod';
import { TrueNasTarget, TrueNasRun, collectTrueNasHealth } from '@onionsoup/truenas-source';
import { ContainerTarget, ContainerRun, collectContainerInventory } from '@onionsoup/container-source';
import { KubernetesTarget, KubernetesRun, collectKubernetes } from '@onionsoup/kubernetes-source';
import { digest } from '@onionsoup/kubernetes-source/workloads';
const SourceId=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const RefreshSource=z.discriminatedUnion('kind',[
  z.object({sourceId:SourceId,kind:z.literal('truenas'),target:TrueNasTarget}).strict(),
  z.object({sourceId:SourceId,kind:z.literal('containers'),target:ContainerTarget}).strict(),
  z.object({sourceId:SourceId,kind:z.literal('kubernetes'),target:KubernetesTarget}).strict(),
]);
export type RefreshSource=z.infer<typeof RefreshSource>;
export function validateRefresh(source:RefreshSource,raw:unknown){
  const observation=(source.kind==='truenas'?TrueNasRun:source.kind==='containers'?ContainerRun:KubernetesRun).parse(raw);
  if(observation.assetId!==source.target.assetId||observation.targetHash!==digest(source.target)||observation.status==='running'||!observation.finishedAt)throw Error('Refresh provenance mismatch');
  return observation;
}
export type RefreshOptions={directory:string;signal:AbortSignal;apiKey?:string};
export async function collectRefresh(source:RefreshSource,options:RefreshOptions){
  return source.kind==='truenas'?collectTrueNasHealth(source.target,{...options,apiKey:options.apiKey??''}):
    source.kind==='containers'?collectContainerInventory(source.target,options):collectKubernetes(source.target,options);
}
