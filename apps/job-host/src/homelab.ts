import { respondJson, type RouteHandler } from '@onionsoup/job-host';
import { describeSource, type HomelabRegistry } from '@onionsoup/host-capabilities';

/** GET /v1/homelab/sources: the source registry with each source's latest observation and assessment. */
export function homelabRoute(registry: HomelabRegistry): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method !== 'GET' || url !== '/v1/homelab/sources') return false;
    respondJson(res, 200, { sources: await Promise.all(registry.list().map((entry) => describeSource(registry, entry))) });
    return true;
  };
}
