# Paper Workbench development boundaries

- This project is a local, single-user literature workbench. The original PDFs in the parent directory must not be modified. Tests operate on copied or derived fixtures.
- Keep domain/application/storage/reader-adapter/transport boundaries. No Zotero internals outside `src/web/zotero-reader-adapter.js` and `src/adapters/zotero/`.
- Preserve stable bibliographic IDs and attachment hashes. Display names, file paths and citation numbers are not identifiers.
- Never show a successful save before the store has acknowledged the transaction. Preserve optimistic concurrency and idempotent retries.
- Do not patch vendor source casually. Pin commits, retain licenses and run the relevant reader/export recovery checks before changing an upstream version.
- Use `npm test` for storage and source-processing changes; rerun relevant browser checks for reader changes and independent export verification for PDF writing changes.
- Do not commit personal PDFs, databases, generated exports, browser profiles, or local paths from sample manifests. They are excluded by `.gitignore`.
- Citation support uses structured bibliographic records, CSL formatting and a separate writing connector. Only update owned, versioned fields; preserve stale-preview protection and native undo transactions.
- Fulltext/OCR indexes are derived data. Preserve per-page checkpoints, source-hash verification and atomic replacement; never rewrite a managed PDF to add OCR text.
- Packaging must explicitly include the external backend production dependencies. Verify the installed runtime independently of the source checkout.
- Keep changes scoped to the user's requested phase; document unverified behavior instead of claiming support.
