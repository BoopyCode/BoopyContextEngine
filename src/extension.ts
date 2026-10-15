import * as vscode from 'vscode';
import { BceLogger, BceStatusBar } from './host/ui';
import { SessionManager } from './host/session';
import { registerCommands } from './host/commands';
import { registerLanguageModelTools } from './host/tools';

let sessions: SessionManager | undefined;
let logger: BceLogger | undefined;

/**
 * Activation entry point.
 *
 * BCE never replaces Copilot: it only registers local language model tools plus a
 * few commands, and keeps its own index up to date in the background.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = new BceLogger();
  logger = output;
  context.subscriptions.push(output);

  const statusBar = new BceStatusBar();
  context.subscriptions.push(statusBar);

  const manager = new SessionManager(context, output, statusBar);
  sessions = manager;
  context.subscriptions.push(manager);

  output.log('info', `Boopy Context Engine starting (VS Code ${vscode.version}).`);

  try {
    await manager.refreshFolders();
  } catch (error) {
    output.log('error', `Workspace initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  registerCommands(context, manager, output);

  const lm = vscode.lm as typeof vscode.lm | undefined;
  if (lm && typeof lm.registerTool === 'function') {
    registerLanguageModelTools(context, manager, output);
  } else {
    output.log(
      'warn',
      'The Language Model Tool API is not available in this VS Code version. BCE indexing and commands still work, but the bce_* tools cannot be offered to Copilot Agent mode (requires VS Code 1.99 or newer).'
    );
    void vscode.window.showWarningMessage(
      'Boopy Context Engine: this VS Code version is too old for language model tools. Indexing and commands work, but the bce_* tools will not appear in Copilot.'
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await manager.refreshFolders();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('bce')) {
        return;
      }
      for (const session of manager.all()) {
        const { signatureChanged } = await session.updateConfig();
        if (signatureChanged) {
          output.log('info', `${session.rootName}: indexing settings changed, rebuilding the index.`);
          // Wait for any background pass to finish before re-scanning, otherwise the
          // rebuild would be dropped and the settings would only apply on the next
          // file change.
          await session.indexer.waitForIdle(60000);
          await session.indexer.fullIndex();
        }
      }
      output.log('info', 'Configuration reloaded.');
    }),
    vscode.workspace.onDidGrantWorkspaceTrust?.(async () => {
      for (const session of manager.all()) {
        await session.updateConfig();
      }
      output.log('info', 'Workspace trust was granted; BCE settings were re-applied.');
    }) ?? { dispose: () => undefined }
  );
}

export function deactivate(): void {
  logger?.log('info', 'Boopy Context Engine stopping.');
  sessions?.dispose();
  sessions = undefined;
}
