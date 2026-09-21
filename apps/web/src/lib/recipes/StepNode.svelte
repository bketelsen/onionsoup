<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';

  let { data, selected }: NodeProps & { data: { stepId: string; capability: string; summary: string[]; problem?: string } } = $props();
</script>

<div class="step" class:selected class:problem={Boolean(data.problem)}>
  <Handle type="target" position={Position.Left} />
  <div class="id">{data.stepId}</div>
  <div class="cap">{data.capability}</div>
  {#each data.summary as line}<div class="line">{line}</div>{/each}
  {#if data.problem}<div class="err">{data.problem}</div>{/if}
  <Handle type="source" position={Position.Right} />
</div>

<style>
  .step { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 0.8rem; min-width: 200px; max-width: 280px; font-size: 0.85rem; color: var(--text); }
  .step.selected { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
  .step.problem { border-color: var(--danger); }
  .id { font-weight: 700; }
  .cap { color: var(--accent); font-family: ui-monospace, monospace; font-size: 0.8rem; margin-bottom: 0.3rem; }
  .line { color: var(--muted); font-size: 0.78rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .err { color: var(--danger); font-size: 0.78rem; margin-top: 0.3rem; }
</style>
