<script lang="ts">
  import { store, ApiError, type RegisteredRepository } from './store.svelte.ts';

  let name = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let onboardingJob = $state<string | null>(null);

  $effect(() => { store.loadRepositories().catch((e) => { error = String(e); }); });
  const onboardJob = $derived(onboardingJob ? store.jobs[onboardingJob] : undefined);
  $effect(() => {
    if (onboardJob && onboardJob.status !== 'queued' && onboardJob.status !== 'running') store.loadRepositories().catch(() => {});
  });
  const canOnboard = $derived(Boolean(store.capability('repository.onboard')));
  const canUpdate = $derived(Boolean(store.capability('repository.update')));

  async function onboard(event: SubmitEvent) {
    event.preventDefault();
    const repository = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(repository)) { error = 'Use owner/name.'; return; }
    submitting = true;
    error = null;
    try {
      onboardingJob = await store.submit('repository.onboard', { repository });
      name = '';
    } catch (e) {
      error = e instanceof ApiError ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function verification(repository: RegisteredRepository) {
    const v = repository.profile?.verification;
    if (!v) return repository.implementation ? 'profile unreadable' : 'reads only';
    if (v.build) return `build: ${[v.build.bin, ...(v.build.args ?? [])].join(' ')}`;
    if (v.testFiles) return `${v.testFiles.length} test file(s)`;
    return v.required?.join(', ') ?? '';
  }
</script>

<h1>Repositories</h1>
<p class="muted">Configured entries are fixed in the host config. Onboarded ones are cloned into the host and can be edited here or from chat.</p>

{#if canOnboard}
  <form onsubmit={onboard} class="onboard panel">
    <label for="repo">Onboard a GitHub repository</label>
    <div class="row">
      <input id="repo" bind:value={name} placeholder="owner/name" disabled={submitting} />
      <button type="submit" disabled={submitting || !name.trim()}>{submitting ? 'Submitting…' : 'Onboard'}</button>
    </div>
    {#if !store.nodeRuntime}<small class="muted">No Node sandbox runtime is configured, so Node projects will register for reads only.</small>{/if}
    {#if onboardJob}
      <p>
        <span class={`status ${onboardJob.status}`}>{onboardJob.status}</span>
        {#if onboardJob.outcome}<span class={`outcome ${onboardJob.outcome.status}`}>{onboardJob.outcome.label}</span>{/if}
        {#if onboardJob.error}<span class="error">{onboardJob.error}</span>{/if}
        <a href={`#/jobs/${onboardJob.jobId}`}>job</a>
      </p>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </form>
{/if}

{#if store.repositories.length === 0}
  <p>No repositories yet.</p>
{:else}
  <table>
    <thead><tr><th>Repository</th><th>Source</th><th>Checkout</th><th>Implementation</th><th>Verification</th><th></th></tr></thead>
    <tbody>
      {#each store.repositories as repository (repository.name)}
        <tr>
          <td><a href={`https://github.com/${repository.name}`} target="_blank" rel="noopener noreferrer">{repository.name}</a></td>
          <td><span class="tag">{repository.origin === 'config' ? 'config' : 'onboarded'}</span></td>
          <td>{repository.checkout ? 'yes' : 'no'}</td>
          <td>{repository.implementation ? `${repository.profile?.changes?.maximumFiles ?? '?'} files · tests ${repository.profile?.changes?.existingTests ?? '?'}` : 'no'}</td>
          <td>{verification(repository)}</td>
          <td>
            {#if repository.origin === 'registry' && repository.implementation && canUpdate}
              <a class="button secondary small" href={`#/run/repository.update?repository=${encodeURIComponent(repository.name)}`}>Edit</a>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .onboard { display: grid; gap: 0.5rem; margin-bottom: 1.2rem; }
  .onboard label { font-weight: 600; font-size: 0.9rem; }
  .row { display: flex; gap: 0.5rem; }
  .row input { flex: 1; width: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 0.85rem; }
  a.button { display: inline-block; border-radius: 6px; padding: 0.2rem 0.6rem; font-size: 0.85rem; text-decoration: none; color: var(--text); border: 1px solid var(--line); }
</style>
