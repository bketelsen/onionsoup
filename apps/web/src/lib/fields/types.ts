import type { JsonSchema } from '../store.svelte.ts';

/** Every field component takes the same props, so SchemaForm can pick one from a table. */
export type FieldProps = { id: string; schema: JsonSchema; value: unknown; required: boolean };
