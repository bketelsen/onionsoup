<script lang="ts">
  import Markdown from '../Markdown.svelte';
  import Readiness from './Readiness.svelte';
  import Location from './Location.svelte';

  let { result }: { result: unknown } = $props();
  const r = $derived(result as { packet: any; markdown?: string });
  const p = $derived(r.packet);
</script>

<p><span class="tag">packet {p.status}</span> <span class="tag">location {String(p.locationDisposition).replaceAll('_', ' ')}</span></p>
<h3>Readiness</h3>
{#if p.readiness}
  <Readiness run={p.readiness} issue={{ number: p.issue.number, title: p.issue.title, state: 'open', updatedAt: p.issue.updatedAt, snapshot: { repository: p.issue.repository } }} />
{:else}
  <p class="error">{p.failure ?? 'Readiness did not run.'}</p>
{/if}
<h3>Starting points</h3>
<Location run={p.location} repository={p.repository} disposition={p.locationDisposition} />
{#if r.markdown}
  <details><summary>Packet Markdown</summary><Markdown source={r.markdown} /></details>
{/if}

<style>
  h3 { font-size: 1rem; margin: 1rem 0 0.4rem; }
</style>
