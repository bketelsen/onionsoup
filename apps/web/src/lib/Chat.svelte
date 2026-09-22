<script lang="ts">
  import { tick } from 'svelte';
  import { store, ApiError, type ChatTurn } from './store.svelte.ts';
  import Markdown from './Markdown.svelte';
  import Inbox from './Inbox.svelte';
  import Time from './ui/Time.svelte';
  import ErrorText from './ui/ErrorText.svelte';
  import ConfirmButton from './ui/ConfirmButton.svelte';
  import { hasNextSteps, isTaken, nextStepsFor, subjectOf } from './jobs.ts';
  import { startersFor, stepsOf } from './chat.ts';
  import { shortId } from './format.ts';

  let { id }: { id: string } = $props();
  let draft = $state('');
  let error = $state<string | null>(null);
  let transcript: HTMLElement | undefined = $state();
  let composer: HTMLTextAreaElement | undefined = $state();
  let isDrawerOpen = $state(false);
  let renaming = $state<string | null>(null);
  let newTitle = $state('');

  /** Inbox items shown on an empty conversation. */
  const INBOX_PREVIEW = 4;

  $effect(() => { store.loadChatSessions().catch(() => {}); });
  $effect(() => { if (store.capability('repository.list')) store.loadRepositories().catch(() => {}); });
  $effect(() => {
    if (id && store.chatSession?.sessionId !== id) store.openChatSession(id).catch((e) => { error = e instanceof ApiError ? e.code : String(e); });
    if (!id) store.chatSession = null;
  });
  $effect(() => {
    if (store.chatSession?.turns.length && transcript) transcript.scrollTop = transcript.scrollHeight;
  });

  // Next steps under an answer need the cited job's result, which the job list does not carry.
  const requested = new Set<string>();
  $effect(() => {
    for (const turn of store.chatSession?.turns ?? []) for (const reference of turn.answer?.references ?? []) {
      const job = store.jobs[reference.id];
      if (!job || requested.has(job.jobId) || job.result !== undefined || !hasNextSteps(job.capability) || job.status !== 'completed') continue;
      requested.add(job.jobId);
      store.refresh(job.jobId).catch(() => {});
    }
  });

  const starters = $derived(startersFor(store.capabilities.map((capability) => capability.id), store.repositories));

  async function start() {
    error = null;
    isDrawerOpen = false;
    const sessionId = await store.createChatSession();
    location.hash = `#/chat/${sessionId}`;
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || store.chatBusy) return;
    if (!store.chatSession) await start();
    draft = '';
    error = null;
    try {
      await store.sendChat(message);
    } catch (e) {
      error = e instanceof ApiError ? e.code : String(e);
      draft = message;
    }
  }
  async function useStarter(text: string) {
    draft = text;
    await tick();
    composer?.focus();
    composer?.setSelectionRange(text.length, text.length);
  }
  async function rename(sessionId: string) {
    const title = newTitle.trim();
    renaming = null;
    if (title) await store.updateChatSession(sessionId, { title }).catch((e) => { error = e instanceof ApiError ? e.code : String(e); });
  }
  async function archive(sessionId: string) {
    await store.updateChatSession(sessionId, { archived: true }).catch((e) => { error = e instanceof ApiError ? e.code : String(e); });
    if (sessionId === id) location.hash = '#/';
  }

  const nextFor = (turn: ChatTurn) => (turn.answer?.references ?? []).flatMap((reference) => {
    const job = store.jobs[reference.id];
    return job ? nextStepsFor(job).filter((next) => !isTaken(job, next)) : [];
  });
  const referenceLabel = (jobId: string) => {
    const job = store.jobs[jobId];
    return job ? [job.capability, subjectOf(job)].filter(Boolean).join(' · ') : shortId(jobId);
  };
</script>

<div class="chat" class:drawer-open={isDrawerOpen}>
  <aside class="sessions panel" aria-label="Conversations">
    <button type="button" onclick={start} disabled={store.chatBusy}>New conversation</button>
    <ul>
      {#each store.chatSessions as session (session.sessionId)}
        <li class:current={session.sessionId === id}>
          {#if renaming === session.sessionId}
            <form onsubmit={(event) => { event.preventDefault(); rename(session.sessionId); }}>
              <label class="visually-hidden" for={`title-${session.sessionId}`}>Conversation title</label>
              <input id={`title-${session.sessionId}`} bind:value={newTitle} maxlength="120" onblur={() => rename(session.sessionId)} />
            </form>
          {:else}
            <a href={`#/chat/${session.sessionId}`} onclick={() => { isDrawerOpen = false; }} title={session.title}>{session.title}</a>
          {/if}
          <div class="muted small">{session.turns} turn{session.turns === 1 ? '' : 's'} · <Time at={session.lastAt} />{#if session.busy}{' '}· working{/if}</div>
          {#if session.sessionId === id && renaming !== session.sessionId}
            <div class="session-actions">
              <button type="button" class="secondary small" onclick={() => { renaming = session.sessionId; newTitle = session.title; }}>Rename</button>
              <ConfirmButton small label="Archive" confirmLabel="archive" disabled={session.busy} onconfirm={() => archive(session.sessionId)} />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </aside>

  <section class="conversation">
    <button type="button" class="secondary small drawer-toggle" aria-expanded={isDrawerOpen} onclick={() => { isDrawerOpen = !isDrawerOpen; }}>
      {isDrawerOpen ? 'Hide conversations' : 'Conversations'}
    </button>
    <div class="transcript" bind:this={transcript} aria-live="polite">
      {#if !store.chatSession}
        <div class="welcome">
          <p>Describe a change to a repository, ask for a brief or an issue assessment, run a recipe, or onboard a repository. The assistant runs the catalog for you and cites the jobs it inspected. Anything it publishes is a draft PR.</p>
          {#if starters.length}
            <div class="starters" role="group" aria-label="Suggestions">
              {#each starters as starter}<button type="button" class="secondary small" onclick={() => useStarter(starter)}>{starter}</button>{/each}
            </div>
          {/if}
          <Inbox limit={INBOX_PREVIEW} />
        </div>
      {:else}
        {#each store.chatSession.turns as turn (turn.turnId)}
          {@const steps = stepsOf(turn)}
          <div class="turn">
            <div class="bubble user">{turn.message}</div>
            {#if turn.status === 'running'}
              <div class="bubble assistant progress">
                <p class="muted">Working…</p>
                <ol class="steps">
                  {#each steps as step}
                    <li class={step.state}>{step.label}{#if step.jobId}{' '}<a href={`#/jobs/${step.jobId}`} class="tag">{referenceLabel(step.jobId)}</a>{/if}</li>
                  {/each}
                </ol>
                <button type="button" class="secondary small" onclick={() => store.cancelChat()}>Stop</button>
              </div>
            {:else if turn.answer}
              <div class="bubble assistant" class:aside={turn.answer.kind !== 'answer'}>
                <Markdown source={turn.answer.text} />
                {#if turn.answer.references.length}
                  <div class="refs">
                    {#each turn.answer.references as reference}<a href={`#/jobs/${reference.id}`} class="tag">{referenceLabel(reference.id)}</a>{/each}
                  </div>
                {/if}
                {#if nextFor(turn).length}
                  <div class="handoff">
                    {#each nextFor(turn) as next}<a class="button small" href={next.href}>{next.label}</a>{/each}
                  </div>
                {/if}
              </div>
            {:else}
              <div class="bubble assistant failed"><ErrorText error={turn.failure ?? turn.status} /></div>
            {/if}
            {#if turn.status !== 'running' && steps.length}
              <details class="trail small">
                <summary>{steps.length} step{steps.length === 1 ? '' : 's'}</summary>
                <ol class="steps">{#each steps as step}<li class={step.state}>{step.label}{#if step.jobId}{' '}<a href={`#/jobs/${step.jobId}`}>{referenceLabel(step.jobId)}</a>{/if}</li>{/each}</ol>
              </details>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    <form onsubmit={send} class="composer">
      <label class="visually-hidden" for="composer">Message</label>
      <textarea id="composer" class="plain" rows="2" bind:this={composer} bind:value={draft} placeholder="What do you want done?" disabled={store.chatBusy}
        onkeydown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}></textarea>
      <button type="submit" disabled={store.chatBusy || !draft.trim()}>{store.chatBusy ? 'Working…' : 'Send'}</button>
    </form>
    {#if error}<ErrorText {error} />{/if}
  </section>
</div>

<style>
  .chat { display: grid; grid-template-columns: 280px 1fr; gap: 1rem; height: calc(100vh - 6rem); }
  .sessions { overflow: auto; min-width: 0; }
  .sessions ul { list-style: none; padding: 0; margin: 0.8rem 0 0; display: grid; gap: 0.4rem; }
  .sessions li { padding: 0.4rem 0.5rem; border-radius: 6px; min-width: 0; }
  .sessions li.current { background: var(--bg); }
  .sessions a { color: inherit; text-decoration: none; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sessions input { width: 100%; }
  .session-actions { display: flex; gap: 0.3rem; margin-top: 0.3rem; }
  .conversation { display: grid; grid-template-rows: auto 1fr auto auto; gap: 0.6rem; min-height: 0; min-width: 0; }
  .drawer-toggle { display: none; justify-self: start; }
  .transcript { overflow: auto; display: grid; gap: 1rem; align-content: start; padding: 0.5rem; }
  .welcome { display: grid; gap: 1rem; max-width: 46rem; }
  .welcome p { margin: 0; }
  .starters { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .turn { display: grid; gap: 0.4rem; min-width: 0; }
  .bubble { max-width: min(46rem, 100%); padding: 0.6rem 0.9rem; border-radius: 10px; border: 1px solid var(--line); overflow-wrap: anywhere; }
  .bubble.user { justify-self: end; background: var(--accent); color: #fff; border-color: transparent; white-space: pre-wrap; }
  .bubble.assistant { justify-self: start; background: var(--panel); }
  .bubble.aside { border-style: dashed; }
  .bubble.failed { border-color: var(--danger); }
  .progress p { margin: 0 0 0.3rem; }
  .steps { margin: 0 0 0.4rem; padding-left: 1.2rem; display: grid; gap: 0.15rem; }
  .steps li.running { color: var(--text); }
  .steps li.done { color: var(--muted); }
  .steps li.rejected { color: var(--danger); }
  .refs, .handoff { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
  .refs a { text-decoration: none; }
  .trail { justify-self: start; padding-left: 0.4rem; }
  .composer { display: flex; gap: 0.5rem; align-items: flex-end; }
  .composer textarea { flex: 1; width: auto; }
  .small { font-size: 0.8rem; }
  @media (max-width: 720px) {
    .chat { grid-template-columns: 1fr; height: calc(100vh - 5rem); }
    .sessions { display: none; }
    .chat.drawer-open { grid-template-rows: auto 1fr; }
    .chat.drawer-open .sessions { display: block; max-height: 40vh; }
    .drawer-toggle { display: inline-block; }
  }
</style>
