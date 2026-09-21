<script lang="ts">
  type Assessment = {
    kind: string;
    bug_readiness: string;
    summary: string;
    evidence: { field: string; source: string; quote: string }[];
    questions: { field: string; question: string }[];
  };
  type Run = { status: string; assessment?: Assessment; failure?: string; provider?: string; model?: string; promptVersion?: string; tokenUsage?: { totals?: Record<string, number> } };
  type Issue = { number: number; title: string; state: string; updatedAt: string; snapshot?: { repository: string } };

  let { run, issue }: { run: Run; issue?: Issue } = $props();
  const a = $derived(run.assessment);
  const url = $derived(issue?.snapshot ? `https://github.com/${issue.snapshot.repository}/issues/${issue.number}` : undefined);
</script>

{#if issue}
  <p class="issue">
    {#if url}<a href={url} target="_blank" rel="noopener noreferrer">#{issue.number}</a>{:else}#{issue.number}{/if}
    {issue.title} <span class="tag">{issue.state}</span>
  </p>
{/if}
{#if a}
  <p>
    <span class="tag">{a.kind.replaceAll('_', ' ')}</span>
    <span class={`tag readiness ${a.bug_readiness}`}>{a.bug_readiness.replaceAll('_', ' ')}</span>
  </p>
  <p>{a.summary}</p>
  {#if a.evidence.length}
    <h3>Evidence</h3>
    {#each a.evidence as e}
      <div class="evidence">
        <div class="field">{e.field.replaceAll('_', ' ')} <span class="muted">from {e.source}</span></div>
        <blockquote>{e.quote}</blockquote>
      </div>
    {/each}
  {/if}
  {#if a.questions.length}
    <h3>Questions for the reporter</h3>
    <ul>{#each a.questions as q}<li><strong>{q.field.replaceAll('_', ' ')}:</strong> {q.question}</li>{/each}</ul>
  {/if}
{:else}
  <p class="error">Readiness {run.status}{run.failure ? `: ${run.failure}` : ''}</p>
{/if}
<p class="muted small">
  {#if run.provider}{run.provider} · {run.model} · {run.promptVersion}{/if}
  {#if run.tokenUsage?.totals} · tokens {run.tokenUsage.totals.inputTokens ?? '?'} in / {run.tokenUsage.totals.outputTokens ?? '?'} out{/if}
</p>

<style>
  .issue { font-size: 1.05rem; }
  .readiness.ready { background: var(--ok); color: #fff; border-color: transparent; }
  .readiness.needs_information { background: var(--warn); color: #111; border-color: transparent; }
  .evidence { margin: 0.5rem 0; }
  .field { font-weight: 600; font-size: 0.9rem; }
  blockquote { border-left: 3px solid var(--line); margin: 0.3rem 0; padding-left: 0.8rem; white-space: pre-wrap; }
  .small { font-size: 0.8rem; }
  h3 { font-size: 0.95rem; margin: 1rem 0 0.4rem; }
</style>
