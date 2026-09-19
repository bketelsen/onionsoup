# Task library fixture

This dependency-free library is used only for Onionsoup's isolated execution trials.
Import named functions directly from `tasks.mjs`.

`completedCount(tasks)` counts tasks whose `done` field is exactly boolean `true`.
`listTasks(tasks)` joins the names in input order with a newline; an empty array
returns an empty string. Valid inputs are arrays of objects with string names.

The base intentionally contains a completed-count defect and has no JSON export.
No dependencies, installation scripts, package entry points or migrations are needed.
