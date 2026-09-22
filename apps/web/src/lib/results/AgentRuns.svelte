<script lang="ts">
  type Stage = { agent: string; run: { status: string; provider?: string; model?: string } };
  let { stages }: { stages: Stage[] } = $props();
  const describe = (stage: Stage) => [stage.agent, stage.run.status, stage.run.model ? `on ${stage.run.provider}/${stage.run.model}` : ''].filter(Boolean).join(' ');
</script>

{#if stages.length}
  <p class="muted small">{stages.map(describe).join(' · ')}</p>
{/if}

<style>
  .small { font-size: 0.8rem; }
</style>
