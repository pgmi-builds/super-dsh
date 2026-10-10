# Binary copy with `remote`

```json
{"action":"copy","src":"ssh:build:/srv/output","dst":"hub:review:/srv/review","verify":true,"mkdir":true}
```

Use `[target:]absolute/path`; an absolute path without a target is on the initiating runtime. The destination is the exact path, not an implicit parent directory. Files overwrite ordinary files; directories merge and keep unrelated destination entries. Register a `byossh` identity separately before using it in a copy. BYO-PTY is not a file transport.

Local and Hub endpoints use Node directly. SSH/byossh, Docker and Incus endpoints require **Python 3 already available as `python3` on that peer**. A missing interpreter fails before destination writes. Install it separately through your normal administration process, or choose a Hub endpoint; copy never installs helpers, changes profiles, or falls back to a text/PTY carrier. Older Hub peers without the binary endpoint must be upgraded; they fail explicitly.

Copy first receives a complete binary carrier into an owned `.scratch/remote-copy-*` directory on the initiating runtime, then sends it to the destination. This is not delta transfer, resume, or direct remote-to-remote streaming. `mkdir` defaults to true and controls creation of destination parents.

`verify` defaults to true. The receipt contains independent source and destination SHA-256 manifest digests, bytes, entries, and `scope: "transferred entries"`. Unrelated destination entries are neither deleted nor included in verification. Symlinks are copied without following them, must resolve entirely through incoming tree members, and cannot act as extraction ancestors. Dangling links, cycles, or links requiring preserved destination entries are conservatively rejected. Existing destination symlinks and incompatible path types are rejected before any destination writes. Copy is not an atomic transaction across a whole directory.

Successful copies remove their owned origin staging, including when `verify:false` is selected. An unverified receipt never claims a hash match. Failures report the retained origin scratch path and reason for diagnosis; there is no automatic retry. Cancellation and failure close owned streams/processes and clean receiving temporary files. The retained origin payload does not retain a background transfer.
