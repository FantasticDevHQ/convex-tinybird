# npm publishing and recovery

Verification runs on UbiCloud and must succeed before publishing. The owner approved
GitHub-hosted `ubuntu-24.04` for npm provenance build/publish; this is a publishing
exception, not a migration of ordinary CI. Keep OIDC, provenance, required gates
and timeout budgets intact. The publishing job rebuilds the verified immutable
tag, then publishes without lifecycle scripts rebuilding it again.

A GitHub release or a successful workflow with Publish skipped does not establish
npm publication. Check the exact public npm version and intended dist-tag first.
An existing version cannot be overwritten. If the workflow needed fixing, rerunning
an old run still uses its old workflow: dispatch Release from the corrected main
with `release_tag` set to the existing reviewed `vX.Y.Z` tag. The workflow checks
that tag against package metadata, runs the original verification commands, then
builds and publishes on the supported runner. Preserve existing tags, notes and
release assets; never mass-publish historical versions. Create a missing tag only
at an accepted release commit through the repository's reviewed release process.

After publication, download the exact registry tarball, verify integrity and
provenance source/workflow, and test its public interface in a clean consumer
without provider calls. Only then reconcile a recovered release PR's
`autorelease: pending` label to `autorelease: tagged`. Keep evidence in PR comments.

Release Please's default title parser does not recognize a ticket inserted before
`release` in its generated title. PR metadata still requires the owning ticket;
do not weaken either policy or replace generated release descriptions to work
around this. The durable generation/parser correction is tracked in BTS-388.
Until corrected, use the reviewed existing-tag recovery path when recognition
skips publishing, and verify the registry result separately.
