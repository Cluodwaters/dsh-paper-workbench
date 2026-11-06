import { appUrl } from "./url.js";

export async function api(url, data, { timeoutMs = 30000, signal } = {}) {
  const options =
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Paper-Workbench": "1",
          },
          body: JSON.stringify(data),
        };
  const response = await fetch(appUrl(url), {
    ...options,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message || "Request failed");
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

/** Durable pending mutations + ordered delivery. UI never calls SQLite or interprets adapter data. */
export class PersistenceClient {
  constructor(snapshot, onStatus) {
    this.attachmentId = snapshot.attachmentId;
    this.sourceHash = snapshot.sourceHash;
    this.revision = snapshot.revision;
    this.onStatus = onStatus;
    this.key = `paper-workbench:draft:v1:${this.attachmentId}`;
    this.queue = [];
    this.running = false;
    this.error = null;
    const saved = localStorage.getItem(this.key);
    if (saved) {
      const draft = JSON.parse(saved);
      if (draft.sourceHash !== this.sourceHash)
        throw new Error("本地草稿对应的 PDF 版本不同，请先保留草稿。");
      this.queue = draft.queue;
    }
  }
  overlay(annotations) {
    const map = new Map(annotations.map((item) => [item.id, item]));
    for (const task of this.queue) {
      for (const id of task.mutation.deletions) map.delete(id);
      for (const item of task.mutation.upserts)
        map.set(item.id, { ...map.get(item.id), ...item });
    }
    return [...map.values()];
  }
  journal() {
    if (this.queue.length)
      localStorage.setItem(
        this.key,
        JSON.stringify({
          schemaVersion: 1,
          sourceHash: this.sourceHash,
          queue: this.queue.map(({ mutation }) => ({ mutation })),
        }),
      );
    else localStorage.removeItem(this.key);
  }
  enqueue(upserts, deletions) {
    if (this.discarded) return Promise.resolve();
    if (!upserts.length && !deletions.length) return Promise.resolve();
    return new Promise((resolve) => {
      const mutation = {
        requestId: crypto.randomUUID(),
        expectedRevision: null,
        sourceHash: this.sourceHash,
        upserts: structuredClone(upserts),
        deletions: [...deletions],
      };
      this.queue.push({ mutation, resolve });
      try {
        this.journal();
      } catch (error) {
        this.error = error;
        this.onStatus("failed", "草稿保存失败：" + error.message);
        return;
      }
      this.pump();
    });
  }
  async pump() {
    if (this.running || this.error || this.discarded) return;
    this.running = true;
    while (this.queue.length) {
      const task = this.queue[0];
      if (task.mutation.expectedRevision === null)
        task.mutation.expectedRevision = this.revision;
      this.onStatus("saving", "正在写入本地数据库…");
      try {
        this.journal();
        this.controller = new AbortController();
        const receipt = await api(
          `/api/annotations/${this.attachmentId}`,
          task.mutation,
          { signal: this.controller.signal, timeoutMs: 10000 },
        );
        if (this.discarded) break;
        this.revision = Math.max(this.revision, receipt.revision);
        this.queue.shift();
        this.journal();
        task.resolve?.();
      } catch (error) {
        if (this.discarded) break;
        this.error = error;
        this.onStatus(
          error.code === "REVISION_CONFLICT" ? "conflict" : "failed",
          "未保存到数据库：" + error.message,
        );
        break;
      }
    }
    this.running = false;
    if (!this.discarded && !this.error && !this.queue.length)
      this.onStatus("saved", `已落盘 · 修订 ${this.revision}`);
  }
  discard() {
    // A different window may have written this attachment's journal. Never
    // delete that window's data when abandoning only this window's edits.
    const ownJournal = JSON.stringify({
      schemaVersion: 1,
      sourceHash: this.sourceHash,
      queue: this.queue.map(({ mutation }) => ({ mutation })),
    });
    if (localStorage.getItem(this.key) === ownJournal)
      localStorage.removeItem(this.key);
    this.discarded = true;
    this.controller?.abort();
    for (const task of this.queue) task.resolve?.();
    this.queue = [];
    this.error = null;
  }
  retry() {
    this.error = null;
    return this.pump();
  }
  async flush() {
    await this.pump();
    const deadline = Date.now() + 15000;
    while (this.running || this.queue.length) {
      if (this.error) throw this.error;
      if (Date.now() > deadline)
        throw new Error("保存尚未完成，请保持窗口打开并重试。");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    if (this.error) throw this.error;
  }
}
