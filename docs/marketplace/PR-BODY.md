Add Paper Workbench under Docs & Rendering. This PR adds one YAML entry only.

Paper Workbench provides a local PDF library, reading and annotations, automatic initial reading after import, separate Harness conversations for each paper, and a library assistant limited to metadata and saved shared summaries. AI uses the user's configured Harness model; automatic reading can be disabled. The prebuilt bundle supports Windows x64 and is verified with DSH 0.2.2-rc.1.

The entry points to the plugin subdirectory with its `dsh.bundle.patch` manifest. The tarball uses the fixed release asset `releases/latest/download/dsh-paper-workbench-windows-x64.tgz`; every stable release retains that filename. The v0.2.5 tag has matching package name/version in that subdirectory. This follows dshmarket's native GitHub Release update contract; it does not install the root source package. The source archive contains pinned upstream source and is development material only.

PNG icon and curated screenshots are public; `screenshots.json` is beside the manifest. Screenshot papers and metadata are synthetic. No personal library, conversations or credentials are published.

Validation completed:

- Independent packaged runtime outside the source checkout, bundle/production-dependency checks, and 11 browser integration checks.
- Full 89,621,321-byte Release installer downloaded in verified-size ranges and reassembled; SHA-256 matches the local package and published asset: `005061beecbe59e828a3e33a591e2d2aa4a87e1ae983aeb53dfdc692954eca77`.
- Official CLI upgrade in an isolated profile from the local v0.2.4 package to the downloaded v0.2.5 package. All 37 SQLite tables, the synthetic PDF hash, digest and session binding, two native conversation files and three settings files remained unchanged.
- dshmarket 1.73.14's unmodified source-matching/version-check functions, using this proposed entry and constructed online-source profiles with the actual old/new installed manifests: 0.2.4 offers 0.2.5 at the correct pinned release URL; 0.2.5 offers no duplicate update. Wrong repositories and unrelated local/versioned-name sources are rejected. Tested with the market's China region because direct raw.githubusercontent.com timed out here.

Scope: the persistence upgrade uses a locally downloaded artifact, while online source/version checks are separate. A slow direct CLI download was stopped; this is not claimed as a completed store UI end-to-end update or proof of public indexing. Public store verification follows catalog merge/sync.

Repository-age disclosure: created 2026-11-06 13:15:17 UTC; it reaches the 24-hour minimum at 2026-11-07 13:15:17 UTC. Please retain the normal submission gate and re-check after that time; this submission does not request an exception.

Release: https://github.com/Cluodwaters/dsh-paper-workbench/releases/tag/v0.2.5

No generated READMEs or repository workflows are changed.
