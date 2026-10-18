import { describe, expect, it } from 'vitest';
import { LanguageModelTextPart, LanguageModelToolResult } from 'vscode';
import { addContextFirstInstruction } from '../src/host/tools';
import { CONTEXT_FIRST_INSTRUCTION, WorkspaceSession } from '../src/host/session';

/**
 * `bce.enforceContextFirst` cannot block another tool - VS Code has no such
 * hook - so the contract under test is that the rule reaches the model on every
 * BCE result, and that turning it off leaves the result untouched.
 */

class FakeTool {
  calls = 0;
  constructor(private readonly result = new LanguageModelToolResult([new LanguageModelTextPart('body')])) {}

  async invoke(): Promise<LanguageModelToolResult> {
    this.calls++;
    return this.result;
  }

  dispose(): void {
    // Nothing to release; the signature just mirrors vscode.Disposable.
  }
}

function sessionsWith(rule: string | undefined) {
  return {
    enabled: () => [{ contextFirstInstruction: () => rule } as unknown as WorkspaceSession]
  };
}

function lastText(result: LanguageModelToolResult): string {
  const part = result.content[result.content.length - 1] as LanguageModelTextPart;
  return part.value;
}

describe('bce.enforceContextFirst', () => {
  it('appends the rule to a tool result and keeps the original content', async () => {
    const tool = new FakeTool();
    const [wrapped] = addContextFirstInstruction([tool], sessionsWith(CONTEXT_FIRST_INSTRUCTION));

    const result = (await (wrapped as unknown as FakeTool).invoke()) as LanguageModelToolResult;

    expect(result.content).toHaveLength(2);
    expect((result.content[0] as LanguageModelTextPart).value).toBe('body');
    expect(lastText(result)).toContain('bceFindContext');
    expect(lastText(result)).toContain('symbolsOnly');
    expect(tool.calls).toBe(1);
  });

  it('leaves the result untouched when the setting is off', async () => {
    const tool = new FakeTool();
    const [wrapped] = addContextFirstInstruction([tool], sessionsWith(undefined));

    const result = (await (wrapped as unknown as FakeTool).invoke()) as LanguageModelToolResult;

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as LanguageModelTextPart).value).toBe('body');
  });

  it('ignores sessions without the rule', async () => {
    const tool = new FakeTool();
    const [wrapped] = addContextFirstInstruction([tool], { enabled: () => [] });

    const result = (await (wrapped as unknown as FakeTool).invoke()) as LanguageModelToolResult;

    expect(result.content).toHaveLength(1);
  });

  it('keeps the original result when the rule cannot be read', async () => {
    const tool = new FakeTool();
    const sessions = {
      enabled: () => [
        {
          contextFirstInstruction: () => {
            throw new Error('disposed');
          }
        } as unknown as WorkspaceSession
      ]
    };

    const [wrapped] = addContextFirstInstruction([tool], sessions);
    const result = (await (wrapped as unknown as FakeTool).invoke()) as LanguageModelToolResult;

    expect(result.content).toHaveLength(1);
  });
});
