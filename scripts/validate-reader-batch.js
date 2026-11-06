async (page) => {
  // Run with playwright-cli run-code --filename after a fresh UI snapshot.
  const range = await page.evaluate(
    () => window.validationRange || { from: 1, to: 10 },
  );
  const docs = await page.evaluate(
    ({ from, to, keys }) =>
      window.workbench.documents.filter((d) => {
        if (keys) return keys.includes(d.sampleKey);
        const number = Number(d.sampleKey.replace("sample-", ""));
        return (
          d.sampleKey.startsWith("sample-") && number >= from && number <= to
        );
      }),
    range,
  );
  const results = [];
  for (const doc of docs) {
    const start = Date.now();
    const result = {
      sampleKey: doc.sampleKey,
      attachmentId: doc.id,
      expectedPages: doc.pages,
    };
    try {
      await page.evaluate(async (id) => {
        await window.workbench.openDocument(id);
        if (document.getElementById("save").disabled)
          throw new Error(document.getElementById("save-status").textContent);
      }, doc.id);
      await page.evaluate(async () => {
        await window.workbench.adapter.reader.navigate({ pageIndex: 0 });
      });
      await page.waitForFunction(
        () =>
          window.workbench.adapter.reader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(
            0,
          )?.renderingState === 3,
        null,
        { timeout: 45000 },
      );
      result.firstPageMs = Date.now() - start;
      const created = await page.evaluate(async () => {
        const a = window.workbench.adapter;
        const application =
          a.reader._primaryView._iframeWindow.PDFViewerApplication;
        const [x0, y0, x1, y1] =
          application.pdfViewer.getPageView(0).viewport.viewBox;
        const w = x1 - x0,
          h = y1 - y0;
        const comment =
          "阶段1验证 " +
          a.document.attachment.sampleKey +
          "：中文批注 α β 2026";
        const rect = (left, top, width, height) => [
          x0 + w * left,
          y0 + h * (1 - top - height),
          x0 + w * (left + width),
          y0 + h * (1 - top),
        ];
        let specs = [
          {
            type: "highlight",
            position: { pageIndex: 0, rects: [rect(0.16, 0.24, 0.35, 0.018)] },
            text: "Phase 1 highlight fixture",
            color: "#ffd400",
            comment,
          },
          {
            type: "underline",
            position: { pageIndex: 0, rects: [rect(0.16, 0.29, 0.35, 0.018)] },
            text: "Phase 1 underline fixture",
            color: "#2ea8e5",
            comment,
          },
          {
            type: "note",
            position: { pageIndex: 0, rects: [rect(0.84, 0.32, 0.035, 0.025)] },
            text: "",
            color: "#a28ae5",
            comment,
          },
        ];
        if (a.document.attachment.sampleKey === "fixture-scanned")
          specs = [
            {
              type: "image",
              position: { pageIndex: 0, rects: [rect(0.16, 0.24, 0.35, 0.08)] },
              text: "",
              color: "#ffd400",
              comment,
            },
            specs[2],
          ];
        const list = specs.map((item, index) =>
          a.reader._annotationManager.addAnnotation({
            ...item,
            pageLabel: "1",
            tags: [],
            sortIndex: "00000|00000" + index + "|00200",
          }),
        );
        await a.flush();
        const saved = await fetch(
          "/api/documents/" + a.document.attachment.id,
        ).then((r) => r.json());
        const canonical = (item) =>
          JSON.stringify([
            item.id,
            item.type,
            item.position,
            item.color,
            item.text,
            item.comment,
          ]);
        if (
          !list.every((item) =>
            saved.snapshot.annotations.some(
              (s) => canonical(s) === canonical(item),
            ),
          )
        )
          throw new Error("Saved annotation differs from reader state");
        return {
          ids: list.map((item) => item.id),
          revision: saved.snapshot.revision,
          actualPages: application.pdfDocument.numPages,
        };
      });
      result.annotations = created;
      if (created.actualPages !== doc.pages)
        throw new Error("Page count mismatch");
      const pageIndexes = [
        ...new Set([0, Math.floor(doc.pages / 2), doc.pages - 1]),
      ];
      result.renderedPages = [];
      for (const pageIndex of pageIndexes) {
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
      const readingState = await page.evaluate(async () => {
        const a = window.workbench.adapter;
        await a.flush();
        return (
          await fetch("/api/documents/" + a.document.attachment.id).then((r) =>
            r.json(),
          )
        ).readingState;
      });
      if (readingState.primary?.pageIndex !== doc.pages - 1)
        throw new Error("Reading location was not durably saved");
      result.readingPositionSaved = doc.pages - 1;
      result.export = await page.evaluate(async () => {
        const a = window.workbench.adapter;
        await a.flush();
        const response = await fetch(
          "/api/export/" + a.document.attachment.id,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Paper-Workbench": "1",
            },
            body: JSON.stringify({ expectedRevision: a.persistence.revision }),
          },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error.message);
        return body;
      });
      result.status = "passed";
    } catch (error) {
      result.status = "failed";
      result.error = String(error);
    }
    result.totalMs = Date.now() - start;
    results.push(result);
    console.log(JSON.stringify(result));
  }
  return results;
}
