/**
 * Minimal in-memory stand-in for the `vscode` module used by the test suite.
 *
 * It implements only what BCE touches. `workspace.fs` proxies to the real file
 * system so integration tests can exercise the extension against a temporary
 * fixture project without starting an Extension Host.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string
  ) {}

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static parse(value: string): Uri {
    if (value.startsWith('file://')) {
      return new Uri('file', decodeURIComponent(value.slice('file://'.length)).replace(/^\//, '').replace(/\//g, path.sep));
    }
    return new Uri('file', value);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, path.join(base.fsPath, ...parts));
  }

  get path(): string {
    return this.fsPath.replace(/\\/g, '/');
  }

  toString(): string {
    return `file:///${this.fsPath.replace(/\\/g, '/')}`;
  }

  with(): Uri {
    return this;
  }
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();

  readonly event = (listener: (value: T) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class MarkdownString {
  private value = '';

  appendMarkdown(text: string): MarkdownString {
    this.value += text;
    return this;
  }

  appendText(text: string): MarkdownString {
    this.value += text;
    return this;
  }

  get text(): string {
    return this.value;
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position
  ) {}
}

export class Selection extends Range {}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3
}

export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(readonly content: unknown[]) {}
}

export interface MockState {
  tools: Map<string, { invoke(options: unknown, token: unknown): Promise<unknown>; prepareInvocation(options: unknown, token: unknown): Promise<unknown> }>;
  commands: Map<string, (...args: unknown[]) => unknown>;
  statusBarItems: MockStatusBarItem[];
  outputLines: string[];
  messages: string[];
  workspaceFolders: MockWorkspaceFolder[];
  configuration: Map<string, unknown>;
  isTrusted: boolean;
  watchers: MockWatcher[];
  failWrites: boolean;
  openedDocuments: string[];
  textDocuments: MockTextDocument[];
  webviewPanels: MockWebviewPanel[];
  reset(): void;
}

export interface MockWorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export interface MockStatusBarItem {
  id: string;
  text: string;
  tooltip: unknown;
  command?: string;
  backgroundColor?: ThemeColor;
  visible: boolean;
}

export interface MockWatcher {
  pattern: unknown;
  disposed: boolean;
}

export interface MockTextDocument {
  uri: Uri;
  version: number;
  isDirty: boolean;
  getText(): string;
}

export interface MockWebviewPanel {
  readonly viewType: string;
  readonly title: string;
  visible: boolean;
  disposed: boolean;
  /** Every assignment to `webview.html` reloads the document in the real extension host. */
  htmlAssignments: number;
  readonly postedMessages: unknown[];
  readonly webview: {
    html: string;
    readonly cspSource: string;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void };
  };
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

const state: MockState = {
  tools: new Map(),
  commands: new Map(),
  statusBarItems: [],
  outputLines: [],
  messages: [],
  workspaceFolders: [],
  configuration: new Map(),
  isTrusted: true,
  watchers: [],
  failWrites: false,
  openedDocuments: [],
  textDocuments: [],
  webviewPanels: [],
  reset(): void {
    state.tools.clear();
    state.commands.clear();
    state.statusBarItems.length = 0;
    state.outputLines.length = 0;
    state.messages.length = 0;
    state.workspaceFolders.length = 0;
    state.configuration.clear();
    state.isTrusted = true;
    state.watchers.length = 0;
    state.failWrites = false;
    state.openedDocuments.length = 0;
    state.textDocuments.length = 0;
    state.webviewPanels.length = 0;
  }
};

export const __mock = {
  state,
  setWorkspaceFolders(folders: string[]): void {
    state.workspaceFolders = folders.map((folder, index) => ({
      uri: Uri.file(folder),
      name: path.basename(folder),
      index
    }));
  },
  setConfiguration(key: string, value: unknown): void {
    state.configuration.set(key, value);
  },
  fireConfigurationChange(keys: string[]): void {
    configurationListeners.forEach((listener) =>
      listener({
        affectsConfiguration: (key: string) => keys.some((candidate) => candidate === key || candidate.startsWith(`${key}.`) || key.startsWith(`${candidate}.`))
      })
    );
  },
  fireWorkspaceFolderChange(): void {
    folderListeners.forEach((listener) => listener({ added: [], removed: [] }));
  },
  async invokeTool(name: string, input: unknown, token?: unknown): Promise<unknown> {
    const tool = state.tools.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} is not registered`);
    }
    return tool.invoke({ input }, token ?? cancellationToken());
  },
  /** Marks a file as open in the editor with unsaved changes. */
  setOpenDocument(fsPath: string, text: string, version = 1, isDirty = true): void {
    state.textDocuments.push({
      uri: Uri.file(fsPath),
      version,
      isDirty,
      getText: () => text
    });
  },
  closeDocuments(): void {
    state.textDocuments.length = 0;
  },
  cancellationToken,
  dispose(): void {
    state.reset();
  }
};

const configurationListeners: ((event: { affectsConfiguration(key: string): boolean }) => unknown)[] = [];
const folderListeners: ((event: { added: unknown[]; removed: unknown[] }) => unknown)[] = [];
const trustListeners: (() => unknown)[] = [];

function cancellationToken(): {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
} {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
  };
}

export const workspace = {
  get workspaceFolders(): MockWorkspaceFolder[] | undefined {
    return state.workspaceFolders.length > 0 ? state.workspaceFolders : undefined;
  },
  get textDocuments(): MockTextDocument[] {
    return state.textDocuments;
  },
  async openTextDocument(argument: { content?: string; language?: string } | Uri): Promise<{ uri?: Uri; content?: string; languageId?: string; lineCount: number }> {
    if (argument instanceof Uri) {
      state.openedDocuments.push(argument.fsPath);
      const content = await fs.readFile(argument.fsPath, 'utf8');
      return { uri: argument, content, languageId: 'plaintext', lineCount: content.split('\n').length };
    }
    state.openedDocuments.push('<untitled>');
    return { content: argument?.content ?? '', languageId: argument?.language, lineCount: (argument?.content ?? '').split('\n').length };
  },
  get isTrusted(): boolean {
    return state.isTrusted;
  },
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const full = section ? `${section}.${key}` : key;
        return (state.configuration.has(full) ? (state.configuration.get(full) as T) : fallback);
      },
      update(): Promise<void> {
        return Promise.resolve();
      }
    };
  },
  getWorkspaceFolder(uri: Uri): MockWorkspaceFolder | undefined {
    return state.workspaceFolders.find((folder) => uri.fsPath.toLowerCase().startsWith(folder.uri.fsPath.toLowerCase()));
  },
  createFileSystemWatcher(pattern: unknown): {
    onDidChange(listener: (uri: Uri) => unknown): { dispose(): void };
    onDidCreate(listener: (uri: Uri) => unknown): { dispose(): void };
    onDidDelete(listener: (uri: Uri) => unknown): { dispose(): void };
    dispose(): void;
  } {
    const watcher: MockWatcher = { pattern, disposed: false };
    state.watchers.push(watcher);
    return {
      onDidChange: () => ({ dispose: () => undefined }),
      onDidCreate: () => ({ dispose: () => undefined }),
      onDidDelete: () => ({ dispose: () => undefined }),
      dispose: () => {
        watcher.disposed = true;
      }
    };
  },
  onDidChangeConfiguration(listener: (event: { affectsConfiguration(key: string): boolean }) => unknown): { dispose(): void } {
    configurationListeners.push(listener);
    return {
      dispose: () => {
        const index = configurationListeners.indexOf(listener);
        if (index >= 0) {
          configurationListeners.splice(index, 1);
        }
      }
    };
  },
  onDidChangeWorkspaceFolders(listener: (event: { added: unknown[]; removed: unknown[] }) => unknown): { dispose(): void } {
    folderListeners.push(listener);
    return {
      dispose: () => {
        const index = folderListeners.indexOf(listener);
        if (index >= 0) {
          folderListeners.splice(index, 1);
        }
      }
    };
  },
  onDidGrantWorkspaceTrust(listener: () => unknown): { dispose(): void } {
    trustListeners.push(listener);
    return {
      dispose: () => {
        const index = trustListeners.indexOf(listener);
        if (index >= 0) {
          trustListeners.splice(index, 1);
        }
      }
    };
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      return fs.readFile(uri.fsPath);
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      if (state.failWrites) {
        throw new Error('write blocked by the test');
      }
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content);
    },
    async stat(uri: Uri): Promise<{ type: number; size: number }> {
      const stats = await fs.stat(uri.fsPath);
      return { type: stats.isDirectory() ? 2 : 1, size: stats.size };
    },
    async createDirectory(uri: Uri): Promise<void> {
      await fs.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri: Uri): Promise<void> {
      await fs.rm(uri.fsPath, { force: true, recursive: true });
    }
  }
};

export const window = {
  createStatusBarItem(id: string): MockStatusBarItem & {
    show(): void;
    hide(): void;
    dispose(): void;
  } {
    const item: MockStatusBarItem & { show(): void; hide(): void; dispose(): void } = {
      id,
      text: '',
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      visible: false,
      show(): void {
        item.visible = true;
      },
      hide(): void {
        item.visible = false;
      },
      dispose(): void {
        item.visible = false;
      }
    };
    state.statusBarItems.push(item);
    return item;
  },
  createOutputChannel(name: string): { appendLine(value: string): void; show(): void; dispose(): void; clear(): void; name: string } {
    return {
      name,
      appendLine(value: string): void {
        state.outputLines.push(value);
      },
      show(): void {
        // no-op
      },
      clear(): void {
        state.outputLines.length = 0;
      },
      dispose(): void {
        // no-op
      }
    };
  },
  async showInformationMessage(message: string): Promise<string | undefined> {
    state.messages.push(message);
    return undefined;
  },
  async showWarningMessage(message: string): Promise<string | undefined> {
    state.messages.push(message);
    return undefined;
  },
  async showErrorMessage(message: string): Promise<string | undefined> {
    state.messages.push(message);
    return undefined;
  },
  async showInputBox(): Promise<string | undefined> {
    return undefined;
  },
  async showQuickPick(): Promise<undefined> {
    return undefined;
  },
  async withProgress<T>(_options: unknown, task: (progress: { report(value: unknown): void }, token: unknown) => Promise<T>): Promise<T> {
    return task({ report: () => undefined }, cancellationToken());
  },
  createWebviewPanel(viewType: string, title: string): MockWebviewPanel {
    const disposeListeners: (() => void)[] = [];
    const messageListeners: ((message: unknown) => unknown)[] = [];
    let html = '';
    const panel: MockWebviewPanel = {
      viewType,
      title,
      visible: true,
      disposed: false,
      htmlAssignments: 0,
      postedMessages: [],
      webview: {
        get html(): string {
          return html;
        },
        set html(value: string) {
          html = value;
          panel.htmlAssignments += 1;
        },
        cspSource: 'vscode-webview://mock',
        async postMessage(message: unknown): Promise<boolean> {
          if (panel.disposed) {
            return false;
          }
          panel.postedMessages.push(message);
          return true;
        },
        onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } {
          messageListeners.push(listener);
          return { dispose: () => messageListeners.splice(messageListeners.indexOf(listener), 1) };
        }
      },
      reveal(): void {
        panel.visible = true;
      },
      dispose(): void {
        if (panel.disposed) {
          return;
        }
        panel.disposed = true;
        panel.visible = false;
        for (const listener of [...disposeListeners]) {
          listener();
        }
      },
      onDidDispose(listener: () => void): { dispose(): void } {
        disposeListeners.push(listener);
        return { dispose: () => disposeListeners.splice(disposeListeners.indexOf(listener), 1) };
      }
    };
    state.webviewPanels.push(panel);
    return panel;
  },
  async showTextDocument(document: { uri?: Uri; content?: string }): Promise<{ selection: unknown; revealRange(): void }> {
    state.openedDocuments.push(document.uri?.fsPath ?? '<untitled>');
    return { selection: undefined, revealRange: () => undefined };
  }
};

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): { dispose(): void } {
    state.commands.set(id, callback);
    return {
      dispose: () => {
        state.commands.delete(id);
      }
    };
  },
  async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
    const callback = state.commands.get(id);
    if (!callback) {
      return undefined;
    }
    return (await callback(...args)) as T;
  },
  async getCommands(): Promise<string[]> {
    return [...state.commands.keys()];
  }
};

export const lm = {
  registerTool(name: string, tool: { invoke(options: unknown, token: unknown): Promise<unknown> }): { dispose(): void } {
    state.tools.set(name, {
      invoke: tool.invoke.bind(tool),
      prepareInvocation: async () => undefined
    });
    return {
      dispose: () => {
        state.tools.delete(name);
      }
    };
  },
  get tools(): { name: string }[] {
    return [...state.tools.keys()].map((name) => ({ name }));
  }
};

export const env = {
  remoteName: undefined as string | undefined,
  appName: 'Visual Studio Code'
};

export const version = '1.99.0-mock';

export class CancellationTokenSource {
  private isCancelled = false;

  get token() {
    const self = this;
    return {
      get isCancellationRequested(): boolean {
        return self.isCancelled;
      },
      onCancellationRequested: () => ({ dispose: () => undefined })
    };
  }

  cancel(): void {
    this.isCancelled = true;
  }

  dispose(): void {
    // no-op
  }
}

export function dispose(...items: { dispose(): void }[]): void {
  for (const item of items) {
    item.dispose();
  }
}
