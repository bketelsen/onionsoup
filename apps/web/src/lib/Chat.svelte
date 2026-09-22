<script lang="ts">
  import { store, ApiError, type ChatTurn } from './store.svelte.ts';
  import Markdown from './Markdown.svelte';

  let { id }: { id: string } = $props();
  let draft = $state('');
  let error = $state<string | null>(null);
  let transcript: HTMLElement | undefined = $state();

  $effect(() => { store.loadChatSessions().catch(() => {}); });
  $effect(() => {
    if (id && store.chatSession?.sessionId !== id) store.openChatSession(id).catch((e) => { error = String(e); });
    if (!id) store.chatSession = null;
  });
  $effect(() => {
    if (store.chatSession?.turns.length && transcript) transcript.scrollTop = transcript.scrollHeight;
  });

  async function start() {
    error = null;
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
      error = e instanceof ApiError ? e.message : String(e);
      draft = message;
    }
  }

  const failureText: Record<string, string> = {
    provider_initialization_failed: 'The model provider is not signed in. Set ONIONSOUP_AUTH_PATH or run the provider login.',
    provider_request_failed: 'The model provider rejected the request.',
    step_limit_exceeded: 'The turn ran out of steps before answering.',
    answer_not_submitted: 'The model finished without submitting an answer.',
    cancelled_or_timed_out: 'The turn was cancelled or timed out.',
    execution_failed: 'The turn failed while running.',
    interrupted: 'The host restarted during this turn.',
  };
  const jobOf = (turn: ChatTurn, jobId: string) => store.jobs[jobId];
  const toolCalls = (turn: ChatTurn) => turn.events.filter((e) => e.stage === 'intent').map((e) => e.tool);
</script>

<div class="chat">
  <aside class="sessions panel">
    <button type="button" onclick={start} disabled={store.chatBusy}>New conversation</button>
    <ul>
      {#each store.chatSessions as s (s.sessionId)}
        <li class:current={s.sessionId === id}>
          <a href={`#/chat/${s.sessionId}`}>{s.title}</a>
          <div class="muted small">{s.turns} turn{s.turns === 1 ? '' : 's'} · {new Date(s.lastAt).toLocaleString()}</div>
        </li>
      {/each}
    </ul>
  </aside>

  <section class="conversation">
    <div class="transcript" bind:this={transcript}>
      {#if !store.chatSession}
        <p class="muted">Describe a change to a repository, ask for a brief or an issue assessment, run a recipe, or onboard a repository. The assistant runs the catalog on your behalf and cites the jobs it inspected; anything it publishes shows up as a draft PR.</p>
      {:else}
        {#each store.chatSession.turns as turn (turn.turnId)}
          <div class="turn">
            <div class="bubble user">{turn.message}</div>
            {#if turn.status === 'running'}
              <div class="bubble assistant muted">Working…</div>
            {:else if turn.answer}
              <div class="bubble assistant" class:aside={turn.answer.kind !== 'answer'}>
                <Markdown source={turn.answer.text} />
                {#if turn.answer.references.length}
                  <div class="refs">
                    {#each turn.answer.references as ref}
                      <a href={`#/jobs/${ref.id}`} class="tag">{jobOf(turn, ref.id)?.capability ?? ref.id.slice(0, 8)}</a>
                    {/each}
                  </div>
                {/if}
              </div>
            {:else}
              <div class="bubble assistant error">{failureText[turn.failure ?? ''] ?? turn.failure ?? turn.status}</div>
            {/if}
            {#if toolCalls(turn).length}<div class="tools muted small">{toolCalls(turn).join(' → ')}</div>{/if}
          </div>
        {/each}
      {/if}
    </div>
    <form onsubmit={send} class="composer">
      <textarea rows="2" bind:value={draft} placeholder="What do you want done?" disabled={store.chatBusy}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}></textarea>
      <button type="submit" disabled={store.chatBusy || !draft.trim()}>{store.chatBusy ? 'Working…' : 'Send'}</button>
    </form>
    {#if error}<p class="error">{error}</p>{/if}
  </section>
</div>

<style>
  .chat { display: grid; grid-template-columns: 280px 1fr; gap: 1rem; height: calc(100vh - 6rem); }
  .sessions { overflow: auto; }
  .sessions ul { list-style: none; padding: 0; margin: 0.8rem 0 0; display: grid; gap: 0.5rem; }
  .sessions li { padding: 0.4rem 0.5rem; border-radius: 6px; }
  .sessions li.current { background: var(--bg); }
  .sessions a { color: inherit; text-decoration: none; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conversation { display: grid; grid-template-rows: 1fr auto auto; gap: 0.6rem; min-height: 0; }
  .transcript { overflow: auto; display: grid; gap: 1rem; align-content: start; padding: 0.5rem; }
  .turn { display: grid; gap: 0.4rem; }
  .bubble { max-width: 46rem; padding: 0.6rem 0.9rem; border-radius: 10px; border: 1px solid var(--line); }
  .bubble.user { justify-self: end; background: var(--accent); color: #fff; border-color: transparent; white-space: pre-wrap; }
  .bubble.assistant { justify-self: start; background: var(--panel); }
  .bubble.aside { border-style: dashed; }
  .refs { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
  .refs a { text-decoration: none; }
  .tools { justify-self: start; padding-left: 0.4rem; }
  .composer { display: flex; gap: 0.5rem; align-items: flex-end; }
  .composer textarea { flex: 1; width: auto; }
  .small { font-size: 0.8rem; }
</style>
