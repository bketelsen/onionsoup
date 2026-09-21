<script lang="ts">
  import { untrack } from 'svelte';
  import SchemaForm from './SchemaForm.svelte';
  import type { JsonSchema } from './store.svelte.ts';

  let { schema, value = $bindable(), path = '' }: { schema: JsonSchema; value: unknown; path?: string } = $props();

  type Kind = 'const' | 'string' | 'number' | 'boolean' | 'enum' | 'string-list' | 'object' | 'json';

  function typeOf(s: JsonSchema): string | undefined {
    if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null');
    if (s.type) return s.type;
    if (s.properties) return 'object';
    if (s.enum) return 'string';
    return undefined;
  }

  function kindOf(s: JsonSchema): Kind {
    if (s.const !== undefined) return 'const';
    if (s.enum && s.enum.length) return 'enum';
    const t = typeOf(s);
    if (t === 'string') return 'string';
    if (t === 'number' || t === 'integer') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'array' && s.items && typeOf(s.items) === 'string' && !s.items.enum) return 'string-list';
    if (t === 'object' && s.properties) return 'object';
    return 'json';
  }

  function initial(s: JsonSchema): unknown {
    if (s.default !== undefined) return structuredClone(s.default);
    switch (kindOf(s)) {
      case 'const': return structuredClone(s.const);
      case 'string': return '';
      case 'number': return undefined;
      case 'boolean': return false;
      case 'enum': return s.enum![0];
      case 'string-list': return [];
      case 'object': return Object.fromEntries(Object.entries(s.properties!).map(([k, v]) => [k, initial(v)]));
      default: return undefined;
    }
  }

  const kind = $derived(kindOf(schema));
  const required = $derived(new Set(schema.required ?? []));

  untrack(() => {
    if (value === undefined) value = initial(schema);
    else if (kindOf(schema) === 'object' && value && typeof value === 'object') {
      const current = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(schema.properties!)) if (current[key] === undefined) current[key] = initial(child);
    }
  });

  let jsonText = $state(value === undefined ? '' : JSON.stringify(value, null, 2));
  let jsonError = $state('');

  function onJson(text: string) {
    jsonText = text;
    if (!text.trim()) { value = undefined; jsonError = ''; return; }
    try { value = JSON.parse(text); jsonError = ''; } catch { jsonError = 'Not valid JSON'; }
  }

  function listText(list: unknown) {
    return Array.isArray(list) ? list.join(', ') : '';
  }
  function onList(text: string) {
    value = text.split(',').map((s) => s.trim()).filter(Boolean);
  }
  function onNumber(text: string) {
    value = text === '' ? undefined : Number(text);
  }

  const label = $derived(path.split('.').pop() ?? '');
  const hint = $derived([schema.description, schema.format, schema.pattern && schema.pattern.length <= 80 ? `pattern ${schema.pattern}` : '',
    schema.minimum !== undefined ? `min ${schema.minimum}` : '', schema.maximum !== undefined ? `max ${schema.maximum}` : ''].filter(Boolean).join(' · '));
</script>

{#if kind === 'const'}
  <span class="muted">{String(schema.const)}</span>
{:else if kind === 'object'}
  <fieldset class="object">
    {#if path}<legend>{label}</legend>{/if}
    {#each Object.entries(schema.properties!) as [key, child] (key)}
      <div class="field" class:required={required.has(key)}>
        {#if kindOf(child) !== 'object'}
          <label for={`${path}.${key}`}>{key}{#if required.has(key)}<span class="star">*</span>{/if}</label>
        {/if}
        <SchemaForm schema={child} bind:value={(value as Record<string, unknown>)[key]} path={`${path}.${key}`} />
      </div>
    {/each}
  </fieldset>
{:else if kind === 'enum'}
  <select id={path} bind:value>
    {#each schema.enum! as option}
      <option value={option}>{String(option)}</option>
    {/each}
  </select>
  {#if hint}<small>{hint}</small>{/if}
{:else if kind === 'boolean'}
  <input id={path} type="checkbox" bind:checked={value as boolean} />
  {#if hint}<small>{hint}</small>{/if}
{:else if kind === 'number'}
  <input id={path} type="number" value={value ?? ''} oninput={(e) => onNumber(e.currentTarget.value)} min={schema.minimum} max={schema.maximum} step={typeOf(schema) === 'integer' ? 1 : 'any'} />
  {#if hint}<small>{hint}</small>{/if}
{:else if kind === 'string-list'}
  <input id={path} type="text" value={listText(value)} oninput={(e) => onList(e.currentTarget.value)} placeholder="comma separated" />
  {#if hint}<small>{hint}</small>{/if}
{:else if kind === 'string'}
  {#if schema.format === 'date-time'}
    <input id={path} type="datetime-local" step="1" value={typeof value === 'string' && value ? value.slice(0, 19) : ''} oninput={(e) => { value = e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : ''; }} />
  {:else}
    <input id={path} type="text" bind:value maxlength={schema.maxLength} pattern={schema.pattern} />
  {/if}
  {#if hint}<small>{hint}</small>{/if}
{:else}
  <textarea id={path} rows="4" value={jsonText} oninput={(e) => onJson(e.currentTarget.value)} placeholder="JSON"></textarea>
  {#if jsonError}<small class="error">{jsonError}</small>{:else if hint}<small>{hint}</small>{/if}
{/if}

<style>
  fieldset.object { border: 1px solid var(--line); border-radius: 6px; padding: 0.75rem 1rem; margin: 0; display: grid; gap: 0.75rem; }
  legend { padding: 0 0.4rem; color: var(--muted); font-size: 0.85rem; }
  .field { display: grid; gap: 0.25rem; }
  label { font-weight: 600; font-size: 0.9rem; }
  .star { color: var(--accent); margin-left: 0.15rem; }
  small { color: var(--muted); }
  small.error { color: var(--danger); }
</style>
