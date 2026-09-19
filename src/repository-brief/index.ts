// Public local bundle. The CLI is a separate adapter and has no import-time side effects here.
export { BriefRequest, ThemeInput, ThemeResult, HealthInput, HealthResult, ActionsInput, ActionsResult, REPO_BRIEF_LIMITS } from './contracts.ts';
export { summarizeRepositoryThemes, interpretRepositoryHealth, suggestMaintenanceActions, validateRepoAgentRun } from './agents.ts';
export { collectRepository, type GithubReader } from './collect.ts';
export { repositoryMetrics, validateSnapshot } from './metrics.ts';
export { createRepositoryBrief, renderRepositoryBrief } from './recipe.ts';
export { validateRepositoryBrief } from './record.ts';
export { repositoryCapabilityManifest } from './capabilities.ts';
