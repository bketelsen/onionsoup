import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ReleaseManifest = z.object({ buildId: z.string().trim().min(1) });
export const DeploymentIntent = z.object({
  status: z.enum(['armed', 'waiting', 'draining', 'completed', 'cancelled']),
  targetBuildId: z.string().trim().min(1),
});
export type DeploymentView = {
  buildId: string | null;
  isPending: boolean;
  pending?: Pick<z.infer<typeof DeploymentIntent>, 'status' | 'targetBuildId'>;
};

/** The manifest is installed beside the surface package, independent of a moving source checkout. */
export const DEFAULT_RELEASE_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-manifest.json');

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Resolve and validate the running release identity once, before starting the surface. */
export async function readReleaseBuildId(manifestPath: string): Promise<string | null> {
  const manifestInput = await optionalJson(manifestPath);
  const manifest = manifestInput === undefined ? undefined : ReleaseManifest.safeParse(manifestInput);
  if (manifest && !manifest.success) throw new Error('deployment_invalid_manifest');
  return manifest?.data.buildId ?? null;
}

/** Read the durable intent each time; it may change without restarting the surface. */
export async function readDeploymentView(options: { buildId: string | null; stateDirectory: string }): Promise<DeploymentView> {
  const intentInput = await optionalJson(join(options.stateDirectory, 'deploy', 'pending.json'));
  const intent = intentInput === undefined ? undefined : DeploymentIntent.safeParse(intentInput);
  if (intent && !intent.success) throw new Error('deployment_invalid_pending');
  const { buildId } = options;
  const pending = intent?.data;
  if (!pending || !['armed', 'waiting', 'draining'].includes(pending.status)) return { buildId, isPending: false };
  return { buildId, isPending: true, pending };
}
