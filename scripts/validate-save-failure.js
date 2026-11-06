async (page) => {
  const doc = await page.evaluate(() =>
    window.workbench.documents.find((d) => d.sampleKey === "fixture-existing"),
  );
  await page.evaluate(async (id) => {
    await window.workbench.openDocument(id);
  }, doc.id);
  const initial = await page.evaluate(() => ({
    revision: window.workbench.adapter.persistence.revision,
    count: window.workbench.adapter.annotations().filter((x) => !x.isExternal)
      .length,
  }));
  await page.route("**/api/annotations/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "INJECTED_FAILURE", message: "模拟数据库服务不可用" },
      }),
    }),
  );
  const id = await page.evaluate(() => {
    const a = window.workbench.adapter;
    return a.reader._annotationManager.addAnnotation({
      type: "note",
      color: "#ff6666",
      pageLabel: "1",
      text: "",
      comment: "故障恢复验证：中文草稿不能静默丢失",
      tags: [],
      sortIndex: "00000|999999|00100",
      position: { pageIndex: 0, rects: [[40, 400, 62, 422]] },
    }).id;
  });
  await page.waitForFunction(
    () => Boolean(window.workbench.adapter.persistence.error),
    null,
    { timeout: 10000 },
  );
  const failed = await page.evaluate(async () => {
    const a = window.workbench.adapter;
    const server = await fetch(
      "/api/documents/" + a.document.attachment.id,
    ).then((r) => r.json());
    return {
      status: document.getElementById("save-status").dataset.state,
      revision: server.snapshot.revision,
      draftPersisted: localStorage.getItem(a.persistence.key) !== null,
      queueLength: a.persistence.queue.length,
    };
  });
  await page.screenshot({ path: "output/playwright/save-failure.png" });
  await page.unroute("**/api/annotations/*");
  await page.getByRole("button", { name: "重试保存" }).click();
  await page.evaluate(async () => {
    await window.workbench.adapter.flush();
  });
  const recovered = await page.evaluate(async (id) => {
    const a = window.workbench.adapter;
    const data = await fetch("/api/documents/" + a.document.attachment.id).then(
      (r) => r.json(),
    );
    return {
      revision: data.snapshot.revision,
      count: data.snapshot.annotations.filter((x) => x.id === id).length,
      comment: data.snapshot.annotations.find((x) => x.id === id)?.comment,
      draftRemoved: localStorage.getItem(a.persistence.key) === null,
    };
  }, id);
  await page.evaluate(async (id) => {
    const a = window.workbench.adapter;
    a.reader._annotationManager.deleteAnnotations([id]);
    await a.flush();
  }, id);
  const result = {
    initial,
    failed,
    recovered,
    temporaryAnnotationDeleted: true,
    passed:
      failed.status === "failed" &&
      failed.revision === initial.revision &&
      failed.draftPersisted &&
      recovered.count === 1 &&
      recovered.revision === initial.revision + 1 &&
      recovered.draftRemoved,
  };
  if (!result.passed) throw new Error(JSON.stringify(result));
  return result;
}
