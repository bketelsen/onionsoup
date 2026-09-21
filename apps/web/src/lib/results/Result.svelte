<script lang="ts">
  import Markdown from '../Markdown.svelte';
  import Readiness from './Readiness.svelte';
  import Location from './Location.svelte';

  let { capability, result }: { capability: string; result: unknown } = $props();
  const r = $derived(result as Record<string, any>);
  const markdown = $derived(typeof r?.markdown === 'string' ? (r.markdown as string) : undefined);
</script>

{#if capability === 'issue.readiness'}
  <Readiness run={r.run} issue={r.issue} />
{:else if capability === 'code.location'}
  <Location run={r.handoff.location} repository={r.handoff.repository} disposition={r.handoff.disposition} reason={r.handoff.reason} />
{:else if capability === 'investigation.packet'}
  {@const p = r.packet}
  <p><span class="tag">packet {p.status}</span> <span class="tag">location {String(p.locationDisposition).replaceAll('_', ' ')}</span></p>
  <h3>Readiness</h3>
  {#if p.readiness}
    <Readiness run={p.readiness} issue={{ number: p.issue.number, title: p.issue.title, state: 'open', updatedAt: p.issue.updatedAt, snapshot: { repository: p.issue.repository } }} />
  {:else}
    <p class="error">{p.failure ?? 'Readiness did not run.'}</p>
  {/if}
  <h3>Starting points</h3>
  <Location run={p.location} repository={p.repository} disposition={p.locationDisposition} />
  <details><summary>Packet Markdown</summary>{#if markdown}<Markdown source={markdown} />{/if}</details>
{:else if markdown}
  <Markdown source={markdown} />
{:else}
  <pre>{JSON.stringify(result, null, 2)}</pre>
{/if}

<style>
  h3 { font-size: 1rem; margin: 1rem 0 0.4rem; }
</style>
