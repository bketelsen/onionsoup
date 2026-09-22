# Charter: clippy

DRAFT written by Claude for the spike. The human owner should rewrite this.

## Domain

`github.com/bketelsen/clippy`: a small Go command-line tool that renders text into a
Clippy speech bubble and writes a PNG. Released with GoReleaser; CI runs tests.

## Goals

- It does one thing well: good-looking images from any reasonable text, predictable flags.
- It stays small, dependency-light and easy to build with `go build`.
- Behavior users rely on is covered by tests.

## Boundaries

- No network access, telemetry or new runtime services.
- No new third-party dependencies without a strong reason recorded in decisions.
- Existing flags and default output keep working; changes to them need a decision.
- Release and CI configuration change only when a work item is about them.
