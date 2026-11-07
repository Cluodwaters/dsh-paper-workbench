Add Paper Workbench under Docs & Rendering.

The plugin provides a local PDF library, reading and annotations, automatic initial reading after import, separate Harness conversations for each paper, and a library assistant limited to metadata and saved shared summaries. This release supports Windows x64 and has been verified with DSH 0.2.2-rc.1. AI features use the user's configured Harness model; automatic reading can be disabled.

The entry points to the plugin subdirectory with its `dsh.bundle` manifest and pins the complete prebuilt v0.2.4 GitHub Release tarball. The source archive is development material and is not the installation source. Curated screenshots live beside the plugin manifest in `screenshots.json` and use only synthetic demonstration documents.

Validation: clean-profile installation of the release tarball (local SHA-256 matches the GitHub asset digest), independent packaged runtime verification, and browser integration checks. No unrelated catalog entries or generated READMEs are changed.
