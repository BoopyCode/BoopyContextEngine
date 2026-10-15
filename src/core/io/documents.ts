/**
 * Access to the *editor* state, not just the disk state.
 *
 * A file that is open in the editor and has unsaved changes (a "dirty" buffer) has
 * content that does not exist on disk yet. Reading only from disk would hand the
 * agent stale code, so the reads that feed tool output go through this provider
 * first. The persisted index keeps using disk content, because file hashes must
 * stay comparable with the working tree.
 */

export interface DocumentSnapshot {
  /** Workspace-relative POSIX path. */
  relPath: string;
  text: string;
  /** Editor buffer version; increases on every edit of that document. */
  version: number;
  /** True when the buffer has unsaved changes. */
  dirty: boolean;
}

export interface OpenDocumentProvider {
  /** Returns the open buffer for a workspace-relative path, if one exists. */
  get(relPath: string): DocumentSnapshot | undefined;
  /** Every open buffer with unsaved changes; used for context cache fingerprints. */
  dirtyDocuments(): DocumentSnapshot[];
}

export const noOpenDocuments: OpenDocumentProvider = {
  get: () => undefined,
  dirtyDocuments: () => []
};
