# @fantastic-dev/convex-tinybird

A Convex component that delivers analytics events to [Tinybird](https://www.tinybird.co).
A host mutation enqueues an event in the same transaction as its own writes; the component
delivers it at least once and dedupes by the event's identity. Project-agnostic: it depends on
`convex` only (and `@convex-dev/workpool` for delivery), never on the host's schema or auth.

Design and conventions: [`docs/architecture.md`](./docs/architecture.md) (added with the isolation
gate ticket). The full consumer guide lands with the example app.
