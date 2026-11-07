Add Paper Workbench under Docs & Rendering. This PR adds one YAML entry only.

Paper Workbench provides a local PDF library, reading and annotations, automatic initial reading after import, separate Harness conversations for each paper, and a library assistant limited to metadata and saved shared summaries. AI uses the user's configured Harness model; automatic reading can be disabled. The prebuilt bundle supports Windows x64 and is verified with DSH 0.2.2-rc.1.

The entry points to the plugin subdirectory with its `dsh.bundle.patch` manifest. The tarball uses the fixed release asset `releases/latest/download/dsh-paper-workbench-windows-x64.tgz`; every stable release will retain that filename. The `v0.2.5` tag has matching package name/version in the plugin subdirectory. This follows dshmarket's native GitHub Release update contract; it does not install the root source package. The separate source archive includes pinned upstream source and is development material only.

PNG icon and curated screenshots are public; `screenshots.json` is beside the manifest. All screenshot papers and metadata are synthetic. No personal library, conversations or credentials are published.

Repository-age disclosure: created 2026-11-06 13:15:17 UTC; it reaches the 24-hour minimum at 2026-11-07 13:15:17 UTC. Please retain the normal submission gate and re-check after that time; this submission does not request an exception.

Release: https://github.com/Cluodwaters/dsh-paper-workbench/releases/tag/v0.2.5

Validation results are appended to the submitted PR after release verification. No generated READMEs or repository workflows are changed.
