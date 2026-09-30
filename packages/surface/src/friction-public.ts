import type { FrictionRecord, FrictionTriage } from '@onionsoup/owners';

/** The public view omits the host-only directory used to deliver notices. */
export type PublicFrictionRecord = Omit<FrictionRecord, 'origin'> & { sessionID: string;
  triage?: Pick<FrictionTriage, 'state' | 'updatedAt' | 'reason' | 'investigation'>;
};
