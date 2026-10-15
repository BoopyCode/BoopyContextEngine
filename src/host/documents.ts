import * as vscode from 'vscode';
import { DocumentSnapshot, OpenDocumentProvider } from '../core/io/documents';
import { normalizeRel, toPosix } from '../core/util/paths';

/**
 * Exposes unsaved editor buffers to the analysis layer.
 *
 * Only dirty documents are reported: a clean document is by definition identical to
 * the file on disk, so servicing it from disk keeps one code path and one source of
 * truth for hashes.
 */
export class VsCodeDocumentProvider implements OpenDocumentProvider {
  private readonly root: string;

  constructor(folder: vscode.WorkspaceFolder) {
    this.root = toPosix(folder.uri.fsPath).replace(/\/+$/, '');
  }

  get(relPath: string): DocumentSnapshot | undefined {
    const normalized = normalizeRel(relPath);
    for (const document of vscode.workspace.textDocuments) {
      const snapshot = this.toSnapshot(document);
      if (snapshot && snapshot.relPath === normalized) {
        return snapshot;
      }
    }
    return undefined;
  }

  dirtyDocuments(): DocumentSnapshot[] {
    const snapshots: DocumentSnapshot[] = [];
    for (const document of vscode.workspace.textDocuments) {
      const snapshot = this.toSnapshot(document);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  private toSnapshot(document: vscode.TextDocument): DocumentSnapshot | undefined {
    if (!document.isDirty || document.uri.scheme !== 'file') {
      return undefined;
    }
    const relPath = this.relative(document.uri);
    if (!relPath) {
      return undefined;
    }
    return { relPath, text: document.getText(), version: document.version, dirty: true };
  }

  private relative(uri: vscode.Uri): string | undefined {
    const absolute = toPosix(uri.fsPath);
    const root = this.root.toLowerCase();
    if (!absolute.toLowerCase().startsWith(`${root}/`)) {
      return undefined;
    }
    const relPath = normalizeRel(absolute.slice(this.root.length + 1));
    return relPath.length > 0 ? relPath : undefined;
  }
}
