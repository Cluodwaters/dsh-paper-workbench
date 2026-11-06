async (page) => {
  const docs = await page.evaluate(() =>
    window.workbench.documents.filter((d) => d.sampleKey.startsWith("sample-")),
  );
  const results = [];
  for (const doc of docs) {
    await page.evaluate(async (id) => {
      await window.workbench.openDocument(id);
      if (document.getElementById("save").disabled)
        throw new Error(document.getElementById("save-status").textContent);
    }, doc.id);
    await page.evaluate(async (index) => {
      await window.workbench.adapter.reader.navigate({ pageIndex: index });
    }, doc.pages - 1);
    await page.waitForFunction(
      (index) =>
        window.workbench.adapter.reader._primaryView._iframeWindow
          .PDFViewerApplication.pdfViewer.currentPageNumber ===
        index + 1,
      doc.pages - 1,
      { timeout: 10000 },
    );
    const state = await page.evaluate(async () => {
      const a = window.workbench.adapter;
      await a.flush();
      return await fetch("/api/documents/" + a.document.attachment.id).then(
        (r) => r.json(),
      );
    });
    if (state.readingState.primary?.pageIndex !== doc.pages - 1)
      throw new Error(
        "Reading state was not durably saved for " + doc.sampleKey,
      );
    results.push({
      sampleKey: doc.sampleKey,
      pageIndex: state.readingState.primary.pageIndex,
      annotationCount: state.snapshot.annotations.length,
      revision: state.snapshot.revision,
    });
  }
  return results;
}
