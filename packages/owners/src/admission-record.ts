import { z } from 'zod';

/** Persistent identity shared by admission gates and conservative maintenance recovery. */
export const AdmissionRecord = z.object({
  id: z.uuid(),
  kind: z.string().trim().min(1),
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^\d+$/),
  maintenance: z.object({ instanceID: z.uuid(), operationID: z.uuid(), directory: z.string() }).optional(),
});
