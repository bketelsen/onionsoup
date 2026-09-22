import { respondJson, type RouteHandler } from '@onionsoup/job-host';
import { describeEntry, type RepositoryRegistry } from '@onionsoup/host-capabilities';

/** GET /v1/repositories: the registry as the settings page shows it. Changes go through the onboarding capabilities. */
export function repositoriesRoute(registry: RepositoryRegistry): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method !== 'GET' || url !== '/v1/repositories') return false;
    const repositories = await Promise.all(registry.names().map((name) => describeEntry(registry, name)));
    respondJson(res, 200, { repositories, nodeRuntime: Boolean(registry.options.nodeRuntime) });
    return true;
  };
}
