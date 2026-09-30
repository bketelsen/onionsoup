import type { ChildAbandonment } from '@onionsoup/owners';

/** Evidence of an approved recovery action; host directories and execution controls are not public fields. */
export type ChildRecoveryNotice = Pick<ChildAbandonment,
  'state' | 'childID' | 'parentID' | 'reason' | 'approvedBy' | 'approvedAt' | 'digest'>;
