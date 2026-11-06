/** Application contracts. No Zotero classes, DOM nodes or SQLite handles cross these boundaries. */
export interface BibliographicItem {
  id: string; // Stable application UUID; independent of path, DOI, title and citation numbering.
  schemaVersion: 1;
  csl: Record<string, unknown>; // CSL-JSON-compatible, structured author/date values; never a formatted reference string.
  metadataStatus: "unverified" | "reviewed";
}
export interface BibliographicMetadata {
  schemaVersion: 1;
  title: string;
  type:
    | "article-journal"
    | "paper-conference"
    | "thesis"
    | "book"
    | "chapter"
    | "report"
    | "article";
  authors: {
    literal?: string;
    family?: string;
    given?: string;
    orcid?: string;
    extra?: Record<string, unknown>;
  }[];
  year: number | null;
  printDate: string;
  onlineDate: string;
  journal: string;
  doi: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  abstract: string;
  url: string;
  tags: string[];
  readingStatus: "unread" | "reading" | "read";
  reviewStatus: "unverified" | "reviewed";
  favorite: boolean;
  extra: Record<string, unknown>;
}
export interface LibraryQuery {
  version: 1;
  scope?: "metadata" | "fulltext" | "all"; // Missing in older saved queries means metadata.
  text: string;
  authors: string[];
  authorMatch: "any" | "all";
  journals: string[];
  tags: string[];
  tagMatch: "any" | "all";
  year: { from: number | null; to: number | null; undatedOnly: boolean };
  readingStatuses: BibliographicMetadata["readingStatus"][];
  reviewStatuses: BibliographicMetadata["reviewStatus"][];
  needsMetadata: boolean;
  favoriteOnly: boolean;
  archived: boolean;
  sort: {
    field: "added" | "updated" | "year" | "title";
    direction: "asc" | "desc";
  };
}
export interface Attachment {
  id: string;
  itemId: string;
  sourceHash: string; // SHA-256 of the immutable managed copy, the target of all annotations.
  originalName: string;
  pages: number;
  sampleKey?: string;
}
export interface AnnotationSnapshot {
  attachmentId: string;
  sourceHash: string;
  revision: number;
  format: "zotero-pdf-v1"; // Versioned adapter payload; only the adapter interprets this representation.
  annotations: Record<string, unknown>[];
}
export interface AnnotationStore {
  snapshot(attachmentId: string): AnnotationSnapshot;
  apply(
    attachmentId: string,
    mutation: {
      requestId: string;
      expectedRevision: number;
      sourceHash: string;
      upserts: Record<string, unknown>[];
      deletions: string[];
    },
  ): { revision: number; requestId: string };
}
export interface ReaderAdapter {
  open(document: {
    attachment: Attachment;
    snapshot: AnnotationSnapshot;
    readingState: Record<string, unknown>;
    embeddedAnnotations?: Record<string, unknown>[];
  }): Promise<ReaderAdapter>;
  flush(): Promise<void>;
  getSaveState(): "saved" | "saving" | "failed" | "conflict";
  currentPage(): number;
  context(): {
    attachmentId: string;
    itemId: string;
    sourceHash: string;
    pageIndex: number;
    selection?: { text: string };
  };
  setTheme(theme: "light" | "dark"): void;
  goToPage(pageIndex: number): Promise<void>;
  close(): Promise<void>;
}
export interface PdfExportPort {
  export(
    attachmentId: string,
    expectedRevision: number,
  ): Promise<{
    id: string;
    revision: number;
    sha256: string;
    fileName: string;
  }>;
}
export interface FormattedRun {
  text: string;
  italic?: boolean;
  bold?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  smallCaps?: boolean;
}
/** Versioned portable marker stored in the writing document. */
export interface CitationCluster {
  version?: 1;
  id: string; // Stable marker in the writing document, not the displayed citation number.
  style?: string;
  items: {
    id: string;
    csl: Record<string, unknown>;
    locator?: string;
    label?: string;
    prefix?: string;
    suffix?: string;
  }[];
}
export interface CitationFormatter {
  format(
    styleId: string,
    clusters: CitationCluster[],
  ): {
    citations: Map<string, FormattedRun[]>;
    bibliography: FormattedRun[];
    bibliographyCount: number;
  };
}
export interface WritingConnector {
  call(
    action: "probe" | "snapshot" | "apply",
    input?: Record<string, unknown>,
  ): Promise<unknown>;
}
export interface PageText {
  pageIndex: number;
  nativeText: string;
  ocrText: string;
  confidence: number | null; // OCR engine estimate, not a measured accuracy percentage.
}
export interface FulltextHit {
  attachmentId: string;
  pageIndex: number;
  ocr: boolean;
  snippet: string;
}
export type IndexMode = "text" | "ocr" | "force-ocr";
export type IndexStatus =
  "queued" | "running" | "done" | "failed" | "cancelled";
