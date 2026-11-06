import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireValue } from "../domain/errors.mjs";

export class IndexService {
  constructor({ store, projectRoot, dataRoot }) {
    Object.assign(this, { store, projectRoot, dataRoot });
    this.repository = store.fulltext;
    this.repository.recover();
    this.paused =
      store.db
        .prepare("SELECT value FROM library_settings WHERE key='index_paused'")
        .get()?.value === "1";
    this.active = null;
    this.stopping = false;
  }
  enqueueMissing() {
    for (const row of this.store.db
      .prepare(
        "SELECT a.id FROM attachments a JOIN item_metadata m ON m.item_id=a.item_id WHERE m.archived_at IS NULL",
      )
      .all())
      this.repository.enqueue(row.id, "text", { onlyMissing: true });
    this.pump();
  }
  enqueue(ids, mode) {
    requireValue(
      Array.isArray(ids) && ids.length <= 2000,
      "INDEX_IDS",
      "单次最多处理 2000 个附件。",
    );
    const jobs = ids.map((id) => this.repository.enqueue(id, mode));
    this.pump();
    return jobs;
  }
  setPaused(paused) {
    this.paused = Boolean(paused);
    this.store.db
      .prepare(
        "INSERT OR REPLACE INTO library_settings VALUES('index_paused',?)",
      )
      .run(this.paused ? "1" : "0");
    if (this.paused && this.active) {
      if (this.repository.job(this.active.id).status === "running")
        this.repository.mark(this.active.id, "queued");
      this.active.process.kill();
    } else this.pump();
    return { paused: this.paused };
  }
  cancel(id) {
    const job = this.repository.job(id);
    requireValue(
      ["running", "queued"].includes(job.status),
      "JOB_FINISHED",
      "任务已经结束。",
      409,
    );
    this.repository.mark(id, "cancelled");
    if (this.active?.id === id) this.active.process.kill();
    return { cancelled: id };
  }
  retry(id) {
    const job = this.repository.job(id);
    requireValue(
      ["failed", "cancelled"].includes(job.status),
      "JOB_ACTIVE",
      "任务尚未结束。",
      409,
    );
    // Retry the same durable page checkpoints, rather than starting the PDF again.
    requireValue(
      !this.store.db
        .prepare(
          "SELECT 1 FROM text_jobs WHERE attachment_id=? AND status IN ('running','queued')",
        )
        .get(job.attachment_id),
      "JOB_ACTIVE",
      "此附件已有任务。",
      409,
    );
    this.repository.mark(id, "queued");
    this.pump();
    return this.repository.job(id);
  }
  status() {
    return {
      ...this.repository.status(),
      paused: this.paused,
      progress: this.active?.progress || null,
    };
  }
  pump() {
    if (this.stopping || this.paused || this.active) return;
    const job = this.repository.next();
    if (!job) return;
    const attachment = this.store.attachment(job.attachment_id);
    this.repository.mark(job.id, "running");
    const child = fork(
      fileURLToPath(
        new URL("../adapters/zotero/index-worker.mjs", import.meta.url),
      ),
      [],
      {
        cwd: this.projectRoot,
        windowsHide: true,
        execArgv: ["--max-old-space-size=768"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const active = (this.active = {
      id: job.id,
      process: child,
      progress: { page: 0, status: "正在读取 PDF" },
    });
    let stderr = "",
      finished = false;
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-3000);
    });
    const resetTimeout = () => {
      clearTimeout(active.timeout);
      active.timeout = setTimeout(() => {
        if (!finished) {
          this.repository.mark(
            job.id,
            "failed",
            "单页处理超过 3 分钟，可重试已保存的进度。",
          );
          finished = true;
          child.kill();
        }
      }, 180000);
    };
    resetTimeout();
    child.on("message", (message) => {
      if (this.stopping || this.repository.job(job.id).status !== "running")
        return;
      try {
        if (message.type === "page") {
          this.repository.savePage(job.id, message.page);
          resetTimeout();
          active.progress = {
            page: message.page.pageIndex + 1,
            status: "页面已保存",
          };
          child.send({ type: "ack" });
        } else if (message.type === "progress") {
          active.progress = message.progress;
        } else if (message.type === "done") {
          this.repository.finish(job.id, message.pages);
          finished = true;
        } else if (message.type === "error") {
          this.repository.mark(job.id, "failed", message.message);
          finished = true;
        }
      } catch (error) {
        this.repository.mark(job.id, "failed", error.message);
        finished = true;
        child.kill();
      }
    });
    child.on("error", (error) => {
      if (
        !finished &&
        !this.stopping &&
        this.repository.job(job.id).status === "running"
      ) {
        this.repository.mark(job.id, "failed", error.message);
        finished = true;
      }
    });
    child.on("exit", () => {
      clearTimeout(active.timeout);
      if (!finished && this.repository.job(job.id).status === "running")
        this.repository.mark(
          job.id,
          "failed",
          "处理进程中断，已保存页面可重试。" + stderr.slice(-250),
        );
      if (this.active === active) this.active = null;
      if (!this.stopping) setImmediate(() => this.pump());
    });
    child.send({
      type: "start",
      job,
      attachment,
      dataRoot: this.dataRoot,
      projectRoot: this.projectRoot,
      completed: this.repository.staged(job.id),
      previous: this.repository.pages(attachment.id),
    });
  }
  async close() {
    this.stopping = true;
    const active = this.active;
    if (active) {
      clearTimeout(active.timeout);
      if (this.repository.job(active.id).status === "running")
        this.repository.mark(active.id, "queued");
      await new Promise((resolve) => {
        active.process.once("exit", resolve);
        active.process.kill();
      });
    }
  }
}
