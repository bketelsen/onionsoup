import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

// Types mirror `owners desk-state` (packages/owners/src/desk.ts).
interface Pending { kind: 'plan' | 'push' | 'create' | 'delete'; id: string; title: string; detail: string }
interface Note { at: string; kind: string; note?: string; quote?: string; outcome?: string; stage?: string; retracted: boolean }
interface DeskState {
  owners: { id: string; name: string; title: string }[];
  owner: { id: string; name: string; title: string; source: string; model: string; desk: string } | null;
  pending: Pending[];
  work: { id: string; status: string; title: string }[];
  recent: { id: string; status: string; title: string; url?: string }[];
  activity: { id: string; status: string; title: string; from: string; to: string; detail?: string; at: string }[];
  notes: Note[];
  registers: Record<string, string>;
}

const REFRESH_MS = 20_000;
const REGISTER_TABS: [string, string][] = [['MAP', 'Map'], ['WISDOM', 'Wisdom'], ['decisions', 'Decisions'], ['open-questions', 'Open questions'], ['FAILURES', 'Failures']];
const NOTE_LABELS: Record<string, string> = {
  'chat-decision': 'Noted', 'chat-action': 'Did', 'work-opened': 'Opened work', 'plan-approved': 'Plan approved',
  'plan-rejected': 'Plan rejected', published: 'Published', 'publish-failed': 'Publish failed', 'rebase-pushed': 'Rebased',
  attention: 'Needs you', 'app-held': 'Held update', 'app-update-proposed': 'Proposed update', 'app-updated': 'Updated app',
  'request-accepted': 'Accepted request', 'request-declined': 'Declined request', 'request-refused': 'Refused request',
  'instance-created': 'Created instance', 'instance-deleted': 'Deleted instance', 'follow-up': 'Follow-up', asked: 'Asked', answered: 'Answered',
};

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; background: var(--oc-bg); color: var(--oc-fg); font: 13px/1.5 var(--oc-font, system-ui); }
.desk { padding: 14px; display: grid; gap: 14px; }
.who { display: grid; grid-template-columns: 48px 1fr; gap: 12px; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--oc-border); }
.sigil { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; font-size: 20px; font-weight: 600;
  background: var(--oc-primary); color: var(--oc-primary-fg); letter-spacing: .5px; }
.name { font-size: 18px; font-weight: 650; }
.title { color: var(--oc-muted); }
.source { color: var(--oc-subtle); font-style: italic; font-size: 12px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--oc-muted); margin: 0 0 6px; font-weight: 600; }
.card { background: var(--oc-elevated); color: var(--oc-elevated-fg, var(--oc-fg)); border: 1px solid var(--oc-border); border-radius: var(--oc-radius, 8px); padding: 10px; margin-bottom: 8px; }
.card.wait { border-color: var(--oc-warning); }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.meta { color: var(--oc-subtle); font-size: 11px; }
.quote { border-left: 3px solid var(--oc-border); padding-left: 8px; color: var(--oc-muted); margin: 6px 0 0; font-style: italic; }
.retracted { opacity: .45; text-decoration: line-through; }
.status { font-family: var(--oc-mono, monospace); font-size: 11px; color: var(--oc-info-text, var(--oc-muted)); }
button { font: inherit; border-radius: 6px; border: 1px solid var(--oc-border); background: var(--oc-muted-surface, transparent); color: var(--oc-fg); padding: 3px 10px; cursor: pointer; }
button:hover { background: var(--oc-hover); }
button.primary { background: var(--oc-primary); color: var(--oc-primary-fg); border-color: var(--oc-primary); }
input[type=text], select { font: inherit; background: var(--oc-bg); color: var(--oc-fg); border: 1px solid var(--oc-border); border-radius: 6px; padding: 3px 6px; }
input[type=text] { flex: 1; min-width: 120px; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.tabs button.active { background: var(--oc-selection); color: var(--oc-selection-fg, var(--oc-fg)); }
.md h1, .md h2, .md h3 { text-transform: none; letter-spacing: 0; color: var(--oc-fg); font-size: 14px; margin: 10px 0 4px; }
.md p, .md ul { margin: 4px 0; } .md ul { padding-left: 18px; }
.md code { font-family: var(--oc-mono, monospace); background: var(--oc-muted-surface); padding: 0 3px; border-radius: 3px; }
.empty { color: var(--oc-subtle); }
.error { color: var(--oc-error-text); }
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, primary = false) {
  const node = element('button', primary ? 'primary' : '', label);
  node.addEventListener('click', onClick);
  return node;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function inline(text: string) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Enough Markdown for notebook registers: headings, bullets, paragraphs, code and bold. */
function renderMarkdown(markdown: string) {
  const html: string[] = [];
  let list = false;
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!bullet && list) { html.push('</ul>'); list = false; }
    if (heading) html.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
    else if (bullet) { if (!list) { html.push('<ul>'); list = true; } html.push(`<li>${inline(bullet[1]!)}</li>`); }
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push('</ul>');
  return html.join('');
}

function when(at: string) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const host = connectHost();
const root = document.querySelector('#root')!;
const style = element('style');
style.textContent = STYLE;
document.head.append(style);

let agent: string | undefined;
let directory: string | undefined;
let chosenOwner: string | undefined;
let activeTab = 'MAP';
let lastError = '';

async function load(): Promise<DeskState> {
  const query: Record<string, string> = {};
  if (chosenOwner) query.owner = chosenOwner;
  if (agent) query.agent = agent;
  if (directory) query.directory = directory;
  const result = await host.serviceRequest({ method: 'GET', path: '/state', query });
  const body = JSON.parse(result.body);
  if (result.status >= 400) throw new Error(body.error ?? `HTTP ${result.status}`);
  return body as DeskState;
}

async function post(path: string, payload: Record<string, unknown>) {
  const result = await host.serviceRequest({ method: 'POST', path, body: JSON.stringify(payload) });
  const body = JSON.parse(result.body);
  if (result.status >= 400) throw new Error(body.error ?? `HTTP ${result.status}`);
  await host.toast({ kind: 'success', message: body.output || 'Recorded' }).catch(() => undefined);
  await refresh();
}

function renderWho(state: DeskState, container: HTMLElement) {
  const owner = state.owner!;
  const who = element('div', 'who');
  const initials = owner.name.split(' ').map(word => word[0]).join('').slice(0, 2);
  who.append(element('div', 'sigil', initials));
  const text = element('div');
  text.append(element('div', 'name', owner.name), element('div', 'title', owner.title), element('div', 'source', owner.source));
  who.append(text);
  container.append(who);
  if (state.owners.length > 1) {
    const picker = element('select');
    for (const candidate of state.owners) {
      const option = element('option', '', candidate.name);
      option.value = candidate.id;
      option.selected = candidate.id === owner.id;
      picker.append(option);
    }
    picker.addEventListener('change', () => { chosenOwner = picker.value; void refresh(); });
    const row = element('div', 'row');
    row.append(element('span', 'meta', 'Desk of'), picker);
    container.append(row);
  }
}

const PENDING_ACTIONS: Record<Pending['kind'], { approve: string; refuse: string; approveLabel: string; refuseLabel: string }> = {
  plan: { approve: 'approve-plan', refuse: 'reject-plan', approveLabel: 'Approve plan', refuseLabel: 'Reject' },
  push: { approve: 'approve-push', refuse: '', approveLabel: 'Approve force-push', refuseLabel: '' },
  create: { approve: 'approve-create', refuse: 'deny-request', approveLabel: 'Approve create', refuseLabel: 'Deny' },
  delete: { approve: 'approve-delete', refuse: 'deny-request', approveLabel: 'Approve delete', refuseLabel: 'Keep it' },
};

function renderPending(state: DeskState, container: HTMLElement) {
  container.append(element('h2', '', `Waiting on you (${state.pending.length})`));
  if (!state.pending.length) container.append(element('div', 'empty', 'Nothing needs you.'));
  for (const pending of state.pending) {
    const actions = PENDING_ACTIONS[pending.kind];
    const card = element('div', 'card wait');
    card.append(element('div', '', pending.title), element('div', 'meta', `${pending.kind} · ${pending.id}`));
    if (pending.detail) card.append(element('div', 'quote', pending.detail));
    const row = element('div', 'row');
    const reason = element('input');
    reason.type = 'text';
    reason.placeholder = 'Reason (for reject/deny)';
    let withDelete: HTMLInputElement | undefined;
    if (pending.kind === 'create') {
      withDelete = element('input');
      withDelete.type = 'checkbox';
      withDelete.checked = true;
      const label = element('label', 'meta');
      label.append(withDelete, document.createTextNode(' also delete when done'));
      row.append(label);
    }
    row.append(button(actions.approveLabel, () => void post('/decide', { action: actions.approve, id: pending.id, withDelete: withDelete?.checked }), true));
    if (actions.refuse) row.append(reason, button(actions.refuseLabel, () => void post('/decide', { action: actions.refuse, id: pending.id, reason: reason.value })));
    card.append(row);
    container.append(card);
  }
}

function renderWork(state: DeskState, container: HTMLElement) {
  container.append(element('h2', '', 'Work'));
  if (!state.work.length && !state.recent.length) container.append(element('div', 'empty', 'No work yet.'));
  for (const item of state.work) {
    const card = element('div', 'card');
    card.append(element('div', '', item.title), element('div', 'status', `${item.status} · ${item.id}`));
    container.append(card);
  }
  for (const item of state.recent) {
    const line = element('div', 'meta', `${item.status}: ${item.title}${item.url ? ` · ${item.url}` : ''}`);
    container.append(line);
  }
}

function renderActivity(state: DeskState, container: HTMLElement) {
  container.append(element('h2', '', 'Requests'));
  if (!state.activity.length) container.append(element('div', 'empty', 'No requests yet.'));
  for (const request of state.activity) {
    const card = element('div', 'card');
    card.append(element('div', '', request.title), element('div', 'status', `${request.status} · ${request.from} → ${request.to} · ${when(request.at)}`));
    if (request.detail) card.append(element('div', 'quote', request.detail));
    container.append(card);
  }
}

function renderNotes(state: DeskState, container: HTMLElement) {
  container.append(element('h2', '', 'Noted from your chats and work'));
  if (!state.notes.length) container.append(element('div', 'empty', 'Nothing noted yet.'));
  for (const note of state.notes) {
    const card = element('div', `card${note.retracted ? ' retracted' : ''}`);
    card.append(element('div', 'meta', `${NOTE_LABELS[note.kind] ?? note.kind}${note.outcome && note.kind === 'chat-decision' ? ` (${note.outcome})` : ''} · ${when(note.at)}`));
    card.append(element('div', '', note.note ?? note.stage ?? ''));
    if (note.quote) card.append(element('div', 'quote', `“${note.quote}”`));
    if (note.kind === 'chat-decision' && !note.retracted) {
      const row = element('div', 'row');
      row.append(button('Retract — not a decision', () => void post('/retract', { owner: state.owner!.id, note: note.note })));
      card.append(row);
    }
    container.append(card);
  }
}

function renderNotebook(state: DeskState, container: HTMLElement) {
  container.append(element('h2', '', 'Notebook'));
  const tabs = element('div', 'tabs');
  const body = element('div', 'md');
  const show = () => {
    for (const child of tabs.children) child.classList.toggle('active', (child as HTMLElement).dataset.tab === activeTab);
    body.innerHTML = renderMarkdown(state.registers[activeTab] ?? '') || '<p class="empty">Empty.</p>';
  };
  for (const [key, label] of REGISTER_TABS) {
    const tab = button(label, () => { activeTab = key; show(); });
    tab.dataset.tab = key;
    tabs.append(tab);
  }
  container.append(tabs, body);
  show();
}

function render(state: DeskState) {
  root.replaceChildren();
  const desk = element('div', 'desk');
  if (lastError) desk.append(element('div', 'error', lastError));
  if (!state.owner) {
    desk.append(element('div', 'empty', 'No owner with a persona is declared yet.'));
    root.append(desk);
    return;
  }
  for (const section of [renderWho, renderPending, renderWork, renderActivity, renderNotes, renderNotebook]) {
    const part = element('section');
    section(state, part);
    desk.append(part);
  }
  root.append(desk);
  void host.setBadge(state.pending.length || null).catch(() => undefined);
}

async function refresh() {
  try {
    const state = await load();
    lastError = '';
    render(state);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    root.replaceChildren(element('div', 'desk error', `The desk could not load: ${lastError}`));
  }
}

host.onReady((context: HostReadyContext) => {
  applyHostReady(context, document.documentElement);
  agent = context.session?.agent;
  directory = context.directory ?? undefined;
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);
});
host.onSession(session => {
  if (session?.agent && session.agent !== agent) {
    agent = session.agent;
    chosenOwner = undefined;
    void refresh();
  }
});
host.onDirectory(next => {
  directory = next ?? undefined;
  void refresh();
});
