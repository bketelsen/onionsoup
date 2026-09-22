/** The parts of a `change.proposal` result the web reads. */
export type Claim = { text: string; basis: 'reported' | 'proposed'; evidenceIds: string[] };
export type Proposal = {
  status: 'proposal_ready' | 'needs_information';
  outcome: Claim; changes: Claim[]; nonGoals: Claim[];
  acceptanceCriteria: { id: string; criterion: Claim }[];
  verification: { criterionIds: string[]; kind: string; check: Claim; baselineExpectation: string }[];
  questions: { question: string; blocking: boolean }[];
  risks: Claim[];
};
export type Source = { id: string; path: string; startLine: number; endLine: number; relevance?: string };
export type ProposalWorkflow = {
  status: string;
  parent: { issue: { repository: string; number: number; title: string }; repository: { name: string; commit: string } };
  preparation?: { sources: Source[]; limitations?: string[] };
  stages: { agent: string; run?: { status: string; result?: unknown; provider?: string; model?: string } }[];
};

export const workflowOf = (result: unknown) => (result as { proposal: ProposalWorkflow }).proposal;
export const proposalOf = (workflow: ProposalWorkflow) => workflow.stages.find((stage) => stage.agent === 'change-proposal')?.run?.result as Proposal | undefined;

/** Files the proposal cites, in order; approval allows these unless the person overrides them. */
export const citedFiles = (result: unknown) => [...new Set((workflowOf(result).preparation?.sources ?? []).map((source) => source.path))];
