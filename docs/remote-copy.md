# Binary copy with `remote_transfer`

```json
{"mode":"copy","src":"ssh:build:/srv/output","dst":"hub:review:/srv/review","verify":true,"mkdir":true}
```

Use `[target:]absolute/path`; an absolute path without a target is on the initiating runtime. The destination is the exact path, not an implicit parent directory. Files overwrite ordinary files; directories merge and keep unrelated destination entries. Register a BYO ssh identity with `remote {action:"add",ssh:{…}}` before using it in a copy. BYO-PTY is not a file transport.

CLI routes are native: `scp`, `docker cp`, `incus file push/pull` and `rsync` must exist on the origin, and rsync routes need `rsync` on the endpoints that execute it. No remote Python, Node, worker or helper is deployed for native routes; the Hub↔local staged lane uses the Hub's own binary file lane, and older Hub peers without it fail explicitly rather than falling back to a text/PTY carrier.

Copy first receives a complete binary carrier into an owned `.scratch/remote-copy-*` directory on the initiating runtime, then sends it to the destination. This is not delta transfer, resume, or direct remote-to-remote streaming. `mkdir` defaults to true and controls creation of destination parents.

`verify` defaults to true. The receipt contains independent source and destination SHA-256 manifest digests, bytes, entries, and `scope: "transferred entries"`. Unrelated destination entries are neither deleted nor included in verification. Symlinks are copied without following them, must resolve entirely through incoming tree members, and cannot act as extraction ancestors. Dangling links, cycles, or links requiring preserved destination entries are conservatively rejected. Existing destination symlinks and incompatible path types are rejected before any destination writes. Copy is not an atomic transaction across a whole directory.

Successful copies remove their owned origin staging, including when `verify:false` is selected. An unverified receipt never claims a hash match. Failures report the retained origin scratch path and reason for diagnosis; there is no automatic retry. Cancellation and failure close owned streams/processes and clean receiving temporary files. The retained origin payload does not retain a background transfer.
