import type { JsonSchema } from './store.svelte.ts';

export type Kind = 'const' | 'job' | 'string' | 'datetime' | 'number' | 'boolean' | 'enum' | 'string-list' | 'object' | 'json';

export function typeOf(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== 'null');
  if (schema.type) return schema.type;
  if (schema.properties) return 'object';
  if (schema.enum) return 'string';
  return undefined;
}

/** Kind tests in priority order; the first that matches picks the field. */
const KIND_TESTS: [Kind, (schema: JsonSchema) => boolean][] = [
  ['const', (schema) => schema.const !== undefined],
  ['job', (schema) => Boolean(schema.jobOf?.length)],
  ['enum', (schema) => Boolean(schema.enum?.length)],
  ['datetime', (schema) => typeOf(schema) === 'string' && schema.format === 'date-time'],
  ['string', (schema) => typeOf(schema) === 'string'],
  ['number', (schema) => typeOf(schema) === 'number' || typeOf(schema) === 'integer'],
  ['boolean', (schema) => typeOf(schema) === 'boolean'],
  ['string-list', (schema) => typeOf(schema) === 'array' && Boolean(schema.items) && typeOf(schema.items!) === 'string' && !schema.items!.enum],
  ['object', (schema) => typeOf(schema) === 'object' && Boolean(schema.properties)],
];

export const kindOf = (schema: JsonSchema): Kind => KIND_TESTS.find(([, test]) => test(schema))?.[0] ?? 'json';

/** The empty value for each kind, used when the schema has no default. */
const EMPTY: Record<Kind, (schema: JsonSchema) => unknown> = {
  const: (schema) => structuredClone(schema.const),
  job: () => '',
  string: () => '',
  datetime: () => '',
  number: () => undefined,
  boolean: () => false,
  enum: (schema) => schema.enum![0],
  'string-list': () => [],
  object: (schema) => Object.fromEntries(Object.entries(schema.properties!).map(([key, child]) => [key, initial(child)])),
  json: () => undefined,
};

export function initial(schema: JsonSchema): unknown {
  return schema.default !== undefined ? structuredClone(schema.default) : EMPTY[kindOf(schema)](schema);
}

/** What a field accepts, in words: description, format, pattern and bounds. */
export function hintOf(schema: JsonSchema) {
  const pattern = schema.pattern && schema.pattern.length <= 80 && !schema.jobOf ? `pattern ${schema.pattern}` : '';
  const format = schema.format && !['uuid', 'date-time'].includes(schema.format) ? schema.format : '';
  const minimum = schema.minimum !== undefined ? `min ${schema.minimum}` : '';
  const maximum = schema.maximum !== undefined ? `max ${schema.maximum}` : '';
  return [schema.description, format, pattern, minimum, maximum].filter(Boolean).join(' · ');
}

/** Drop empty optional values so the host sees absent fields rather than "" or []. */
export function pruned(schema: JsonSchema, value: unknown): unknown {
  if (kindOf(schema) !== 'object' || !value || typeof value !== 'object') return value;
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, pruned(schema.properties?.[key] ?? {}, child)] as const);
  return Object.fromEntries(entries.filter(([key, child]) => required.has(key) || !isEmpty(child)));
}

const isEmpty = (value: unknown) => value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
