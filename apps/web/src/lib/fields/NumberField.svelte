<script lang="ts">
  import { typeOf } from '../schema.ts';
  import type { FieldProps } from './types.ts';
  let { id, schema, value = $bindable(), required }: FieldProps = $props();
</script>

<input {id} type="number" {required} value={value ?? ''} min={schema.minimum} max={schema.maximum} step={typeOf(schema) === 'integer' ? 1 : 'any'}
  oninput={(event) => { value = event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value); }} />
