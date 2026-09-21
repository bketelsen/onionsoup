import { z } from 'zod';
import { HostError } from './errors.ts';

/**
 * A recipe chains registered capabilities. It is operator content, not code:
 * it can only name capabilities the invoker is already granted, and every
 * child job is validated by that capability's own input schema when it runs.
 */
const Slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const CapabilityId = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);

/** How a step input field gets its value. */
export const Binding = z.union([
  z.object({ $param: Slug }).strict(),
  z.object({ $job: Slug }).strict(),
  z.object({ $result: z.tuple([Slug, z.string().min(1).max(200)]) }).strict(),
]);
export type Binding = z.infer<typeof Binding>;

export const Step = z.object({
  id: Slug,
  capability: CapabilityId,
  /** Literal JSON, or a binding, per input field. Nested objects may contain bindings too. */
  input: z.record(z.string(), z.unknown()).default({}),
  /** Keep going when this step fails; later steps that bind to it will fail themselves. */
  continueOnFailure: z.boolean().default(false),
}).strict();
export type Step = z.infer<typeof Step>;

export const Recipe = z.object({
  schemaVersion: z.literal(1),
  id: Slug,
  title: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  steps: z.array(Step).min(1).max(20),
  /** Optional explicit parameter schemas; missing ones are inferred from what they bind to. */
  params: z.record(Slug, z.record(z.string(), z.unknown())).default({}),
  /** Canvas positions, purely presentational. */
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).default({}),
}).strict().superRefine((recipe, ctx) => {
  const ids = new Set<string>();
  recipe.steps.forEach((step, index) => {
    if (ids.has(step.id)) ctx.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: 'Duplicate step id' });
    ids.add(step.id);
    const earlier = recipe.steps.slice(0, index).map((s) => s.id);
    for (const [target] of bindings(step.input)) {
      const ref = '$job' in target ? target.$job : '$result' in target ? target.$result[0] : undefined;
      if (ref !== undefined && !earlier.includes(ref))
        ctx.addIssue({ code: 'custom', path: ['steps', index, 'input'], message: `Step "${step.id}" binds to "${ref}", which is not an earlier step` });
    }
  });
});
export type Recipe = z.infer<typeof Recipe>;

/** Walk a step input and yield every binding with its path. */
export function* bindings(value: unknown, path: string[] = []): Generator<[Binding, string[]]> {
  const parsed = Binding.safeParse(value);
  if (parsed.success) { yield [parsed.data, path]; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield* bindings(value[i], [...path, String(i)]); }
  else if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) yield* bindings(v, [...path, k]); }
}

type JsonSchema = Record<string, any>;

function schemaAt(schema: JsonSchema | undefined, path: string[]): JsonSchema | undefined {
  let current = schema;
  for (const key of path) {
    if (!current) return undefined;
    if (current.type === 'array' || current.items) current = current.items;
    else current = current.properties?.[key];
  }
  return current;
}

/** Parameter schemas: explicit ones win; otherwise inherit the schema of the first field each param binds to. */
export function inferParams(recipe: Recipe, capabilities: Map<string, { inputSchema: JsonSchema }>): Record<string, JsonSchema> {
  const params: Record<string, JsonSchema> = { ...recipe.params };
  for (const step of recipe.steps) {
    const schema = capabilities.get(step.capability)?.inputSchema;
    for (const [binding, path] of bindings(step.input)) {
      if (!('$param' in binding) || params[binding.$param]) continue;
      const field = schemaAt(schema, path);
      params[binding.$param] = field ? { ...field, description: field.description ?? `${step.id}.${path.join('.')}` } : { description: `${step.id}.${path.join('.')}` };
    }
  }
  return params;
}

export function paramSchema(params: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties: params, required: Object.keys(params), additionalProperties: false };
}

/** Check a recipe against the capabilities an invoker may use. */
export function validateRecipe(raw: unknown, allowed: Map<string, { inputSchema: JsonSchema }>): Recipe {
  const recipe = Recipe.parse(raw);
  for (const step of recipe.steps) {
    if (!allowed.has(step.capability)) throw new HostError(`unknown_capability:${step.capability}`);
    if (step.capability.startsWith('recipe.')) throw new HostError('nested_recipes_not_supported');
  }
  return recipe;
}

export type StepOutcome = { id: string; capability: string; jobId?: string; status: string; error?: string };

function valueAt(value: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as any)[key] : undefined), value);
}

/** Replace bindings with concrete values. */
export function resolveInput(input: unknown, context: { params: Record<string, unknown>; jobs: Map<string, { jobId: string; result?: unknown }> }): unknown {
  const binding = Binding.safeParse(input);
  if (binding.success) {
    const b = binding.data;
    if ('$param' in b) {
      if (!(b.$param in context.params)) throw new HostError(`missing_param:${b.$param}`);
      return context.params[b.$param];
    }
    const id = '$job' in b ? b.$job : b.$result[0];
    const job = context.jobs.get(id);
    if (!job) throw new HostError(`step_unavailable:${id}`);
    if ('$job' in b) return job.jobId;
    const value = valueAt(job.result, b.$result[1]);
    if (value === undefined) throw new HostError(`result_path_missing:${id}.${b.$result[1]}`);
    return value;
  }
  if (Array.isArray(input)) return input.map((v) => resolveInput(v, context));
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, resolveInput(v, context)]));
  return input;
}
