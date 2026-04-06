---
'@qwik.dev/router': major
---

BREAKING: Route loader and route action results no longer put errors under `.value.failed`, but instead under `.error`. Route actions also no longer have `.isRunning` but instead have `.loading`. This makes the API more consistent.
