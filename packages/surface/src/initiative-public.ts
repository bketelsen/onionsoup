import type { AssignmentState, Initiative, InitiativeStatus } from '@onionsoup/owners';

/** An owner in the org chart; the tree is drawn from `manager`. */
export interface OrgEntry {
  id: string;
  name: string;
  title: string;
  icon: string;
  domain: string;
  manager?: string;
}

/** An assignment as the surface shows it: derived state, place in the dependency order, and its work. */
export interface PublicAssignment {
  id: string;
  to: string;
  title: string;
  after: string[];
  depth: number;
  state: AssignmentState;
  request?: string;
  item?: { id: string; status: string; url?: string; prState?: string };
}

/** The public view leaves out the manager's chat, which is only for host-side notice delivery. */
export type PublicInitiative = Omit<Initiative, 'assignments' | 'origin'> & { assignments: PublicAssignment[] };

export interface InitiativeSummary {
  id: string;
  owner: string;
  title: string;
  status: InitiativeStatus;
  revision: number;
  merged: number;
  total: number;
  openEscalations: number;
  updatedAt: string;
}
