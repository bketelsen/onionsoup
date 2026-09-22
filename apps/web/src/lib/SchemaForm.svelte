<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import type { JsonSchema } from './store.svelte.ts';
  import { kindOf, initial, hintOf, type Kind } from './schema.ts';
  import { humanize } from './format.ts';
  import type { FieldProps } from './fields/types.ts';
  import ConstField from './fields/ConstField.svelte';
  import JobField from './fields/JobField.svelte';
  import EnumField from './fields/EnumField.svelte';
  import BooleanField from './fields/BooleanField.svelte';
  import NumberField from './fields/NumberField.svelte';
  import StringListField from './fields/StringListField.svelte';
  import DateTimeField from './fields/DateTimeField.svelte';
  import TextField from './fields/TextField.svelte';
  import JsonField from './fields/JsonField.svelte';
  import ObjectField from './fields/ObjectField.svelte';

  /** `path` identifies the field in the form; `name` is its key in the parent object, empty at the root. */
  let { schema, value = $bindable(), path = '', name = '', required = false }: { schema: JsonSchema; value: unknown; path?: string; name?: string; required?: boolean } = $props();

  const FIELDS: Record<Kind, Component<FieldProps, {}, 'value'>> = {
    const: ConstField,
    job: JobField,
    enum: EnumField,
    boolean: BooleanField,
    number: NumberField,
    'string-list': StringListField,
    datetime: DateTimeField,
    string: TextField,
    json: JsonField,
    object: ObjectField,
  };

  const kind = $derived(kindOf(schema));
  const Field = $derived(FIELDS[kind]);
  const hint = $derived(hintOf(schema));
  const label = $derived(schema.title ?? humanize(name));
  const isNested = $derived(kind === 'object' && Boolean(name));

  untrack(() => {
    if (value === undefined) value = initial(schema);
    else if (kindOf(schema) === 'object' && value && typeof value === 'object') {
      const current = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(schema.properties!)) if (current[key] === undefined) current[key] = initial(child);
    }
  });
</script>

{#if kind === 'const' && name}
  <!-- Fixed values need no field; the form sends them as they are. -->
{:else if !name}
  <Field id={path} {schema} bind:value {required} />
{:else if isNested}
  <fieldset>
    <legend>{label}</legend>
    <Field id={path} {schema} bind:value {required} />
  </fieldset>
{:else}
  <div class="field">
    <label for={path}>{label}{#if required}<span class="star" aria-label="required">*</span>{/if}</label>
    <Field id={path} {schema} bind:value {required} />
    {#if hint}<small>{hint}</small>{/if}
  </div>
{/if}

<style>
  fieldset { border: 1px solid var(--line); border-radius: 6px; padding: 0.75rem 1rem; margin: 0; }
  legend { padding: 0 0.4rem; color: var(--muted); font-size: 0.85rem; }
  .field { display: grid; gap: 0.25rem; }
  label { font-weight: 600; font-size: 0.9rem; }
  .star { color: var(--accent); margin-left: 0.15rem; }
  small { color: var(--muted); }
</style>
