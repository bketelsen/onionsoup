export const requestText=`Operator-authored feature request, not a fetched GitHub issue: add publication-history filtering by status in Onionsoup's local console.
GET /publications defaults to all saved valid entries. Support one optional status query: all, prepared, approved, push_intent, branch_published, pr_intent, published, unknown, blocked. A valid specific status shows only matching entries. Invalid, empty or repeated status parameters return HTTP 400. Filtering is only for the list route; detail and artifact routes retain current behavior.
Provide a GET form with a status select, including All, preserving the selected status and allowing return to All. Keep unavailable/incomplete coverage warnings visible when filtered; empty selection results should be explicit. This is only a view over bounded saved history, never a model call, execution, publication or mutation. Preserve current authority, escaping and CSRF behavior.
Update docs/specs/draft-publication.md to describe the query values, default, invalid/repeated behavior, empty results and bounded coverage. No dependency, credential, test-policy or unrelated changes. Allowed files: src/publication/console.ts, src/console/server.ts, docs/specs/draft-publication.md.
Success will be checked with host-owned HTTP scenarios, typechecking and selected existing console compatibility tests; the model cannot change those checks.`;

export const GO_PROFILE='clippy-bubble-color-v1' as const;
export const goRequest=`Operator-authorized trial feature, not a fetched GitHub issue: add -bubble-color to bketelsen/clippy.
Accept #RRGGBB or #RRGGBBAA hex colors (also without the # prefix, matching the existing text-color parser). The option controls the speech bubble fill only. Preserve the current default pale yellow (#FFFFBE), black outline, text color, character layer, scaling, output paths and PNG stdout behavior. Invalid colors must return an error identifying -bubble-color; no output should be written for invalid input.
Document RGB and RGBA examples, the default, and optional # prefix in README.md. Only main.go and README.md may change. Preserve all original tests, dependencies, embedded assets, workflow files and unrelated behavior. Do not implement clipboard changes.
Host verification runs Go build, all original tests, vet, gofmt and additional fixed color/default/error/render checks offline. Models cannot change commands or tests. This is a feature trial under user authorization, not an existing issue or a project acceptance decision.`;
export const profiles={
 'onionsoup-publication-filter-v1':{repository:'bketelsen/onionsoup',title:'Filter publication history by status',request:requestText,
  paths:['src/publication/console.ts','src/console/server.ts','docs/specs/draft-publication.md'],manifests:['package.json','package-lock.json'],language:'typescript',
  checks:['default-history','status-filter','invalid-filter','filter-controls','coverage-preserved','detail-unchanged','documentation','typecheck','adjacent-console'],
  baseline:['default-history','detail-unchanged','coverage-preserved','typecheck','adjacent-console']},
 'clippy-bubble-color-v1':{repository:'bketelsen/clippy',title:'Add configurable speech bubble color',request:goRequest,
  paths:['main.go','README.md'],manifests:['go.mod','go.sum'],language:'go',
  checks:['go-build','go-test','go-vet','gofmt','bubble-default','bubble-colors','bubble-invalid','documentation'],
  baseline:['go-build','go-test','go-vet','gofmt','bubble-default']},
} as const;
export type ProfileId=keyof typeof profiles;
export function projectProfile(id:string) {if(!Object.hasOwn(profiles,id))throw new Error('Unknown project profile');return profiles[id as ProfileId];}
