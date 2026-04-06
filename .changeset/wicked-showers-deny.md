---
'@qwik.dev/router': major
---

BREAKING: routeloader failures are no longer stored as `loaderSignal.value.failed` but instead are at `loaderSignal.error`. Reading `loaderSignal.value` will throw the error if the loader failed. This is in line with the AsyncSignal API.
