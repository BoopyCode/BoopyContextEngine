import * as vscode from 'vscode';
import { BceLogger } from './ui';
import { SessionManager, WorkspaceSession } from './session';
import { ensureBceGitIgnored } from './gitignore';
import { describeIndexErrors } from '../core/map/projectMap';
import { renderBenchmarkReport, deriveBenchmarkTasks, parseBenchmarkTasks, runLocalBenchmark } from '../core/benchmark/benchmark';
import { renderUsageReport } from '../core/diagnostics/usageLedger';

export function registerCommands(context: vscode.ExtensionContext, sessions: SessionManager, logger: BceLogger): void {
  const requireSession = (): WorkspaceSession | undefined => {
    const session = sessions.default();
    if (!session) {
      void vscode.window.showWarningMessage('Boopy Context Engine: open a folder first, BCE works per workspace folder.');
      return undefined;
    }
    return session;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('bce.analyzeProject', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `BCE: indexing ${session.rootName}`, cancellable: true },
        async (progress, token) => {
          const subscription = session.indexer.onStateChange((state) => {
            progress.report({
              message: state.progress.currentPath ?? state.phase,
              increment: state.progress.total > 0 ? undefined : 0
            });
          });
          token.onCancellationRequested(() => session.indexer.cancel());
          try {
            await session.indexer.initialize({ fullScan: true, token });
          } finally {
            subscription.dispose();
          }
        }
      );
      const index = session.indexer.getIndex();
      void vscode.window.showInformationMessage(
        `BCE: indexed ${index.size} file(s) in ${session.rootName} (${index.getIgnored().length} ignored).`
      );
    }),

    vscode.commands.registerCommand('bce.rebuildIndex', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        'BCE: rebuilding the index discards both cache layers and re-parses every file. Continue?',
        { modal: true },
        'Rebuild'
      );
      if (answer !== 'Rebuild') {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'BCE: rebuilding the index', cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => session.indexer.cancel());
          const subscription = session.indexer.onStateChange((state) => progress.report({ message: state.progress.currentPath ?? state.phase }));
          try {
            await session.indexer.rebuild(token);
          } finally {
            subscription.dispose();
          }
        }
      );
      const index = session.indexer.getIndex();
      void vscode.window.showInformationMessage(`BCE: index rebuilt (${index.size} file(s), ${index.getErrors().length} error(s)).`);
    }),

    vscode.commands.registerCommand('bce.showProjectMap', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      const map = session.intelligence.getMap();
      const lines: string[] = [];
      lines.push(`# BCE project map: ${map.rootName}`);
      lines.push('');
      lines.push(
        `Index v${map.indexVersion}, updated ${new Date(map.updatedAt).toISOString()}${map.partial ? ' (partial)' : ''}${map.complete ? '' : ' - still building'}`
      );
      lines.push('');
      lines.push('## Frameworks');
      lines.push(...(map.overview.frameworks.length > 0 ? map.overview.frameworks.map((f) => `- ${f.name} (${f.confidence}): ${f.evidence}`) : ['- none detected']));
      lines.push('');
      lines.push('## Entry points');
      lines.push(...(map.entryPoints.length > 0 ? map.entryPoints.map((entry) => `- ${entry}`) : ['- none detected']));
      lines.push('');
      lines.push('## Modules');
      for (const module of map.overview.modules) {
        lines.push(`- ${module.path}: ${module.fileCount} file(s) [${module.languages.join(', ')}]${module.topSymbols.length > 0 ? ` - ${module.topSymbols.join(', ')}` : ''}`);
      }
      lines.push('');
      lines.push('## Database');
      lines.push(...(map.databaseSchema.tables.length > 0 ? map.databaseSchema.tables.map((t) => `- ${t.kind} ${t.name} (${t.columns.length} column(s)) ${t.path}:${t.line}`) : ['- none found']));
      lines.push('');
      lines.push('## API routes');
      lines.push(...(map.overview.apiRoutes.length > 0 ? map.overview.apiRoutes.map((r) => `- ${r.detail ?? ''} ${r.name} ${r.path}:${r.line}${r.confidence === 'heuristic' ? ' (heuristic)' : ''}`) : ['- none detected']));
      lines.push('');
      lines.push('## Tests');
      lines.push(...(map.overview.tests.length > 0 ? map.overview.tests.map((t) => `- ${t.path}${t.testedPath ? ` -> ${t.testedPath}` : ''}`) : ['- none found']));
      lines.push('');
      lines.push('## Dependency graph');
      lines.push(`- ${map.dependencies.edges.length} resolved internal import edge(s), ${map.dependencies.externalImports.length} external package(s), ${map.dependencies.unresolved.length} unresolved specifier(s)`);
      lines.push('');
      lines.push('## Machine readable map files');
      for (const file of await session.store.listMapFiles()) {
        lines.push(`- ${vscode.Uri.joinPath(session.getStorageUri(), 'map', file).fsPath}`);
      }
      lines.push('');
      lines.push(`_Map files live in ${session.getStorageUri().fsPath} and are never written into the project unless bce.storage.location is "workspace"._`);
      const document = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: true });
    }),

    vscode.commands.registerCommand('bce.searchContext', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      const query = await vscode.window.showInputBox({
        title: 'BCE: Search Context',
        prompt: 'Describe what you are looking for (same query you would give to bce_find_context)',
        value: '',
        ignoreFocusOut: true
      });
      if (!query || query.trim().length === 0) {
        return;
      }
      const recent = await session.intelligence.recentChanges();
      const { bundle, fromCache } = await session.intelligence.retrieveCached({
        query,
        maxTokens: session.getConfig().tokenBudget,
        includeTests: true,
        includeSnippets: false,
        maxResults: session.getConfig().maxSearchResults,
        snippetLines: 0,
        recentPaths: recent.available ? recent.changedPaths : [],
        entryPoints: session.intelligence.getMap().entryPoints
      });
      if (bundle.items.length === 0) {
        void vscode.window.showInformationMessage(`BCE: no indexed file matched "${query}".`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        bundle.items.map((item) => ({
          label: `$(file-code) ${item.path}`,
          description: `score ${item.score}${item.symbols.length > 0 ? ` - ${item.symbols.map((s) => s.name).slice(0, 3).join(', ')}` : ''}`,
          detail: item.reasons.join('; '),
          item
        })),
        {
          title: `BCE: ${bundle.items.length} ranked hit(s)${fromCache ? ' (cached)' : ''} ~${bundle.estimatedTokens} estimated tokens`,
          placeHolder: 'Select a file to open it at the best matching line'
        }
      );
      if (!picked) {
        return;
      }
      const item = picked.item;
      const target = vscode.Uri.joinPath(session.folder.uri, ...item.path.split('/'));
      const document = await vscode.workspace.openTextDocument(target);
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      const line = item.symbols[0]?.line ?? item.ranges[0]?.start ?? 1;
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }),

    vscode.commands.registerCommand('bce.showDiagnostics', async () => {
      showDiagnosticsPanel(context, sessions);
    }),

    vscode.commands.registerCommand('bce.clearCache', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      session.contextCache.clear();
      session.indexer.getIndex().clearParseCache();
      await session.store.clearCaches().catch(() => undefined);
      session.metrics.recordEvent('info', 'Cache cleared by the user.');
      void vscode.window.showInformationMessage('BCE: both cache layers were cleared. The index itself was kept; use "BCE: Rebuild Index" to re-parse everything.');
    }),

    vscode.commands.registerCommand('bce.showUsageReport', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      await session.usage.flush();
      const summary = session.usage.summary();
      const report = renderUsageReport(summary);
      logger.log('info', report);
      logger.show();
      const document = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: true });
    }),

    vscode.commands.registerCommand('bce.resetUsageLog', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `BCE: delete the usage log of ${session.rootName}? The estimate of avoided context starts over.`,
        { modal: true },
        'Delete'
      );
      if (answer !== 'Delete') {
        return;
      }
      await session.usage.clear();
      session.metrics.recordEvent('info', 'Usage log cleared by the user.');
      void vscode.window.showInformationMessage('BCE: usage log deleted.');
    }),

    vscode.commands.registerCommand('bce.pauseIndexing', () => {
      for (const session of sessions.enabled()) {
        session.indexer.pause();
      }
      void vscode.window.showInformationMessage('BCE: background indexing paused. File changes are queued until you resume.');
    }),

    vscode.commands.registerCommand('bce.resumeIndexing', () => {
      for (const session of sessions.enabled()) {
        session.indexer.resume();
      }
      void vscode.window.showInformationMessage('BCE: background indexing resumed.');
    }),

    vscode.commands.registerCommand('bce.cancelIndexing', () => {
      let cancelled = 0;
      for (const session of sessions.enabled()) {
        if (session.indexer.cancel()) {
          cancelled += 1;
        }
      }
      void vscode.window.showInformationMessage(
        cancelled > 0 ? 'BCE: cancellation requested, the last valid index is kept.' : 'BCE: nothing was running.'
      );
    }),

    vscode.commands.registerCommand('bce.ensureGitIgnore', async () => {
      const results: string[] = [];
      for (const session of sessions.all()) {
        const outcome = await ensureBceGitIgnored(session.folder.uri, {
          trusted: vscode.workspace.isTrusted,
          enabled: true,
          writesIntoProject: session.getConfig().storageLocation === 'workspace'
        });
        results.push(`${session.rootName}: ${outcome}`);
      }
      void vscode.window.showInformationMessage(`BCE git ignore check - ${results.join(' | ')}`);
    }),

    vscode.commands.registerCommand('bce.runBenchmark', async () => {
      const session = requireSession();
      if (!session) {
        return;
      }
      const tasksFile = vscode.Uri.joinPath(session.folder.uri, '.bce-benchmark.json');
      let tasks = deriveBenchmarkTasks(session.intelligence);
      try {
        const bytes = await vscode.workspace.fs.readFile(tasksFile);
        const custom = parseBenchmarkTasks(Buffer.from(bytes).toString('utf8'));
        if (custom.length > 0) {
          tasks = custom;
          logger.log('info', `Benchmark: using ${custom.length} task(s) from .bce-benchmark.json.`);
        }
      } catch {
        logger.log('info', 'Benchmark: no .bce-benchmark.json found, deriving tasks from the project index.');
      }
      if (tasks.length === 0) {
        void vscode.window.showWarningMessage('BCE: no benchmark task could be derived. Index the project first, or add a .bce-benchmark.json file.');
        return;
      }
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'BCE: running the local benchmark', cancellable: false },
        () => runLocalBenchmark(session.intelligence, tasks)
      );
      logger.log('info', renderBenchmarkReport(report));
      logger.show();
      const document = await vscode.workspace.openTextDocument({ content: renderBenchmarkReport(report), language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );
}

function showDiagnosticsPanel(context: vscode.ExtensionContext, sessions: SessionManager): void {
  const panel = vscode.window.createWebviewPanel('bce.diagnostics', 'BCE Diagnostics', vscode.ViewColumn.Active, {
    enableScripts: false,
    localResourceRoots: []
  });
  const render = (): void => {
    panel.webview.html = renderDiagnosticsHtml(sessions);
  };
  render();
  const subscription = sessions.onDidChange(render);
  const interval = setInterval(render, 2000);
  panel.onDidDispose(() => {
    subscription.dispose();
    clearInterval(interval);
  });
  context.subscriptions.push(panel);
}

export function renderDiagnosticsHtml(sessions: SessionManager): string {
  const sections: string[] = [];
  const all = sessions.all();
  if (all.length === 0) {
    sections.push('<p>No workspace folder is open, so BCE has nothing to analyze.</p>');
  }
  for (const session of all) {
    const metrics = session.metrics.snapshot();
    const counters = Object.entries(metrics.counters)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${value}</td></tr>`)
      .join('');
    const timings = Object.entries(metrics.timings)
      .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${value} ms</td></tr>`)
      .join('');
    const tools = Object.entries(metrics.tools)
      .map(
        ([name, stat]) =>
          `<tr><td>${escapeHtml(name)}</td><td>${stat.calls}</td><td>${stat.characters}</td><td>~${stat.estimatedTokens}</td><td>${stat.durationMs} ms</td><td>${stat.errors}</td></tr>`
      )
      .join('');
    const usage = session.usage;
    const usageTotals = usage.totals();
    const usageRows = [
      ['logged entries', String(usage.size)],
      ['estimated tokens returned by BCE', `~${usageTotals.returnedTokens}`],
      ['estimated tokens of the naive alternative', `~${usageTotals.baselineTokens} (${usageTotals.callsWithBaseline} call(s))`],
      ['estimated tokens avoided', `~${usageTotals.savedTokens} (${usageTotals.savedPercent}% smaller)`],
      ['log file', `${escapeHtml(usage.file)}${usage.isPersisted ? '' : ' (logging disabled by setting)'}`]
    ]
      .map(([key, value]) => `<tr><td>${key}</td><td>${value}</td></tr>`)
      .join('');
    const events = metrics.recentEvents
      .slice(-25)
      .reverse()
      .map((event) => `<li>[${new Date(event.at).toLocaleTimeString()}] ${escapeHtml(event.level)}: ${escapeHtml(event.message)}</li>`)
      .join('');
    const index = session.indexer.getIndex();
    const errors = index.getErrors();
    sections.push(`
      <section>
        <h2>${escapeHtml(session.rootName)}</h2>
        <pre>${escapeHtml(session.statusSummary())}</pre>
        <p>Indexing errors: ${errors.length === 0 ? 'none' : escapeHtml(describeIndexErrors(errors))}</p>
        <h3>Counters</h3>
        <table><thead><tr><th>Counter</th><th>Value</th></tr></thead><tbody>${counters || '<tr><td colspan="2">none</td></tr>'}</tbody></table>
        <h3>Timings</h3>
        <table><thead><tr><th>Measurement</th><th>Value</th></tr></thead><tbody>${timings || '<tr><td colspan="2">none</td></tr>'}</tbody></table>
        <h3>Tool usage (this session)</h3>
        <table><thead><tr><th>Tool</th><th>Calls</th><th>Characters</th><th>Estimated tokens</th><th>Duration</th><th>Errors</th></tr></thead><tbody>${
          tools || '<tr><td colspan="6">no tool was called yet</td></tr>'
        }</tbody></table>
        <h3>Estimated context avoided (persistent usage log)</h3>
        <table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${
          usageRows || '<tr><td colspan="2">no usage log</td></tr>'
        }</tbody></table>
        <h3>Recent events</h3>
        <ul>${events || '<li>none</li>'}</ul>
      </section>
    `);
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>BCE Diagnostics</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 1rem; color: var(--vscode-foreground); }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.15rem; margin-top: 1.5rem; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .25rem; }
  table { border-collapse: collapse; margin-bottom: 1rem; width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: .25rem .5rem; text-align: left; font-size: .9rem; }
  pre { background: var(--vscode-textCodeBlock-background); padding: .5rem; overflow-x: auto; font-size: .85rem; }
  ul { font-size: .9rem; }
  .note { background: var(--vscode-editorInfo-background); padding: .5rem .75rem; border-radius: 4px; font-size: .9rem; }
</style>
</head>
<body>
  <h1>Boopy Context Engine - local diagnostics</h1>
  <p class="note">
    Everything here is measured locally inside VS Code. Token numbers are estimates produced by BCE
    (${escapeHtml('chars/4 + token correction')}) and are <strong>not</strong> the Copilot or model provider billing numbers.
    A cache hit only saves local work: sending the same context to a model can still be billed.
  </p>
  ${sections.join('\n')}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
