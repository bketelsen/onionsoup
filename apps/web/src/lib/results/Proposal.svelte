<script lang="ts">
  import AgentRuns from './AgentRuns.svelte';
  import { workflowOf, proposalOf, type Claim } from './proposal.ts';
  import { shortCommit } from '../format.ts';

  let { result }: { result: unknown } = $props();
  const workflow = $derived(workflowOf(result));
  const proposal = $derived(proposalOf(workflow));
  const issue = $derived(workflow.parent.issue);
  const repository = $derived(workflow.parent.repository);
  const blob = (path: string, start: number, end: number) => `https://github.com/${repository.name}/blob/${repository.commit}/${path}#L${start}-L${end}`;
  const sections = $derived<[string, Claim[]][]>(proposal ? [['Changes', proposal.changes], ['Not in scope', proposal.nonGoals], ['Risks', proposal.risks]] : []);
</script>

<p class="issue">
  <a href={`https://github.com/${issue.repository}/issues/${issue.number}`} target="_blank" rel="noopener noreferrer">#{issue.number}</a> {issue.title}
  <span class="muted">at <code>{shortCommit(repository.commit)}</code></span>
</p>

{#if proposal}
  <p><span class={`tag readiness ${proposal.status}`}>{proposal.status.replaceAll('_', ' ')}</span></p>
  <p class="lead">{proposal.outcome.text}</p>

  {#if proposal.questions.length}
    <h3>Questions</h3>
    <ul>{#each proposal.questions as question}<li>{#if question.blocking}<span class="tag blocking">blocking</span> {/if}{question.question}</li>{/each}</ul>
  {/if}

  {#each sections as [heading, claims]}
    {#if claims.length}
      <h3>{heading}</h3>
      <ul>{#each claims as claim}<li>{claim.text} {#if claim.basis === 'reported'}<span class="tag">reported</span>{/if}</li>{/each}</ul>
    {/if}
  {/each}

  {#if proposal.acceptanceCriteria.length}
    <h3>Acceptance criteria</h3>
    <ul>{#each proposal.acceptanceCriteria as item}<li><strong>{item.id}</strong> {item.criterion.text}</li>{/each}</ul>
  {/if}
  {#if proposal.verification.length}
    <details>
      <summary>Verification plan ({proposal.verification.length})</summary>
      <ul>{#each proposal.verification as plan}<li><span class="tag">{plan.kind}</span> {plan.check.text} <span class="muted">({plan.criterionIds.join(', ')}; before: {plan.baselineExpectation.replaceAll('_', ' ')})</span></li>{/each}</ul>
    </details>
  {/if}
{:else}
  <p class="error">No proposal was produced ({workflow.status}).</p>
{/if}

{#if workflow.preparation?.sources.length}
  <h3>Cited sources</h3>
  <ul>
    {#each workflow.preparation.sources as source}
      <li><a href={blob(source.path, source.startLine, source.endLine)} target="_blank" rel="noopener noreferrer"><code>{source.path}:{source.startLine}–{source.endLine}</code></a>{#if source.relevance}{' '}<span class="tag">{source.relevance.replaceAll('_', ' ')}</span>{/if}</li>
    {/each}
  </ul>
{/if}

<AgentRuns stages={workflow.stages.flatMap((stage) => (stage.run ? [{ agent: stage.agent, run: stage.run }] : []))} />

<style>
  .issue { font-size: 1.05rem; }
  .lead { font-size: 1.02rem; }
  h3 { font-size: 0.95rem; margin: 1rem 0 0.4rem; }
  .readiness.proposal_ready { background: var(--ok); color: #fff; border-color: transparent; }
  .readiness.needs_information { background: var(--warn); color: #111; border-color: transparent; }
  .blocking { border-color: var(--danger); color: var(--danger); }
</style>
