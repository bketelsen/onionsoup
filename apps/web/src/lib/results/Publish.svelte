<script lang="ts">
  import Markdown from '../Markdown.svelte';
  import { shortCommit } from '../format.ts';

  type Pull = { number: number; url: string; title: string; body?: string; head: string; base: string; headCommit: string; draft: boolean; state: string; merged: boolean };
  let { result }: { result: unknown } = $props();
  const publication = $derived(result as { status: string; publicationId: string; pull?: Pull });
  const pull = $derived(publication.pull);
  const state = $derived(pull ? (pull.merged ? 'merged' : pull.draft ? `draft · ${pull.state}` : pull.state) : '');
</script>

{#if pull}
  <div class="pull">
    <p class="title"><a href={pull.url} target="_blank" rel="noopener noreferrer">#{pull.number} {pull.title}</a> <span class="tag">{state}</span></p>
    <p class="muted"><code>{pull.head}</code> → <code>{pull.base}</code> at <code>{shortCommit(pull.headCommit)}</code></p>
    {#if pull.body}<details><summary>Description</summary><Markdown source={pull.body} /></details>{/if}
  </div>
{:else}
  <p class={publication.status === 'published' ? '' : 'error'}>Publication {publication.status.replaceAll('_', ' ')}.</p>
{/if}

<style>
  .pull { display: grid; gap: 0.2rem; }
  .pull p { margin: 0.2rem 0; }
  .title { font-size: 1.05rem; }
</style>
