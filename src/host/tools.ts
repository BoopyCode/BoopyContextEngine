import * as vscode from 'vscode';
import { BceLogger } from './ui';
import { SessionManager, WorkspaceSession } from './session';
import { WorkspaceIntelligence } from '../core/workspace';
import { ToolPayload } from '../core/tools/handlers';
import { estimateUsageSavings } from '../core/diagnostics/savings';
import {
  runExplainImpact,
  runFileContext,
  runFindContext,
  runProjectOverview,
  runRelatedTests,
  runStatus
} from '../core/tools/handlers';
import {
  validateFileContextInput,
  validateFindContextInput,
  validateImpactInput,
  validateProjectOverviewInput,
  validateRelatedTestsInput,
  validateStatusInput,
  ValidationResult
} from '../core/tools/validation';
import {
  BceToolName,
  FileContextInput,
  FindContextInput,
  ImpactInput,
  ProjectOverviewInput,
  RelatedTestsInput,
  StatusInput
} from '../core/tools/toolTypes';

interface ToolDefinition<T> {
  name: BceToolName;
  /** Which `bce.tools.*.enabled` setting governs this tool. */
  setting: (session: WorkspaceSession) => boolean;
  validate: (input: unknown) => ValidationResult<T>;
  run: (ws: WorkspaceIntelligence, input: T) => Promise<ToolPayload>;
  /** Extracts the workspace-relevant path from the input, when it has one. */
  targetPath?: (input: T) => string | undefined;
  describe: (input: T) => string;
}

/**
 * Thin adapter between VS Code's Language Model Tool API and the pure handlers in
 * `core`. All the thinking happens in `core`; this class only validates input,
 * picks the right workspace, records diagnostics and builds the tool result.
 */
class BceTool<T> implements vscode.LanguageModelTool<T> {
  constructor(
    private readonly definition: ToolDefinition<T>,
    private readonly sessions: SessionManager,
    private readonly logger: BceLogger
  ) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<T>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    const startedAt = Date.now();
    const validation = this.definition.validate(options.input);
    if (!validation.ok) {
      throw new Error(`${this.definition.name}: ${validation.error}`);
    }

    const session = this.resolveSession(validation.value);
    if (!session) {
      throw new Error(
        'Boopy Context Engine has no active workspace folder. Open a folder in VS Code (bce works per workspace folder) and try again.'
      );
    }
    if (!this.definition.setting(session)) {
      throw new Error(
        `The ${this.definition.name} tool is disabled by setting bce.tools.${toolSettingName(this.definition.name)}.enabled. Ask the user to enable it, or use the built-in file tools instead.`
      );
    }

    try {
      if (token.isCancellationRequested) {
        throw new Error(`${this.definition.name} was cancelled before it started.`);
      }
      const payload = await this.definition.run(session.intelligence, validation.value);
      const durationMs = Date.now() - startedAt;
      session.metrics.recordToolCall(this.definition.name, payload.text.length, payload.estimatedTokens, durationMs);
      const savings = estimateUsageSavings(session.intelligence, this.definition.name, validation.value);
      session.usage?.record({
        tool: this.definition.name,
        label: savings.label,
        returnedTokens: payload.estimatedTokens,
        characters: payload.text.length,
        baselineTokens: savings.baselineTokens,
        baselineFiles: savings.baselineFiles,
        candidateFiles: savings.candidateFiles,
        durationMs
      });
      this.logger.log('debug', `${this.definition.name}: ${payload.text.length} chars, ~${payload.estimatedTokens} tokens, ${durationMs} ms`);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(payload.text)]);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      session.metrics.recordToolCall(this.definition.name, 0, 0, durationMs, true);
      session.usage?.record({
        tool: this.definition.name,
        returnedTokens: 0,
        characters: 0,
        durationMs,
        error: true
      });
      session.metrics.recordEvent('error', `${this.definition.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log('warn', `${this.definition.name} failed: ${message}`);
      throw new Error(`${this.definition.name} failed: ${message}`);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<T>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation | undefined> {
    const validation = this.definition.validate(options.input);
    const description = validation.ok ? this.definition.describe(validation.value) : 'Validating the request';
    return { invocationMessage: `BCE: ${description}` };
  }

  private resolveSession(input: T): WorkspaceSession | undefined {
    const target = this.definition.targetPath?.(input);
    if (target && /^([a-zA-Z]:[\\/]|\/)/.test(target)) {
      return this.sessions.getForUri(vscode.Uri.file(target));
    }
    return this.sessions.default();
  }
}

function toolSettingName(name: BceToolName): string {
  switch (name) {
    case 'bce_get_project_overview':
      return 'projectOverview';
    case 'bce_find_context':
      return 'findContext';
    case 'bce_get_file_context':
      return 'fileContext';
    case 'bce_explain_impact':
      return 'explainImpact';
    case 'bce_get_related_tests':
      return 'relatedTests';
    case 'bce_get_status':
      return 'status';
  }
}

const DEFINITIONS: ToolDefinition<unknown>[] = [
  {
    name: 'bce_get_project_overview',
    setting: (session) => session.getConfig().tools.projectOverview,
    validate: validateProjectOverviewInput as (input: unknown) => ValidationResult<unknown>,
    run: ((ws, input) => runProjectOverview(ws, input as ProjectOverviewInput)) as ToolDefinition<unknown>['run'],
    describe: (input) => {
      const focus = (input as ProjectOverviewInput).focus;
      return focus ? `building the project overview focused on "${focus}"` : 'building the project overview';
    }
  },
  {
    name: 'bce_find_context',
    setting: (session) => session.getConfig().tools.findContext,
    validate: validateFindContextInput as (input: unknown) => ValidationResult<unknown>,
    run: ((ws, input) => runFindContext(ws, input as FindContextInput)) as ToolDefinition<unknown>['run'],
    describe: (input) => `searching the project index for "${(input as FindContextInput).query}"`
  },
  {
    name: 'bce_get_file_context',
    setting: (session) => session.getConfig().tools.fileContext,
    validate: validateFileContextInput as (input: unknown) => ValidationResult<unknown>,
    run: ((ws, input) => runFileContext(ws, input as FileContextInput)) as ToolDefinition<unknown>['run'],
    targetPath: (input) => (input as FileContextInput).path,
    describe: (input) => {
      const cast = input as FileContextInput;
      return cast.symbol ? `reading ${cast.symbol} from ${cast.path}` : `reading ${cast.path}`;
    }
  },
  {
    name: 'bce_explain_impact',
    setting: (session) => session.getConfig().tools.explainImpact,
    validate: validateImpactInput as (input: unknown) => ValidationResult<unknown>,
    run: ((ws, input) => runExplainImpact(ws, input as ImpactInput)) as ToolDefinition<unknown>['run'],
    targetPath: (input) => (input as ImpactInput).path,
    describe: (input) => {
      const cast = input as ImpactInput;
      return `analyzing the impact of ${cast.symbol ?? cast.path ?? 'the given target'}`;
    }
  },
  {
    name: 'bce_get_related_tests',
    setting: (session) => session.getConfig().tools.relatedTests,
    validate: validateRelatedTestsInput as (input: unknown) => ValidationResult<unknown>,
    run: ((ws, input) => runRelatedTests(ws, input as RelatedTestsInput)) as ToolDefinition<unknown>['run'],
    targetPath: (input) => (input as RelatedTestsInput).path,
    describe: (input) => {
      const cast = input as RelatedTestsInput;
      return `looking for tests related to ${cast.path ?? cast.symbol ?? 'the given target'}`;
    }
  },
  {
    name: 'bce_get_status',
    setting: (session) => session.getConfig().tools.status,
    validate: validateStatusInput as (input: unknown) => ValidationResult<unknown>,
    run: ((ws, input) => runStatus(ws, input as StatusInput)) as ToolDefinition<unknown>['run'],
    describe: () => 'collecting index status'
  }
];

export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  sessions: SessionManager,
  logger: BceLogger
): vscode.Disposable[] {
  const registered: vscode.Disposable[] = [];
  for (const definition of DEFINITIONS) {
    const tool = new BceTool(definition, sessions, logger);
    registered.push(vscode.lm.registerTool(definition.name, tool));
    logger.log('info', `Registered language model tool ${definition.name}.`);
  }
  const disposable = {
    dispose: () => {
      for (const item of registered) {
        item.dispose();
      }
    }
  };
  context.subscriptions.push(disposable);
  return registered;
}
