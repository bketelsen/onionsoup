<script lang="ts">
  import { store, isActive, ApiError } from './store.svelte.ts';
  import ErrorText from './ui/ErrorText.svelte';

  const BLANK = { sourceId: '', kind: 'containers', host: '', user: '', access: 'direct', binary: '' };
  let error = $state<string | null>(null);
  let form = $state({ ...BLANK });
  let addingJob = $state<string | null>(null);
  let isSubmitting = $state(false);

  $effect(() => { store.loadSources().catch((e) => { error = String(e); }); });
  const added = $derived(addingJob ? store.jobs[addingJob] : undefined);
  $effect(() => {
    if (added && !isActive(added)) store.loadSources().catch(() => {});
  });
  const can = (capability: string) => Boolean(store.capability(capability));

  /** Which extra fields each kind of source takes. */
  const FIELDS_BY_KIND: Record<string, (keyof typeof BLANK)[]> = { containers: ['user'], kubernetes: ['user', 'access'], truenas: ['binary'] };
  const needs = (field: keyof typeof BLANK) => FIELDS_BY_KIND[form.kind].includes(field);

  async function add(event: SubmitEvent) {
    event.preventDefault();
    isSubmitting = true;
    error = null;
    const input: Record<string, unknown> = { sourceId: form.sourceId.trim(), kind: form.kind, host: form.host.trim() };
    for (const field of FIELDS_BY_KIND[form.kind]) input[field] = form[field].trim();
    try {
      addingJob = await store.submit('homelab.add-source', input);
      form = { ...BLANK };
    } catch (e) {
      error = e instanceof ApiError ? e.code : String(e);
    } finally {
      isSubmitting = false;
    }
  }
</script>

<h1>Homelab sources</h1>
<p class="muted">TrueNAS hosts, SSH hosts running Docker, Podman or Incus, and k3s hosts. Status and actions are on the <a href="#/homelab">Homelab</a> page.</p>

{#if can('homelab.add-source')}
  <form onsubmit={add} class="panel add">
    <h2>Add a source</h2>
    <div class="grid">
      <label>Kind
        <select bind:value={form.kind}>
          <option value="containers">containers (docker, podman, incus)</option>
          <option value="kubernetes">k3s</option>
          <option value="truenas">TrueNAS</option>
        </select>
      </label>
      <label>Source ID <input bind:value={form.sourceId} placeholder="lowercase, e.g. nas-1" required pattern="[a-z][a-z0-9-]*" /></label>
      <label>Host <input bind:value={form.host} placeholder="host or IP" required /></label>
      {#if needs('user')}<label>SSH user <input bind:value={form.user} required /></label>{/if}
      {#if needs('access')}<label>Access <select bind:value={form.access}><option value="direct">direct</option><option value="sudo">sudo</option></select></label>{/if}
      {#if needs('binary')}<label>truenas-mcp binary <input bind:value={form.binary} placeholder="/absolute/path/to/truenas-mcp" required /></label>{/if}
    </div>
    <div><button type="submit" disabled={isSubmitting}>Add source</button></div>
    {#if added}
      <p><span class={`status ${added.status}`}>{added.status}</span> <a href={`#/jobs/${added.jobId}`}>add-source job</a></p>
      {#if added.error}<ErrorText error={added.error} />{/if}
    {/if}
  </form>
{/if}
{#if error}<ErrorText {error} />{/if}

{#if store.sources.length === 0}
  <p>No sources yet.</p>
{:else}
  <table class="list">
    <thead><tr><th>Source</th><th>Kind</th><th>Where</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>
      {#each store.sources as source (source.sourceId)}
        <tr>
          <td data-label="Source">{source.sourceId} {#if source.origin === 'config'}<span class="tag">config</span>{/if}</td>
          <td data-label="Kind">{source.kind}</td>
          <td data-label="Where">{source.detail}</td>
          <td>{#if source.origin === 'registry' && can('homelab.update-source')}<a class="button secondary small" href={`#/run/homelab.update-source?sourceId=${encodeURIComponent(source.sourceId)}`}>Edit</a>{/if}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .add { display: grid; gap: 0.8rem; margin-bottom: 1.2rem; }
  .add h2 { margin: 0; font-size: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 0.6rem; }
  .grid label { display: grid; gap: 0.2rem; font-weight: 600; font-size: 0.85rem; }
  .grid input, .grid select { width: 100%; font-weight: 400; }
</style>
