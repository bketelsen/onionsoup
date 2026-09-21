<script lang="ts">
  import { store } from '../store.svelte.ts';

  const runs = $derived(store.jobList.filter((j) => j.capability.startsWith('recipe.')));
</script>

<h1>Recipes</h1>
<p class="muted">A recipe chains capabilities you already have. Each step becomes an ordinary job; later steps bind to earlier jobs by ID.</p>
<p><a class="button" href="#/recipes/new">New recipe</a></p>

{#if store.recipes.length === 0}
  <p>No recipes yet.</p>
{:else}
  <div class="grid">
    {#each store.recipes as r (r.id)}
      <div class="card">
        <h2><a href={`#/recipes/${r.id}`}>{r.title}</a> <span class="muted">{r.id}</span></h2>
        <p>{r.description}</p>
        <p class="steps">{#each r.steps as s, i}{#if i}<span class="arrow">→</span>{/if}<span class="tag">{s.capability}</span>{/each}</p>
        <p class="actions">
          <a class="button small" href={`#/run/recipe.${r.id}`}>Run</a>
          <a class="button secondary small" href={`#/recipes/${r.id}`}>Edit</a>
        </p>
      </div>
    {/each}
  </div>
{/if}

{#if runs.length}
  <h2>Recent runs</h2>
  <ul class="runs">
    {#each runs.slice(0, 10) as job (job.jobId)}
      <li><a href={`#/jobs/${job.jobId}`}><span class={`status ${job.status}`}>{job.status}</span> {job.capability.slice(7)}</a> <span class="muted">{new Date(job.createdAt).toLocaleString()}</span></li>
    {/each}
  </ul>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 1rem; background: var(--panel); }
  h2 { font-size: 1.05rem; margin: 0 0 0.4rem; }
  .steps { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
  .arrow { color: var(--muted); }
  .actions { display: flex; gap: 0.5rem; margin: 0.6rem 0 0; }
  a.button { display: inline-block; background: var(--accent); color: #fff; border-radius: 6px; padding: 0.45rem 0.9rem; text-decoration: none; }
  a.button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
  a.button.small { padding: 0.2rem 0.6rem; font-size: 0.85rem; }
  ul.runs { list-style: none; padding: 0; display: grid; gap: 0.3rem; }
  ul.runs a { color: inherit; text-decoration: none; }
</style>
