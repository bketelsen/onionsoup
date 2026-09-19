#!/bin/sh
set -eu
# Source and modules stay read-only. Only compiled outputs and scratch are writable.
mkdir -p /scratch/cache /scratch/tmp
export GOCACHE=/scratch/cache GOTMPDIR=/scratch/tmp
cd /work
check_nonce="$1"
check() {
 id="$1"; shift
 set +e
 "$@"
 code=$?
 set -e
 printf '\n%s:%s:%s\n' "$check_nonce" "$id" "$code"
}
check go-build go build -o /scratch/clippy .
check go-test go test -count=1 -timeout=70s ./...
check go-vet go vet ./...
check gofmt /bin/sh -c 'test -z "$(gofmt -l /work/main.go)"'
# A host-owned overlay adds tests without modifying target source or original tests.
check bubble-default go test -overlay=/harness/overlay.json -count=1 -timeout=30s -run '^TestOnionsoupBubbleDefault$' .
check bubble-colors go test -overlay=/harness/overlay.json -count=1 -timeout=30s -run '^TestOnionsoupBubbleColors$' .
check bubble-invalid go test -overlay=/harness/overlay.json -count=1 -timeout=30s -run '^TestOnionsoupBubbleInvalid$' .
