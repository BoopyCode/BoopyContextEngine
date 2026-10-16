import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { SessionManager } from '../src/host/session';
import { BceLogger, BceStatusBar } from '../src/host/ui';
import { registerCommands } from '../src/host/commands';
import { registerLanguageModelTools } from '../src/host/tools';
import { createTempDir, createTempProject } from './support/tempProject';
import { __mock } from './mocks/vscode';
import { renderDiagnosticsBody, renderDiagnosticsHtml } from '../src/host/commands';

let project: { dir: string; cleanup(): Promise<void> };
let storage: { dir: string; cleanup(): Promise<void> };
let context: { subscriptions: { dispose(): void }[]; storageUri: vscode.Uri; globalStorageUri: vscode.Uri };

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the condition');
}

beforeEach(async () => {
  __mock.state.reset();
  project = await createTempProject('bce-ext');
  storage = await createTempDir('bce-ext-storage');
  context = {
    subscriptions: [],
    storageUri: vscode.Uri.file(storage.dir),
    globalStorageUri: vscode.Uri.file(storage.dir)
  };
  __mock.setWorkspaceFolders([project.dir]);
});

afterEach(async () => {
  // Activation starts a background index. Removing the storage while a writer is still
  // running lets it recreate the directory after cleanup, so wait for the index first and
  // dispose the activation subscriptions the way VS Code does on deactivate; without that,
  // a configuration change in a later test would still reach the closed sessions.
  await waitForIdleIndexer();
  deactivate();
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
  context.subscriptions.length = 0;
  await project.cleanup();
  await storage.cleanup();
});

async function waitForIdleIndexer(): Promise<void> {
  if (!__mock.state.tools.has('bce_get_status')) {
    return;
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let text: string;
    try {
      const status = (await __mock.invokeTool('bce_get_status', { verbose: true })) as { content: { value: string }[] };
      text = status.content[0].value;
    } catch {
      // The manager a previous test registered may already be disposed; nothing to wait for.
      return;
    }
    if (text.includes('indexing: false')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('extension activation', () => {
  it('ships contributed instructions that point at a real file with usable frontmatter', async () => {
    // Contributed instructions are not loaded by the extension host, so nothing in
    // src/ would notice a typo in the path or a missing file: the extension keeps
    // working and the agent simply never learns that BCE exists. This is the guard.
    const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes?: { chatInstructions?: { path?: string }[] };
      version?: string;
    };
    const entries = manifest.contributes?.chatInstructions ?? [];
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(typeof entry.path).toBe('string');
      const relPath = (entry.path as string).replace(/^\.\//, '');
      const absolute = path.join(__dirname, '..', ...relPath.split('/'));
      const content = await fs.readFile(absolute, 'utf8');

      // Frontmatter, because `name` and `description` belong in the file and the
      // description is what makes the instructions discoverable on demand.
      expect(content.startsWith('---')).toBe(true);
      const frontmatter = content.split('---')[1] ?? '';
      expect(frontmatter).toMatch(/^name:/m);
      expect(frontmatter).toMatch(/^description:/m);
      // `applyTo` is what makes the file auto-attach. A contributed file without it
      // is only reachable when the model decides to load it on demand, and the
      // description alone competes with every other instruction in scope - which is
      // how the file ends up in the customization plugin yet still not in the prompt.
      expect(frontmatter).toMatch(/^applyTo:/m);

      // Tool names must be the camelCase reference names VS Code registers, not the
      // snake_case tool ids: a chat prompt only resolves the former.
      for (const match of content.matchAll(/`(bce_[a-z_]+)`/g)) {
        expect(match[1]).toBe(match[1].replace(/_([a-z])/g, (_all, c: string) => c.toUpperCase()));
      }
    }
  });

  it('registers every language model tool, command and the status bar', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    expect([...__mock.state.tools.keys()].sort()).toEqual([
      'bce_explain_impact',
      'bce_find_context',
      'bce_get_file_context',
      'bce_get_project_overview',
      'bce_get_related_tests',
      'bce_get_status'
    ]);
    const commands = [...__mock.state.commands.keys()];
    expect(commands).toEqual(
      expect.arrayContaining([
        'bce.analyzeProject',
        'bce.rebuildIndex',
        'bce.showProjectMap',
        'bce.searchContext',
        'bce.showDiagnostics',
        'bce.clearCache',
        'bce.pauseIndexing',
        'bce.resumeIndexing',
        'bce.cancelIndexing',
        'bce.ensureGitIgnore',
        'bce.runBenchmark'
      ])
    );
    expect(__mock.state.statusBarItems.length).toBe(1);
    expect(__mock.state.statusBarItems[0].text).toContain('bce');
  });

  it('indexes the workspace in the background and answers a tool call', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      const text = (status as { content: { value: string }[] }).content[0].value;
      return text.includes('complete: true');
    });

    const overview = await __mock.invokeTool('bce_get_project_overview', {});
    const overviewText = (overview as { content: { value: string }[] }).content[0].value;
    expect(overviewText).toContain('BCE project overview');
    expect(overviewText).toContain('Express');

    const find = await __mock.invokeTool('bce_find_context', { query: 'OrderService refund' });
    const findText = (find as { content: { value: string }[] }).content[0].value;
    expect(findText).toContain('src/services/orderService.ts');

    const status = await __mock.invokeTool('bce_get_status', { verbose: true });
    const statusText = (status as { content: { value: string }[] }).content[0].value;
    expect(statusText).toContain('bce_find_context');
    expect(statusText).toContain('estimated tokens');
  });

  it('logs what the tools returned and reports the estimated savings', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      return (status as { content: { value: string }[] }).content[0].value.includes('complete: true');
    });

    await __mock.invokeTool('bce_find_context', { query: 'OrderService refund', maxTokens: 300, includeSnippets: false });
    await __mock.invokeTool('bce_get_file_context', { path: 'src/services/orderService.ts', symbol: 'refund' });

    // BCE keeps its files in <extension storage>/bce-index.
    const logFile = path.join(storage.dir, 'bce-index', 'usage.jsonl');
    const readLog = async (): Promise<{ tool: string; label?: string; returnedTokens: number; baselineTokens?: number }[]> => {
      const text = await fs.readFile(logFile, 'utf8').catch(() => '');
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { tool: string; label?: string; returnedTokens: number; baselineTokens?: number });
    };
    // The writes are queued, so wait for the two new entries to land instead of assuming the log is
    // complete the moment it exists. Earlier entries come from the status polling above.
    await waitFor(async () => {
      const written = await readLog();
      return (
        written.length >= 3 &&
        written[written.length - 2]?.tool === 'bce_find_context' &&
        written[written.length - 1]?.tool === 'bce_get_file_context'
      );
    });
    const entries = await readLog();
    const search = entries[entries.length - 2];
    const file = entries[entries.length - 1];
    expect(search.tool).toBe('bce_find_context');
    expect(search.label).toBe('OrderService refund');
    expect(search.returnedTokens).toBeGreaterThan(0);
    expect(search.baselineTokens).toBeGreaterThan(0);
    expect(file.tool).toBe('bce_get_file_context');
    expect(file.label).toBe('src/services/orderService.ts#refund');
    expect(entries.length).toBeGreaterThanOrEqual(3);

    const status = await __mock.invokeTool('bce_get_status', { verbose: true });
    const statusText = (status as { content: { value: string }[] }).content[0].value;
    expect(statusText).toContain('estimated context avoided');
    expect(statusText).toContain('usage.jsonl');

    const outputBefore = __mock.state.outputLines.length;
    await vscode.commands.executeCommand('bce.showUsageReport');
    const report = __mock.state.outputLines.slice(outputBefore).join('\n');
    expect(report).toContain('# BCE usage log');
    expect(report).toContain('bce_find_context');
    expect(report).toContain('local estimates');

    await vscode.commands.executeCommand('bce.resetUsageLog');
    expect(__mock.state.messages.some((message) => message.includes('delete the usage log'))).toBe(true);
  });

  it('stores the index outside the project and keeps the project clean', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    // The map is written file by file, so wait for the last one.
    await waitFor(async () =>
      fs.access(path.join(storage.dir, 'bce-index', 'map', 'entry-points.json')).then(
        () => true,
        () => false
      )
    );
    const mapFiles = await fs.readdir(path.join(storage.dir, 'bce-index', 'map'));
    expect(mapFiles).toEqual(
      expect.arrayContaining(['project-overview.json', 'modules.json', 'dependencies.json', 'database-schema.json', 'entry-points.json'])
    );
    await expect(fs.access(path.join(project.dir, '.bce'))).rejects.toThrow();
  });

  it('serves unsaved editor content through the file context tool', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      return (status as { content: { value: string }[] }).content[0].value.includes('complete: true');
    });

    const target = path.join(project.dir, 'src', 'utils', 'money.ts');
    __mock.setOpenDocument(
      target,
      'export function editorOnlyMoney(cents: number): string {\n  return `${cents * 2}`;\n}\n',
      5
    );

    const edited = await __mock.invokeTool('bce_get_file_context', { path: 'src/utils/money.ts', symbol: 'editorOnlyMoney' });
    const editedText = (edited as { content: { value: string }[] }).content[0].value;
    expect(editedText).toContain('UNSAVED editor buffer');
    expect(editedText).toContain('editorOnlyMoney');

    const status = await __mock.invokeTool('bce_get_status', {});
    expect((status as { content: { value: string }[] }).content[0].value).toContain('unsaved changes: 1 open file(s)');
  });

  it('rejects tool calls with invalid input and explains the parameter', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await expect(__mock.invokeTool('bce_find_context', {})).rejects.toThrow(/"query" is required/);
  });

  it('rejects a tool that the user disabled in the settings', async () => {
    __mock.setConfiguration('bce.tools.findContext.enabled', false);
    await activate(context as unknown as vscode.ExtensionContext);
    await expect(__mock.invokeTool('bce_find_context', { query: 'orders' })).rejects.toThrow(/disabled by setting bce.tools.findContext.enabled/);
  });

  it('does not start indexing when bce.enabled is false', async () => {
    __mock.setConfiguration('bce.enabled', false);
    await activate(context as unknown as vscode.ExtensionContext);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await fs.access(path.join(storage.dir, 'bce-index', 'index.json')).then(() => true, () => false)).toBe(false);
    expect(__mock.state.statusBarItems[0].text).toContain('off');
  });

  it('handles workspace folder changes without losing the existing session', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    __mock.fireWorkspaceFolderChange();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await __mock.invokeTool('bce_get_status', {});
    expect((status as { content: { value: string }[] }).content[0].value).toContain('BCE status');
  });

  it('reloads settings and rebuilds when indexing settings change', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      return (status as { content: { value: string }[] }).content[0].value.includes('complete: true');
    });
    __mock.setConfiguration('bce.includePaths', ['generated/**']);
    __mock.fireConfigurationChange(['bce.includePaths']);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      const text = (status as { content: { value: string }[] }).content[0].value;
      return text.includes('index v2') || text.includes('index v3');
    });
    const status = await __mock.invokeTool('bce_find_context', { query: 'generatedApiClient' });
    expect((status as { content: { value: string }[] }).content[0].value).toContain('generated/api-client.ts');
  });

  it('runs the commands without throwing', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      return (status as { content: { value: string }[] }).content[0].value.includes('complete: true');
    });
    await vscode.commands.executeCommand('bce.showProjectMap');
    await vscode.commands.executeCommand('bce.pauseIndexing');
    await vscode.commands.executeCommand('bce.resumeIndexing');
    await vscode.commands.executeCommand('bce.cancelIndexing');
    await vscode.commands.executeCommand('bce.clearCache');
    await vscode.commands.executeCommand('bce.ensureGitIgnore');
    await vscode.commands.executeCommand('bce.showDiagnostics');
    await vscode.commands.executeCommand('bce.runBenchmark');
    expect(__mock.state.openedDocuments.some((document) => document === '<untitled>')).toBe(true);
    expect(__mock.state.messages.some((message) => message.includes('BCE'))).toBe(true);
  });

  it('renders a useful diagnostics panel', async () => {
    const logger = new BceLogger();
    const statusBar = new BceStatusBar();
    const sessions = new SessionManager(context as unknown as vscode.ExtensionContext, logger, statusBar);
    await sessions.refreshFolders();
    await waitFor(async () => sessions.default()?.indexer.getIndex().size !== 0);
    registerCommands(context as unknown as vscode.ExtensionContext, sessions, logger);
    registerLanguageModelTools(context as unknown as vscode.ExtensionContext, sessions, logger);
    await __mock.invokeTool('bce_get_status', {});
    const html = renderDiagnosticsHtml(sessions, 'test-nonce');
    expect(html).toContain('Boopy Context Engine - local diagnostics');
    expect(html).toContain('bce_get_status');
    expect(html).toContain('not</strong> the Copilot');
    // The document must stay stable: refreshes arrive as messages, so the CSP has to allow exactly the
    // nonce'd script that applies them.
    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).toContain('<script nonce="test-nonce">');
    expect(html).toContain('bce:content');
    expect(renderDiagnosticsBody(sessions)).toContain('bce_get_status');
    sessions.dispose();
    statusBar.dispose();
    logger.dispose();
  });

  it('loads the diagnostics webview once and refreshes it without reloading the document', async () => {
    await activate(context as unknown as vscode.ExtensionContext);
    await waitFor(async () => {
      const status = await __mock.invokeTool('bce_get_status', {});
      return (status as { content: { value: string }[] }).content[0].value.includes('complete: true');
    });
    await vscode.commands.executeCommand('bce.showDiagnostics');
    const [panel] = __mock.state.webviewPanels;
    expect(panel).toBeDefined();
    expect(panel.htmlAssignments).toBe(1);

    // Running the command again reveals the existing panel instead of loading a second document.
    await vscode.commands.executeCommand('bce.showDiagnostics');
    expect(__mock.state.webviewPanels.length).toBe(1);
    expect(panel.htmlAssignments).toBe(1);

    // Live refreshes are pushed into the running document; they never reassign webview.html, which is
    // what used to race with the webview service worker.
    const before = panel.postedMessages.length;
    await waitFor(() => panel.postedMessages.length > before);
    expect(panel.htmlAssignments).toBe(1);
    const message = panel.postedMessages[panel.postedMessages.length - 1] as { type: string; body: string };
    expect(message.type).toBe('bce:content');
    expect(message.body).toContain('<h3>Counters</h3>');
  });
});
