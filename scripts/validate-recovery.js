async (page) => {
  const documents = await page.evaluate(() =>
    window.workbench.documents.filter((d) =>
      window.recoveryKeys
        ? window.recoveryKeys.includes(d.sampleKey)
        : d.sampleKey.startsWith("sample-"),
    ),
  );
  const results = [];
  for (const doc of documents) {
    const result = { sampleKey: doc.sampleKey, attachmentId: doc.id };
    try {
      const saved = await page.evaluate(
        (id) => fetch("/api/documents/" + id).then((r) => r.json()),
        doc.id,
      );
      if (saved.error) throw new Error(saved.error.message);
      await page.evaluate(async (id) => {
        await window.workbench.openDocument(id);
        if (document.getElementById("save").disabled)
          throw new Error(document.getElementById("save-status").textContent);
      }, doc.id);
      const restored = await page.evaluate(() => {
        const a = window.workbench.adapter;
        return {
          annotations: a.annotations().filter((x) => !x.isExternal),
          revision: a.persistence.revision,
          pageIndex:
            a.reader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer
              .currentPageNumber - 1,
        };
      });
      const canonical = (list) =>
        JSON.stringify(
          list
            .map((a) => [
              a.id,
              a.type,
              a.position,
              a.color,
              a.text,
              a.comment,
              a.tags,
            ])
            .sort((a, b) => a[0].localeCompare(b[0])),
        );
      result.annotationsRestored =
        canonical(restored.annotations) ===
        canonical(saved.snapshot.annotations);
      result.annotationCount = restored.annotations.length;
      result.revisionPreserved = restored.revision === saved.snapshot.revision;
      result.readingPositionRestored =
        restored.pageIndex === saved.readingState.primary?.pageIndex;
      result.restoredPage = restored.pageIndex;
      result.renderedPages = [];
      for (const pageIndex of [
        ...new Set([0, Math.floor(doc.pages / 2), doc.pages - 1]),
      ]) {
        await page.evaluate(async (index) => {
          await window.workbench.adapter.reader.navigate({ pageIndex: index });
        }, pageIndex);
        await page.waitForFunction(
          (index) =>
            window.workbench.adapter.reader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(
              index,
            )?.renderingState === 3,
          pageIndex,
          { timeout: 45000 },
        );
        result.renderedPages.push(pageIndex);
      }
      await page.evaluate(async () => {
        await window.workbench.adapter.flush();
      });
      result.status =
        result.annotationsRestored &&
        result.revisionPreserved &&
        result.readingPositionRestored
          ? "passed"
          : "failed";
    } catch (error) {
      result.status = "failed";
      result.error = String(error);
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }
  return results;
}
