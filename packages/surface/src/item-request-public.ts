import { z } from 'zod';

/** The item page reuses the host's bounded request/evidence presentation. */
export const ItemRequestContext = z.object({ requestText: z.string().optional() });
export type ItemRequestContext = z.infer<typeof ItemRequestContext>;
