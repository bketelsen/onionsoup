<script lang="ts">
  import { parseDiff } from './diff.ts';

  let { diff }: { diff: string } = $props();
  const files = $derived(parseDiff(diff));
</script>

{#each files as file (file.path)}
  <details class="file" open>
    <summary><code>{file.path}</code> <span class="add">+{file.additions}</span> <span class="remove">−{file.deletions}</span></summary>
    <div class="lines">
      {#each file.lines as line}
        {#if line.kind === 'hunk'}
          <div class="line hunk"><code>{line.text}</code></div>
        {:else}
        <div class={`line ${line.kind}`}>
          <span class="number" aria-hidden="true">{line.oldLine ?? ''}</span>
          <span class="number" aria-hidden="true">{line.newLine ?? ''}</span>
          <span class="sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span>
          <code>{line.text}</code>
        </div>
        {/if}
      {/each}
    </div>
  </details>
{:else}
  <p class="muted">The diff is empty.</p>
{/each}

<style>
  .file { border: 1px solid var(--line); border-radius: 6px; margin: 0.5rem 0; background: var(--panel); }
  .file summary { padding: 0.4rem 0.7rem; color: var(--text); border-bottom: 1px solid var(--line); }
  .add { color: var(--ok); }
  .remove { color: var(--danger); }
  .lines { overflow-x: auto; font-size: 0.82rem; }
  .line { display: grid; grid-template-columns: 3rem 3rem 1.2rem max-content; min-width: 100%; }
  .line code { white-space: pre; padding-right: 1rem; }
  .number { color: var(--muted); text-align: right; padding-right: 0.5rem; user-select: none; font-family: ui-monospace, monospace; }
  .sign { user-select: none; text-align: center; font-family: ui-monospace, monospace; }
  .line.add { background: color-mix(in srgb, var(--ok) 14%, transparent); }
  .line.remove { background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .line.hunk { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--muted); }
  .line.hunk { display: block; padding-left: 0.5rem; }
</style>
