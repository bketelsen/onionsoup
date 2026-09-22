<script lang="ts">
  import type { FieldProps } from './types.ts';
  let { schema }: FieldProps = $props();
</script>

<span class="muted">{String(schema.const)}</span>
