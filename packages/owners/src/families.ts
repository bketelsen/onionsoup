import type { FamilyTable, ModelRef } from './declarations.ts';

function globToPattern(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

export function familyOf(table: FamilyTable, model: ModelRef) {
  const entry = table.families.find(candidate => candidate.match.some(glob => globToPattern(glob).test(model)));
  if (!entry) throw new Error(`unknown_model_family: ${model}; add a family whose match covers it to families.yaml`);
  return entry.family;
}

/** First model in preference order whose family is not excluded. */
export function pickModel(table: FamilyTable, preferences: readonly ModelRef[], excludedFamilies: readonly string[]) {
  const model = preferences.find(candidate => !excludedFamilies.includes(familyOf(table, candidate)));
  if (!model) throw new Error(`no_model_outside_families: ${excludedFamilies.join(',')}`);
  return { model, family: familyOf(table, model) };
}
