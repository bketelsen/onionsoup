A good implementation:
- Does what the approved plan says, in the files it names. Deviations are listed with the reason.
- Adds or changes the tests the plan calls for, and runs `go build ./...`, `go vet ./...`, `go test ./...`.
- Matches the surrounding code: gofmt, naming, error handling, comment density.
- Changes no unrelated code, no formatting churn, no new dependencies unless the plan says so.
- Leaves no debugging output, temporary files or generated images in the tree.
