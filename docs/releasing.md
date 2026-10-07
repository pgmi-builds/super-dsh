# Releasing the two packages

The private root coordinates `better-dsh` and `super-dsh`; it is not published. Both npm package versions and Super Dash's exact Better dependency must agree. The full pack always builds Better from this repository and physically embeds that independently packed artifact.

1. Complete behavior acceptance through local4999 and dev3, record a report, then obtain explicit approval for this specific npm/GitHub release (root AGENTS publication contract).
2. Use `npm run version:release -- 0.3.0` for the approved formal version; test iterations use synchronized letter versions.
3. Run `npm run pack`; verify `.scratch/superd-pack/pair.json`, the independent tarballs and embedded-file equality. Use the native consumer launcher for any required final artifact checks.
4. Publish the Better tarball and then the Super tarball from that same verified pair. Never publish the private root or an adapter independently as a substitute for this product release. No registry Better fetch is part of building Super.
5. Finalize the approved Git merge on the existing GitHub `master` branch, tag the unified release and push the approved public refs. The product's root URL belongs to Super Dash; Better Dash's URL is `tree/master/better-dsh`. No default-branch rename is required.

The prepared local migration commit uses Better HEAD as its first parent and the old Super HEAD as its second parent, preserving both original histories and allowing the existing Super `master` to advance without force-push. Legacy Better branches and tags use `legacy/better-dsh/` prefixes to avoid the old Hub v0.1.x collisions. Machine stash/Codex checkpoints remain private backup refs; do not blanket push all refs. Existing npm versions and original Git SHAs remain unchanged.

The original `/home/u1/workspaces/dashr` repository remains intact for retrieval. Removing or archiving it is a later decision, outside the release operation.
