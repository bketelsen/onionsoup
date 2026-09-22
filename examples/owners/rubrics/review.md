Review for:
- Correctness first: does the change meet every acceptance criterion? Look for edge cases the tests miss.
- Tests that would fail if the behavior regressed, not tests that restate the implementation.
- Scope: anything outside the plan is a finding.
- Compatibility of existing flags and output, per the charter's boundaries.
- Readability and consistency with the codebase.
Severity: blocker (wrong or unsafe), major (should fix before landing), minor, nit.
Approve only when there are no blockers or majors. Choose replan only when the plan itself is wrong.
