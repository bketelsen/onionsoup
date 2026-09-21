<script lang="ts">
  type Citation = { path: string; startLine: number; endLine: number; quote: string; symbol?: string | null; reason: string; relevance?: string };
  type Brief = { status: string; summary: string; codePointers: Citation[]; testPointers: Citation[]; uncertainties: string[]; testSearch?: { status: string; reason: string } };
  type Run = { status: string; brief?: Brief; failure?: string; provider?: string; model?: string; promptVersion?: string; tokenUsage?: { totals?: Record<string, number> } };

  let { run, repository, disposition, reason }: { run?: Run; repository: { name: string; commit: string }; disposition?: string; reason?: string } = $props();
  const brief = $derived(run?.brief);

  function link(c: Citation) {
    const path = c.path.split('/').map(encodeURIComponent).map((s) => s.replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');
    return `https://github.com/${repository.name}/blob/${repository.commit}/${path}#L${c.startLine}-L${c.endLine}`;
  }
</script>

<p>
  <span class="tag">commit {repository.commit.slice(0, 12)}</span>
  {#if disposition}<span class="tag">{disposition.replaceAll('_', ' ')}</span>{/if}
  {#if reason}<span class="tag">{reason.replaceAll('_', ' ')}</span>{/if}
</p>
{#if brief}
  <p>{brief.summary}</p>
  {#if brief.testSearch}<p class="muted">Bounded test search {brief.testSearch.status}: {brief.testSearch.reason}</p>{/if}
  {#each [['Code', brief.codePointers], ['Tests', brief.testPointers]] as [label, pointers]}
    <h3>{label}</h3>
    {#if !pointers.length}
      <p class="muted">No {label.toLowerCase()} location established within this bounded run.</p>
    {/if}
    {#each pointers as c}
      <div class="citation">
        <div class="head">
          <a href={link(c)} target="_blank" rel="noopener noreferrer"><code>{c.path}:{c.startLine}–{c.endLine}</code></a>
          {#if c.symbol}<code class="symbol">{c.symbol}</code>{/if}
          {#if c.relevance}<span class="tag">{c.relevance}</span>{/if}
        </div>
        <p class="reason">{c.reason}</p>
        <pre>{c.quote}</pre>
      </div>
    {/each}
  {/each}
  <h3>Uncertainties</h3>
  <ul>{#each brief.uncertainties as u}<li>{u}</li>{/each}</ul>
{:else if run}
  <p class="error">Location {run.status}{run.failure ? `: ${run.failure}` : ''}</p>
{:else}
  <p class="muted">Location was not attempted.</p>
{/if}
{#if run?.provider}
  <p class="muted small">{run.provider} · {run.model} · {run.promptVersion}{#if run.tokenUsage?.totals} · tokens {run.tokenUsage.totals.inputTokens ?? '?'} in / {run.tokenUsage.totals.outputTokens ?? '?'} out{/if}</p>
{/if}

<style>
  h3 { font-size: 0.95rem; margin: 1rem 0 0.4rem; }
  .citation { border: 1px solid var(--line); border-radius: 6px; padding: 0.6rem 0.8rem; margin: 0.5rem 0; background: var(--panel); }
  .head { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .symbol { color: var(--muted); }
  .reason { margin: 0.4rem 0; }
  pre { margin: 0; max-height: 16rem; }
  .small { font-size: 0.8rem; }
</style>
