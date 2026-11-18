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
    this.prefix = `paper-workbench:draft:v2:${this.attachmentId}:`;
    this.key = this.prefix + crypto.randomUUID();
    this.locks = new Map();
    this.queue = [];
    this.running = false;
    this.error = null;
  }
  async hold(key) {
    // Secure localhost in Chromium provides Web Locks. Page destruction releases
    // the lock even on a crash. Only its holder can rewrite a recovered journal.
    const manager = globalThis.navigator?.locks;
    if (!manager) return key === this.key;
    return new Promise((resolve, reject) => {
      manager.request(key, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return; }
        return new Promise((release) => {
          this.locks.set(key, release);
          resolve(true);
        });
      }).catch(reject);
    });
  }
  async recover() {
    await this.hold(this.key);
    const keys = [`paper-workbench:draft:v1:${this.attachmentId}`];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix) && key !== this.key) keys.push(key);
    }
    for (const key of keys) {
      if (!localStorage.getItem(key)) continue;
      if (!globalThis.navigator?.locks) throw new Error("当前浏览器无法锁定恢复草稿，请通过本机 DSH 或桌面工作台打开。");
      if (!await this.hold(key)) continue;
      const saved = localStorage.getItem(key);
      if (!saved) continue;
      const draft = JSON.parse(saved);
      if (draft.sourceHash !== this.sourceHash)
        throw new Error("本地草稿对应的 PDF 版本不同，请先保留草稿。");
      for (const { mutation } of draft.queue) this.queue.push({ mutation, key });
    }
  }
  release() {
    for (const release of this.locks.values()) release();
    this.locks.clear();
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
  journal(key = this.key, tasks = this.queue) {
    const queue = tasks.filter((task) => task.key === key);
    if (queue.length)
      localStorage.setItem(
        key,
        JSON.stringify({
          schemaVersion: 1,
          sourceHash: this.sourceHash,
          queue: queue.map(({ mutation }) => ({ mutation })),
        }),
      );
    else localStorage.removeItem(key);
  }
  enqueue(upserts, deletions) {
    if (this.discarded) return Promise.resolve();
    if (!upserts.length && !deletions.length) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = this.queue.at(-1)?.mutation;
      const mutation = {
        requestId: crypto.randomUUID(),
        expectedRevision: previous ? (previous.expectedRevision ?? this.revision) + 1 : this.revision,
        sourceHash: this.sourceHash,
        upserts: structuredClone(upserts),
        deletions: [...deletions],
      };
      this.queue.push({ mutation, resolve, key: this.key });
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
        this.journal(task.key);
        this.controller = new AbortController();
        const receipt = await api(
          `/api/annotations/${this.attachmentId}`,
          task.mutation,
          { signal: this.controller.signal, timeoutMs: 10000 },
        );
        if (this.discarded) break;
        this.revision = Math.max(this.revision, receipt.revision);
        this.journal(task.key, this.queue.slice(1));
        this.queue.shift();
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
    for (const key of new Set(this.queue.map((task) => task.key))) {
      const ownJournal = JSON.stringify({
        schemaVersion: 1,
        sourceHash: this.sourceHash,
        queue: this.queue.filter((task) => task.key === key).map(({ mutation }) => ({ mutation })),
      });
      if (localStorage.getItem(key) === ownJournal) localStorage.removeItem(key);
    }
    this.release();
    this.discarded = true;
    this.controller?.abort();
    for (const task of this.queue) task.resolve?.();
    this.queue = [];
    this.error = null;
  }
  async mergeConflict(snapshot) {
    if (this.error?.code !== "REVISION_CONFLICT" || !this.queue.length) return;
    if (snapshot.attachmentId !== this.attachmentId || snapshot.sourceHash !== this.sourceHash)
      throw new Error("论文版本已变化，请先导出本地标注草稿。");
    const task = this.queue[0];
    // A conflict receipt confirms this request was never committed. All other
    // pending requests retain their IDs for idempotent replay.
    let revision = snapshot.revision;
    for (const pending of this.queue.filter(entry => entry.key === task.key)) {
      pending.mutation = { ...pending.mutation, expectedRevision: revision++ };
    }
    task.mutation.requestId = crypto.randomUUID();
    this.journal(task.key);
    this.revision = snapshot.revision;
    await this.retry();
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
