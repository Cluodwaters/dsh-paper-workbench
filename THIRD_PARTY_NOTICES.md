# Third-party components

This personal validation project follows the GNU Affero General Public License v3 route. The complete text is in `LICENSE`. This is not an official Zotero distribution and uses its own application name.

- **Zotero Reader** and **Zotero Document Worker**: Corporation for Digital Scholarship; AGPLv3. Their `COPYING` files remain in the corresponding `third_party` directories.
- **PDF.js** and its Zotero forks: Mozilla / contributors; Apache License 2.0. License files remain in the source and staged viewer assets.
- **PDFAssembler**: MIT copyright notice is retained in the upstream source file.
- React, EPUB.js, Fluent, font assets and other transitive build/runtime components retain their original upstream licenses. The exact dependency trees are recorded by the upstream lock files; `sources.lock.json` identifies the source commits.
- Names such as Zotero, Microsoft and EndNote identify reference products or components; no endorsement or trademark license is implied.
- **Electron 45.1.0**: Electron contributors, MIT; Chromium notices ship with the runtime. **Node.js 25.8.1**: Node.js contributors; bundled licenses are in `resources/licenses/node.txt` and the runtime folder.
- **Tesseract.js 7.0.0 / Tesseract.js-core** and **tessdata_fast** English / Simplified Chinese models: Apache-2.0. Models run offline. Pinned commits and hashes are in `phase3-assets.lock.json`; model license is in `resources/licenses/tessdata-fast.txt`.
- **citeproc-js 2.4.63**: Frank Bennett and contributors; the AGPL-3.0 option is used. **CSL styles and locales**: Citation Style Language contributors, CC-BY-SA-3.0; styles retain author and license declarations, and locale attribution is in `resources/licenses/csl-locales.txt`.
- **@napi-rs/canvas 1.1.0**: MIT with upstream Skia notices; **he 1.2.0**: MIT. Production package licenses and SBOM files are retained.
- The bridge's QUOTE-to-ADDIN initialization technique follows [Zotero Word for Windows Integration](https://github.com/zotero/zotero-word-for-windows-integration), `document.cpp` / `insertFieldRaw` (AGPL-3.0-or-later). Our own field names and protocol are used; Zotero's Word binary/template is not bundled.

If redistributing the application later, include complete applicable license notices and corresponding source/build material as required by the licenses. Personal papers and test PDFs are not part of the software distribution.
