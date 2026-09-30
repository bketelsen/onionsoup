import type { FrictionRecord, FrictionTriage, FrictionPromotionView } from '@onionsoup/owners';

/** The public view omits the host-only directory used to deliver notices. */
export type PublicFrictionRecord = Omit<FrictionRecord, 'origin'> & { sessionID: string;
  proposalDigest?: string;
  promotion?: FrictionPromotionView;
  triageError?: 'friction_triage_unreadable';
  triage?: Pick<FrictionTriage, 'state' | 'updatedAt' | 'reason' | 'investigation'>;
};
