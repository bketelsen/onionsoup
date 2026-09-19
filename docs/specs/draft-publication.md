# Spec: Owned-fixture draft publication

This contract governs deterministic preparation, approval and remote publication
of a validated `candidate_verified` fixture workflow. It grants no agent new tools.

## Interface

Canonical schemas: `src/publication/contracts.ts`. Functions: `preparePublication`,
`approvePublication`, `publish`; CLI: `npm run publication --`.

```json
{
  "schemaVersion": 1,
  "stateDirectory": "./publication-state",
  "targets": [{
    "repository": "bketelsen/onionsoup-fixtures",
    "repositoryId": 123,
    "baseBranch": "bug-base",
    "baseCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }]
}
```

The example IDs must be replaced with observed repository/commit identities.
Paths resolve relative to the configuration file. Up to ten exact targets are
allowed; duplicate repository/base-branch entries are refused. Only `bketelsen/*`
repositories are permitted in this initial implementation. A target must already
contain the original exact fixture base, without extra tracked files or workflows.

```bash
npm run publication -- prepare --config CONFIG --fixture FIXTURE_DIR --target-index 0
npm run publication -- inspect --config CONFIG --id PUBLICATION_ID
npm run publication -- approve --config CONFIG --id PUBLICATION_ID --bundle-hash HASH --reason 'Existing explicit user authorization and its scope'
npm run publication -- publish --config CONFIG --id PUBLICATION_ID --bundle-hash HASH
```

`prepare` returns publication ID, bundle digest and head commit. `inspect` shows the
exact bundle and saved state. `approve` records session authority with provenance;
`publish` also reconciles earlier intents. Commands exit nonzero on blocked/unknown
outcomes. Do not copy raw evidence to public Git; PR bodies contain bounded evidence
summaries, hashes, criterion checks, findings and limitations, not model messages.

| Artifact | Binding |
| --- | --- |
| `bundle.json` | Version, workflow UUID, stable publication digest, target numeric ID/base ref/commit, fixture hash and embedded record, config hash, head commit/tree, exact diff/title/body |
| `state.json` | Bundle hash, approval, status, ordered timestamped journal, observed PR receipt if available |
| `candidate.patch` | Exact reviewed diff; independently reconstructed before local commit |
| `git/` | Local original base and one verified candidate commit; no execution or credential files |

Stable identity hashes target plus full fixture artifact. Branch is
`codex/onionsoup-` plus the first 32 hex characters. Approval binds the complete
bundle hash and config hash, authority/provenance, approval time and 24-hour expiry.
The commit is created once during preparation and reused; preparation does not
rewrite evidence or pretend the remote commit was tested by GitHub CI.

## Rules

- Only a completed verified candidate with no pending execution is eligible.
- Actual base and candidate Git blobs MUST equal saved fixture contents, have
  regular non-executable file modes, and contain only the two owned files. Parent,
  tree and diff MUST match the bundle before publication.
- Permission is the intersection of configured exact target and recorded approval.
  Changes to bundle/config invalidate approval. A browser cannot edit either.
- Intent MUST be persisted before branch push or PR create. Storage failure stops
  further effects; a saved intent is not evidence of completion.
- Branch push MUST use an empty expected-old-value lease. Existing conflicting
  branches cannot be overwritten. A matching observed branch may be reused.
- Fresh remote repository/base/head checks precede writes. Draft PR creation uses
  the exact title/body, same-repository head, configured base and `draft: true`.
- A saved `pr_intent` permanently prevents another create call for this identity.
  An ambiguous response is reconciled through all-state PR lookup. An absent result
  stays `unknown`; do not reprepare or change identity to evade that uncertainty.
- Published success requires exactly one observed open draft with exact repository,
  base/head commits and refs, title/body. Conflicts, closed/merged/non-draft PRs,
  duplicate results or stale base produce `blocked`. Any observed PR remains visible.
- Expired approval prevents new writes but does not prevent observing a previously
  created PR. The implementation does not promise atomic base locking or exactly-once
  effects across hosts. Limits and races follow the [design](../design/draft-publication.md).
- No merge, comments, labels, reviewer assignments, branch deletion or automatic
  revision. Repository provisioning remains an explicit operator action.

States: `prepared`, `approved`, `push_intent`, `branch_published`, `pr_intent`,
`published`, `unknown`, `blocked`. The journal supplies common derived-snapshot
`publication.*` events with workflow/parent IDs, publication/bundle hashes, base
commit and an allowlisted reason. No source, PR prose, authorization reason,
credential, private path or transport error is exported in events.

## Derived artifacts

Console config optionally names `publicationConfig`, resolved relative to console
configuration. `GET /publications` lists up to 300 bundles. `GET /publications/ID`
shows exact diff/body, evidence summary, approval and journal; `/json` and `/events`
provide artifacts. `POST /publication-actions` accepts only CSRF token plus
`{action: approve|publish, id, bundleHash}`. Existing strict loopback host/origin,
CSRF and request-size checks apply. Publishing runs asynchronously; reload to see
status. The CLI and console share the filesystem lock; interrupted locks require
manual inspection. Malformed or symlink-escaped history entries are excluded.

## References

- Rationale: [ADR-0016](../adr/0016-publish-only-approved-fixture-bundles.md).
- Context: [publication design](../design/draft-publication.md), [console design](../design/operator-console.md).
- Plan: [Phase 4](../plans/investigation-to-pr.md#phase-4--explicit-draft-publication).
- GitHub APIs: [pull requests](https://docs.github.com/en/rest/pulls/pulls), [Git references](https://docs.github.com/en/rest/git/refs).
