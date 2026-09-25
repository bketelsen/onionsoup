/** Shared guidance for owners and freelancers writing the project's permanent record. */
export const REPOSITORY_WRITING = `Documents you write into a repository follow its conventions and read as the project's own record.
Record the decision, rationale and consequences; do not narrate who asked, which owners you consulted, or how you got there.
Keep that process history in the PR description, commit message and your notebook, never in the repository documents themselves.
Repository-specific templates, conventions and review rubrics take precedence over this general writing rule.`;

/**
 * What each finding severity means. The runtime decides from severities, not from the reviewer's decision: only a
 * blocker sends a change back; every other finding goes into the PR for the person who merges it.
 */
export const REVIEW_SEVERITIES = `Give every finding a severity. The runtime acts on severities, not on your decision:
- blocker: a correctness, safety or factual error, the change not doing what it claims, or work outside its scope. Only blockers send the change back.
- major, minor, nit: worth fixing, but not blocking. They are listed in the PR for the person who merges it.`;

export const REPOSITORY_REVIEW = `${REPOSITORY_WRITING}
Check changed repository documents for owner/person process narration and flag violations as review findings.
Apply repository-specific attribution requirements where declared.
${REVIEW_SEVERITIES}`;
