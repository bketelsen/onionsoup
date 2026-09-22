import { respondJson, type RouteHandler } from '@onionsoup/job-host';
import type { ModelRegistry } from '@onionsoup/host-capabilities';
import { catalogs, type ProviderCatalog } from '@onionsoup/providers';

/** How long provider catalogs are reused before the next page load asks the providers again. */
export const MODEL_ROUTE_LIMITS = { catalogCacheMs: 10 * 60 * 1000 };

/**
 * GET /v1/models: each agent's model and where it comes from, plus every provider's catalog.
 * `?refresh=1` asks the providers again. Changes go through the models.assign capability.
 */
export function modelsRoute(registry: ModelRegistry, readCatalogs: typeof catalogs = catalogs, limits = MODEL_ROUTE_LIMITS): RouteHandler {
  let cached: { at: number; catalogs: ProviderCatalog[] } | undefined;
  const current = async (refresh: boolean) => {
    if (refresh || !cached || Date.now() - cached.at > limits.catalogCacheMs) cached = { at: Date.now(), catalogs: await readCatalogs() };
    return cached;
  };
  return async ({ req, res, url }) => {
    const [path, query = ''] = url.split('?');
    if (req.method !== 'GET' || path !== '/v1/models') return false;
    const listing = await current(new URLSearchParams(query).get('refresh') === '1');
    respondJson(res, 200, {
      agents: registry.describe(),
      catalogs: listing.catalogs,
      catalogsAt: new Date(listing.at).toISOString(),
      persisted: Boolean(registry.options.directory),
    });
    return true;
  };
}
