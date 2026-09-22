<script lang="ts">
  import JobPicker from '../ui/JobPicker.svelte';
  import type { FieldProps } from './types.ts';
  let { id, schema, value = $bindable(), required }: FieldProps = $props();
</script>

<JobPicker {id} capabilities={schema.jobOf ?? []} bind:value {required} />
