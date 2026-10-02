import { frictionProposalDigest, type FrictionRecord, type FrictionTriage, type FrictionPromotionView,
  type FrictionFreshness, type Revision, type frictionPromotionHistory } from '@onionsoup/owners';

/** A digest is an offer for this exact displayed investigation, not authorization to route it. */
export function publicFrictionDigest(effective: { triage: FrictionTriage; revision: number } | undefined,
  freshness: FrictionFreshness | undefined): string | undefined {
  if (!effective || !freshness || freshness.stale
    || freshness.investigatedCommit !== effective.triage.sourceCommit) return undefined;
  return frictionProposalDigest(effective.triage, effective.revision);
}

/** The public view omits the host-only directory used to deliver notices. */
export type PublicFrictionRecord = Omit<FrictionRecord, 'origin'> & { sessionID: string;
  proposalDigest?: string;
  promotion?: FrictionPromotionView;
  promotionHistory?: Awaited<ReturnType<typeof frictionPromotionHistory>>;
  freshness?: FrictionFreshness;
  revisions?: Revision[];
  originalInvestigation?: FrictionTriage['investigation'];
  effectiveRevision?: number;
  triageError?: 'friction_triage_unreadable';
  unreadable?: ('friction_revisions_unreadable' | 'friction_promotion_history_unreadable')[];
  triage?: Pick<FrictionTriage, 'state' | 'updatedAt' | 'reason' | 'investigation' | 'bundle' | 'duplicateOf'>;
};
