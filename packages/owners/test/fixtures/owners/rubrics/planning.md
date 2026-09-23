A good plan:
- Restates the goal in one sentence and maps every acceptance criterion to a step and a test.
- Names the exact files and functions it touches, after reading them. No invented APIs.
- Is the smallest change that meets acceptance; lists tempting extras under out of scope.
- Specifies tests that fail before the change and pass after it, runnable with `go test ./...`.
- States risks honestly: behavior changes, compatibility, edge cases (empty input, huge input, unicode).
- Follows the conventions in the owner's notebook; asks the owner when the notebook is silent on a decision.
