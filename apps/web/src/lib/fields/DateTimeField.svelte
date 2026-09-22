<script lang="ts">
  import type { FieldProps } from './types.ts';
  let { id, value = $bindable(), required }: FieldProps = $props();

  /** datetime-local wants local time without a zone; the host wants ISO UTC. */
  const local = (iso: string) => {
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  };
</script>

<input {id} type="datetime-local" step="1" {required} value={typeof value === 'string' && value ? local(value) : ''}
  oninput={(event) => { value = event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : ''; }} />
