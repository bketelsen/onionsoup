import { z } from 'zod';

export const InboxReadError = z.object({
  owner: z.string(),
  code: z.enum(['chat_directory_failed', 'permission_list_failed', 'question_list_failed']),
});
export type InboxReadError = z.infer<typeof InboxReadError>;
