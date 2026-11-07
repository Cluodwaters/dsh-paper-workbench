Add Paper Workbench under Docs & Rendering. This PR adds one YAML entry only.

Paper Workbench provides a local PDF library, reading and annotations, automatic initial reading after import, separate Harness conversations for each paper, and a library assistant limited to metadata and saved shared summaries. AI uses the user's configured Harness model; automatic reading can be disabled. The prebuilt bundle supports Windows x64 and is verified with DSH 0.2.2-rc.1.

The entry points to the plugin subdirectory with its `dsh.bundle.patch` manifest. The tarball uses the fixed release asset `releases/latest/download/dsh-paper-workbench-windows-x64.tgz`; every stable release retains that filename. The v0.2.6 tag has matching package name/version in that subdirectory. This follows dshmarket's native GitHub Release update contract; it does not install the root source package. The source archive contains pinned upstream source and is development material only.

PNG icon and curated screenshots are public; `screenshots.json` is beside the manifest. Screenshot papers and metadata are synthetic. No personal library, conversations or credentials are published.

Validation completed for v0.2.6:

- 94 automated tests, complete published-resource hashing, and 11 browser integration checks from the actual tgz extracted outside the source checkout.
- Fixes Windows package locks by executing the backend, Node and native dependencies from verified copies outside node_modules. Partial or corrupt copies never activate; old and new runtime generations coexist.
- On Windows / DSH 0.2.2-rc.1 with pnpm's hoisted layout, the official plugin manager replaced a running 0.2.6 installation with an unpublished 0.2.7-qa.0 fixture while DSH and the old backend stayed alive. All 37 SQLite tables, synthetic PDF metadata, shared digest and session binding survived. Normal host restart then activated the new cache generation.
- The real 0.2.5 package migrated via the host's disable/install/enable APIs without closing DSH. Durable state survived migration and reopening the profile.
- Complete public installer downloaded (89,701,957 bytes); SHA-256 `12f56f7a8eb5153938f21d59a97c8199a607e83bd3fbc127a18f55ad3d724957` matches the local artifact, GitHub asset digest and checksum file.
- dshmarket 1.73.14 native checks using this proposed entry and isolated online-source profiles offer `0.2.5 → 0.2.6` at the correct pinned asset URL, and no duplicate update on 0.2.6. No private model calls or personal data are involved.

Scope: live replacement uses local tgz files via the official host API. Online source/version detection and published asset integrity are verified separately; this is not claimed as a completed public store UI update. Public store validation follows catalog merge/sync. Existing local-file installs must first adopt the matching online source to receive native store update checks.

Repository-age disclosure: created 2026-11-06 13:15:17 UTC; it reaches the 24-hour minimum at 2026-11-07 13:15:17 UTC. Please retain the normal submission gate and re-check after that time; this submission does not request an exception.

Release: https://github.com/Cluodwaters/dsh-paper-workbench/releases/tag/v0.2.6

No generated READMEs or repository workflows are changed.
