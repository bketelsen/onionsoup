<script lang="ts">
  import { SvelteFlow, Background, Controls, MarkerType, type Node, type Edge, type Connection } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import StepNode from './StepNode.svelte';
  import SchemaForm from '../SchemaForm.svelte';
  import { store, ApiError, type Recipe, type Step, type JsonSchema } from '../store.svelte.ts';

  let { id }: { id: string } = $props();
  const isNew = $derived(id === 'new');

  function blank(): Recipe {
    return { schemaVersion: 1, id: '', title: '', description: '', steps: [], layout: {} };
  }
  let recipe = $state<Recipe>(blank());
  let loaded = $state(id === 'new');
  let selected = $state<string | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let dirty = $state(false);

  $effect(() => {
    if (loaded) return;
    const found = store.recipes.find((r) => r.id === id);
    if (found) { recipe = structuredClone($state.snapshot(found)); loaded = true; }
  });

  const nodeTypes = { step: StepNode };
  const capabilityOf = (capId: string) => store.stepCapabilities.find((c) => c.id === capId);
  const step = $derived(recipe.steps.find((s) => s.id === selected));
  const stepIndex = $derived(recipe.steps.findIndex((s) => s.id === selected));
  const stepSchema = $derived(step ? capabilityOf(step.capability)?.inputSchema : undefined);
  const earlier = $derived(recipe.steps.slice(0, Math.max(0, stepIndex)));

  type Source = 'literal' | 'param' | 'job' | 'result';
  function isBinding(v: unknown): v is Record<string, unknown> {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 1 && ['$param', '$job', '$result'].includes(Object.keys(v as object)[0]);
  }
  function sourceOf(v: unknown): Source {
    if (!isBinding(v)) return 'literal';
    return '$param' in v ? 'param' : '$job' in v ? 'job' : 'result';
  }
  function referenced(v: unknown): string | undefined {
    if (!isBinding(v)) return undefined;
    if ('$job' in v) return v.$job as string;
    if ('$result' in v) return (v.$result as [string, string])[0];
    return undefined;
  }
  function problemOf(s: Step, index: number): string | undefined {
    if (!capabilityOf(s.capability)) return `unknown capability ${s.capability}`;
    const before = recipe.steps.slice(0, index).map((x) => x.id);
    for (const v of Object.values(s.input)) {
      const ref = referenced(v);
      if (ref && !before.includes(ref)) return `binds to "${ref}", which is not an earlier step`;
    }
    return undefined;
  }
  function summaryOf(s: Step): string[] {
    return Object.entries(s.input).map(([k, v]) => {
      if (!isBinding(v)) return `${k} = ${JSON.stringify(v)}`;
      if ('$param' in v) return `${k} ← param ${v.$param}`;
      if ('$job' in v) return `${k} ← job ${v.$job}`;
      const [ref, path] = v.$result as [string, string];
      return `${k} ← ${ref}.${path}`;
    });
  }

  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  $effect(() => {
    nodes = recipe.steps.map((s, i) => ({
      id: s.id,
      type: 'step',
      position: recipe.layout?.[s.id] ?? { x: 80 + i * 340, y: 120 },
      selected: s.id === selected,
      data: { stepId: s.id, capability: s.capability, summary: summaryOf(s), problem: problemOf(s, i) },
    }));
    const next: Edge[] = [];
    for (const s of recipe.steps) for (const [field, v] of Object.entries(s.input)) {
      const ref = referenced(v);
      if (ref && recipe.steps.some((x) => x.id === ref)) next.push({ id: `${ref}->${s.id}:${field}`, source: ref, target: s.id, label: field, markerEnd: { type: MarkerType.ArrowClosed }, animated: '$result' in (v as object) });
    }
    edges = next;
  });

  function touch() { dirty = true; notice = null; }

  let newCapability = $state('');
  function addStep() {
    const cap = capabilityOf(newCapability);
    if (!cap) return;
    const base = newCapability.split('.').pop()!.replace(/[^a-z0-9-]/g, '-');
    let stepId = base;
    let n = 2;
    while (recipe.steps.some((s) => s.id === stepId)) stepId = `${base}-${n++}`;
    const input: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(cap.inputSchema.properties ?? {})) {
      const s = schema as JsonSchema;
      if (s.const !== undefined) input[key] = s.const;
      else if (s.default !== undefined) input[key] = s.default;
      else if (s.format === 'uuid' || /JobId$/.test(key)) { const prev = recipe.steps.at(-1); if (prev) input[key] = { $job: prev.id }; }
      else if (cap.inputSchema.required?.includes(key)) input[key] = { $param: key };
    }
    recipe.steps.push({ id: stepId, capability: newCapability, input });
    recipe.layout = { ...recipe.layout, [stepId]: { x: 80 + (recipe.steps.length - 1) * 340, y: 120 } };
    selected = stepId;
    touch();
  }
  function removeStep(stepId: string) {
    recipe.steps = recipe.steps.filter((s) => s.id !== stepId);
    if (selected === stepId) selected = null;
    touch();
  }
  function renameStep(from: string, to: string) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(to) || recipe.steps.some((s) => s.id === to)) return;
    for (const s of recipe.steps) for (const [k, v] of Object.entries(s.input)) {
      if (isBinding(v) && '$job' in v && v.$job === from) s.input[k] = { $job: to };
      if (isBinding(v) && '$result' in v && (v.$result as [string, string])[0] === from) s.input[k] = { $result: [to, (v.$result as [string, string])[1]] };
    }
    const target = recipe.steps.find((s) => s.id === from)!;
    target.id = to;
    if (recipe.layout?.[from]) { recipe.layout[to] = recipe.layout[from]; delete recipe.layout[from]; }
    selected = to;
    touch();
  }
  function setSource(field: string, source: Source) {
    if (!step) return;
    const schema = (stepSchema?.properties?.[field] ?? {}) as JsonSchema;
    if (source === 'literal') step.input[field] = schema.default ?? (schema.type === 'string' ? '' : undefined);
    else if (source === 'param') step.input[field] = { $param: field };
    else if (source === 'job') step.input[field] = { $job: earlier.at(-1)?.id ?? '' };
    else step.input[field] = { $result: [earlier.at(-1)?.id ?? '', ''] };
    touch();
  }
  function onconnect(connection: Connection) {
    const target = recipe.steps.find((s) => s.id === connection.target);
    const cap = target && capabilityOf(target.capability);
    if (!target || !cap) return;
    const fields = Object.entries(cap.inputSchema.properties ?? {});
    const jobField = fields.find(([k, s]) => (s as JsonSchema).format === 'uuid' || /JobId$/.test(k))?.[0] ?? fields.find(([k]) => sourceOf(target.input[k]) !== 'literal')?.[0];
    if (!jobField) { notice = `${target.id} has no field that can take a job reference; bind a result path in the panel instead.`; return; }
    target.input[jobField] = { $job: connection.source };
    selected = target.id;
    touch();
  }
  function ondelete({ nodes: removed, edges: removedEdges }: { nodes: Node[]; edges: Edge[] }) {
    for (const e of removedEdges) {
      const [, rest] = e.id.split('->');
      const [targetId, field] = rest.split(':');
      const target = recipe.steps.find((s) => s.id === targetId);
      if (target && isBinding(target.input[field])) delete target.input[field];
    }
    for (const n of removed) removeStep(n.id);
    if (removedEdges.length) touch();
  }

  async function save() {
    saving = true;
    error = null;
    try {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(recipe.id)) throw new Error('Recipe id must be a lowercase slug');
      if (!recipe.title.trim()) throw new Error('Title is required');
      const saved = await store.saveRecipe($state.snapshot(recipe) as Recipe);
      dirty = false;
      notice = 'Saved';
      if (isNew) location.hash = `#/recipes/${saved.id}`;
    } catch (e) {
      error = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
  async function remove() {
    if (isNew) { location.hash = '#/recipes'; return; }
    await store.deleteRecipe(recipe.id);
    location.hash = '#/recipes';
  }
</script>

{#if !loaded}
  <p>{store.recipes.length ? `Unknown recipe ${id}.` : 'Loading…'}</p>
{:else}
<div class="editor">
  <div class="canvas">
    <SvelteFlow bind:nodes bind:edges {nodeTypes} fitView colorMode="system"
      onnodeclick={({ node }) => { selected = node.id; }}
      onpaneclick={() => { selected = null; }}
      onnodedragstop={({ targetNode }) => { if (targetNode) { recipe.layout = { ...recipe.layout, [targetNode.id]: { x: Math.round(targetNode.position.x), y: Math.round(targetNode.position.y) } }; touch(); } }}
      {onconnect} {ondelete} deleteKey="Delete">
      <Background />
      <Controls />
    </SvelteFlow>
  </div>

  <aside class="panel side">
    <p class="crumbs"><a href="#/recipes">Recipes</a> / {isNew ? 'new' : recipe.id}</p>
    <div class="field"><label for="rid">id</label><input id="rid" bind:value={recipe.id} disabled={!isNew} oninput={touch} placeholder="investigate-issue" /></div>
    <div class="field"><label for="rtitle">title</label><input id="rtitle" bind:value={recipe.title} oninput={touch} /></div>
    <div class="field"><label for="rdesc">description</label><textarea id="rdesc" rows="2" bind:value={recipe.description} oninput={touch}></textarea></div>

    <div class="add">
      <select bind:value={newCapability}>
        <option value="">Add a step…</option>
        {#each store.stepCapabilities as c}<option value={c.id}>{c.id}</option>{/each}
      </select>
      <button type="button" class="secondary" onclick={addStep} disabled={!newCapability}>Add</button>
    </div>

    {#if step}
      <hr />
      <h2>Step <code>{step.id}</code></h2>
      <div class="field"><label for="sid">id</label><input id="sid" value={step.id} onchange={(e) => renameStep(step!.id, e.currentTarget.value)} /></div>
      <p class="muted"><code>{step.capability}</code> · {capabilityOf(step.capability)?.description}</p>
      <label class="check"><input type="checkbox" bind:checked={step.continueOnFailure} onchange={touch} /> continue when this step fails</label>
      {#each Object.entries(stepSchema?.properties ?? {}) as [field, raw] (field)}
        {@const schema = raw as JsonSchema}
        {@const source = sourceOf(step.input[field])}
        <div class="binding">
          <div class="head">
            <strong>{field}</strong>{#if stepSchema?.required?.includes(field)}<span class="star">*</span>{/if}
            {#if schema.const === undefined}
              <select value={source} onchange={(e) => setSource(field, e.currentTarget.value as Source)}>
                <option value="literal">literal</option>
                <option value="param">parameter</option>
                <option value="job" disabled={!earlier.length}>job of step</option>
                <option value="result" disabled={!earlier.length}>result of step</option>
              </select>
            {/if}
          </div>
          {#if schema.const !== undefined}
            <span class="muted">{String(schema.const)}</span>
          {:else if source === 'literal'}
            {#key `${step.id}:${field}`}<SchemaForm {schema} bind:value={step.input[field]} path={field} />{/key}
          {:else if source === 'param'}
            <input value={(step.input[field] as any).$param} oninput={(e) => { step!.input[field] = { $param: e.currentTarget.value }; touch(); }} placeholder="parameter name" />
          {:else if source === 'job'}
            <select value={(step.input[field] as any).$job} onchange={(e) => { step!.input[field] = { $job: e.currentTarget.value }; touch(); }}>
              {#each earlier as s}<option value={s.id}>{s.id}</option>{/each}
            </select>
          {:else}
            <div class="row">
              <select value={(step.input[field] as any).$result[0]} onchange={(e) => { step!.input[field] = { $result: [e.currentTarget.value, (step!.input[field] as any).$result[1]] }; touch(); }}>
                {#each earlier as s}<option value={s.id}>{s.id}</option>{/each}
              </select>
              <input value={(step.input[field] as any).$result[1]} oninput={(e) => { step!.input[field] = { $result: [(step!.input[field] as any).$result[0], e.currentTarget.value] }; touch(); }} placeholder="path, e.g. run.status" />
            </div>
          {/if}
          {#if schema.description}<small>{schema.description}</small>{/if}
        </div>
      {/each}
      <p><button type="button" class="secondary small" onclick={() => removeStep(step!.id)}>Remove step</button></p>
    {:else}
      <p class="muted">Select a step to edit its inputs. Drag from a step's right handle to another step to pass its job ID. Delete removes the selected step or edge.</p>
    {/if}

    <hr />
    {#if error}<p class="error">{error}</p>{/if}
    {#if notice}<p class="muted">{notice}</p>{/if}
    <div class="actions">
      <button type="button" onclick={save} disabled={saving || !recipe.steps.length}>{saving ? 'Saving…' : 'Save'}</button>
      {#if !isNew && !dirty}<a class="button" href={`#/run/recipe.${recipe.id}`}>Run</a>{/if}
      <button type="button" class="secondary" onclick={remove}>{isNew ? 'Discard' : 'Delete'}</button>
    </div>
  </aside>
</div>
{/if}

<style>
  .editor { display: grid; grid-template-columns: 1fr 380px; gap: 1rem; height: calc(100vh - 6rem); }
  .canvas { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--bg); }
  .canvas :global(.svelte-flow) { background: var(--bg); }
  .canvas :global(.svelte-flow__edge-label) { background: var(--panel); color: var(--muted); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }
  .canvas :global(.svelte-flow__edge-text) { fill: var(--muted); font-size: 11px; }
  .canvas :global(.svelte-flow__edge-textbg) { fill: var(--panel); }
  .side { overflow: auto; }
  .crumbs { color: var(--muted); margin-top: 0; }
  .field { display: grid; gap: 0.2rem; margin-bottom: 0.6rem; }
  .field label { font-size: 0.85rem; font-weight: 600; }
  .add { display: flex; gap: 0.5rem; margin: 0.8rem 0; }
  .add select { flex: 1; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 1rem 0; }
  h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  .check { display: flex; gap: 0.4rem; align-items: center; font-size: 0.9rem; margin-bottom: 0.6rem; }
  .binding { border-top: 1px dashed var(--line); padding: 0.6rem 0; display: grid; gap: 0.3rem; }
  .binding .head { display: flex; align-items: center; gap: 0.5rem; }
  .binding .head select { margin-left: auto; width: auto; }
  .row { display: flex; gap: 0.4rem; }
  .row input { flex: 1; }
  .star { color: var(--accent); }
  .actions { display: flex; gap: 0.5rem; align-items: center; }
  a.button { background: var(--accent); color: #fff; border-radius: 6px; padding: 0.45rem 0.9rem; text-decoration: none; }
  input, select, textarea { width: 100%; }
  input[type='checkbox'] { width: auto; }
</style>
