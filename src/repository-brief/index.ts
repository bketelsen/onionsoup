// Legacy compatibility surface. Canonical implementations live in the workspace packages.
export { BriefRequest, ThemeInput, ThemeResult, HealthInput, HealthResult, ActionsInput, ActionsResult, REPO_BRIEF_LIMITS } from './contracts.ts';
export { summarizeRepositoryThemes, interpretRepositoryHealth, suggestMaintenanceActions, validateRepoAgentRun } from './agents.ts';
export { collectRepository, type GithubReader } from './collect.ts';
export { repositoryMetrics, validateSnapshot } from './metrics.ts';
export { createRepositoryBrief, renderRepositoryBrief } from './recipe.ts';
export { validateRepositoryBrief } from './record.ts';
export { repositoryCapabilityManifest } from './capabilities.ts';
