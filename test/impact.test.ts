import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { createTempDir, writeFile } from './support/tempProject';
import { runExplainImpact } from '../src/core/tools/handlers';
import { PhpParser } from '../src/core/parse/parsers/php';
import { parseComposerPsr4 } from '../src/core/parse/resolve';

/**
 * Regression tests for impact analysis in a PHP project.
 *
 * Both cases come from a real repository: `PaymentService::delete()` had five
 * callers, and the tool reported "verified parser references (0) - these are safe
 * to trust" for two independent reasons.
 *
 *   1. The reserved word list was shared between languages, and `delete` is a
 *      JavaScript keyword - so every PHP reference named `delete` was dropped
 *      while parsing, before any analysis could see it.
 *   2. The PHP resolver never read composer.json, so `use App\Services\...` could
 *      not be linked and the whole import graph reported zero dependents.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const PAYMENT_SERVICE = `<?php

namespace App\\Services;

class PaymentService
{
    public function delete(int $companyId, int $paymentId, bool $allowCashLinked = false): bool
    {
        return true;
    }
}
`;

const INVOICE_CONTROLLER = `<?php

namespace App\\Controllers;

use App\\Services\\PaymentService;

class InvoiceController
{
    private PaymentService $paymentService;

    public function deletePayment(int $companyId, int $paymentId): bool
    {
        if (!$this->paymentService->delete($companyId, $paymentId)) {
            return false;
        }

        return true;
    }
}
`;

const BANK_STATEMENT_SERVICE = `<?php

namespace App\\Services;

class BankStatementService
{
    public function unmatch(): void
    {
        $this->payments->delete($this->companyId, $this->paymentId);
    }
}
`;

/** A miniature copy of the real layout: the app lives under `backend/` with its own composer.json. */
async function phpProject(withComposer: boolean): Promise<Harness> {
  const temp = await createTempDir('bce-php');
  cleanups.push(temp.cleanup);

  const files: Record<string, string> = {
    'backend/src/Services/PaymentService.php': PAYMENT_SERVICE,
    'backend/src/Controllers/InvoiceController.php': INVOICE_CONTROLLER,
    'backend/src/Services/BankStatementService.php': BANK_STATEMENT_SERVICE
  };
  if (withComposer) {
    files['backend/composer.json'] = JSON.stringify(
      { name: 'acme/backend', autoload: { 'psr-4': { 'App\\': 'src/' } } },
      null,
      2
    );
  }

  for (const [relPath, content] of Object.entries(files)) {
    await writeFile(temp.dir, relPath, content);
  }

  const harness = await createHarness({ root: temp.dir });
  cleanups.push(harness.cleanup);
  await harness.work();
  return harness;
}

describe('PHP reserved words', () => {
  it('keeps method names that are keywords in other languages', () => {
    const parser = new PhpParser();
    const output = parser.parse({
      path: 'backend/src/Controllers/InvoiceController.php',
      content: INVOICE_CONTROLLER,
      language: 'php',
      kind: 'source'
    });

    expect(output.references.some((reference) => reference.name === 'delete')).toBe(true);
    expect(output.references.some((reference) => reference.name === 'PaymentService')).toBe(true);
  });

  it('still ignores real PHP constructs', () => {
    const parser = new PhpParser();
    const output = parser.parse({
      path: 'backend/src/Example.php',
      content: '<?php\nnamespace App;\nclass Example\n{\n    public function run(array $rows): void\n    {\n        foreach ($rows as $row) {\n            if (isset($row) && empty($row)) {\n                print($row);\n            }\n        }\n    }\n}\n',
      language: 'php',
      kind: 'source'
    });

    const names = output.references.map((reference) => reference.name);
    expect(names).not.toContain('foreach');
    expect(names).not.toContain('isset');
    expect(names).not.toContain('empty');
    expect(names).not.toContain('print');
  });
});

describe('composer PSR-4 resolution', () => {
  it('reads the mappings, including the base directory of the manifest', () => {
    const mappings = parseComposerPsr4(
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } }, 'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } } }),
      'backend/composer.json'
    );

    expect(mappings).toEqual([
      { baseDir: 'backend', prefix: 'App\\', target: 'src' },
      { baseDir: 'backend', prefix: 'Tests\\', target: 'tests' }
    ]);
  });

  it('survives a broken manifest instead of failing the index', () => {
    expect(parseComposerPsr4('{ not json', 'composer.json')).toEqual([]);
  });

  it('links a namespace to the file on disk', async () => {
    const h = await phpProject(true);
    const record = h.intelligence.index.get('backend/src/Controllers/InvoiceController.php');
    const import_ = record?.imports.find((entry) => entry.specifier === 'App\\Services\\PaymentService');

    expect(import_?.resolved).toBe('backend/src/Services/PaymentService.php');
    expect(h.intelligence.index.reverseDependencies('backend/src/Services/PaymentService.php').map((file) => file.path)).toContain(
      'backend/src/Controllers/InvoiceController.php'
    );
  });
});

describe('impact analysis in a PHP project', () => {
  it('resolves Class::method to the real callers', async () => {
    const h = await phpProject(true);
    const report = await h.intelligence.buildImpactReport({ symbol: 'PaymentService::delete' });

    expect(report.resolved).toBe(true);
    expect(report.verified.map((reference) => reference.path)).toContain('backend/src/Controllers/InvoiceController.php');
    expect(report.verified.map((reference) => reference.path)).toContain('backend/src/Services/BankStatementService.php');
    expect(report.target.path).toBe('backend/src/Services/PaymentService.php');
    expect(report.coverage.unresolvedInternalImports).toBe(0);
    expect(report.coverage.linkedPercent).toBe(100);
  });

  it('says NOT ANALYSED instead of printing an empty result it cannot vouch for', async () => {
    const h = await phpProject(true);
    const report = await h.intelligence.buildImpactReport({ symbol: 'PaymentService::missing' });

    expect(report.resolved).toBe(false);
    expect(report.verified).toEqual([]);
    expect(report.warnings.join(' ')).toContain('has no member named "missing"');
    expect(report.warnings.join(' ')).not.toContain('No parser verified reference');
  });

  it('explains an unknown class without degrading to file level', async () => {
    const h = await phpProject(true);
    const report = await h.intelligence.buildImpactReport({ symbol: 'NoSuchClass::delete' });

    expect(report.resolved).toBe(false);
    expect(report.warnings.join(' ')).toContain('not present in the index');
  });

  it('reports the linked callers in the tool output', async () => {
    const h = await phpProject(true);
    const payload = await runExplainImpact(h.intelligence, { symbol: 'PaymentService::delete' });

    expect(payload.text).toContain('backend/src/Controllers/InvoiceController.php');
    expect(payload.text).toContain('backend/src/Services/BankStatementService.php');
    expect(payload.text).toContain('coverage: 100%');
    expect(payload.text).toContain('safe to trust');
  });

  it('produces no empty list when the target was not analysed', async () => {
    const h = await phpProject(true);
    const payload = await runExplainImpact(h.intelligence, { symbol: 'PaymentService::missing' });

    expect(payload.text).toContain('NOT ANALYSED');
    expect(payload.text).not.toContain('verified parser references');
    expect(payload.text).not.toContain('(none found)');
  });
});

describe('impact analysis with a broken import graph', () => {
  it('admits the graph is incomplete instead of sounding confident', async () => {
    const h = await phpProject(false);
    const report = await h.intelligence.buildImpactReport({ symbol: 'PaymentService::delete' });

    // The class and its references are still found by name, but nothing can be linked.
    expect(report.resolved).toBe(true);
    expect(report.coverage.internalImports).toBe(1);
    expect(report.coverage.unresolvedInternalImports).toBe(1);
    expect(report.coverage.linkedPercent).toBe(0);

    const payload = await runExplainImpact(h.intelligence, { symbol: 'PaymentService::delete' });
    expect(payload.text).toContain('import graph is incomplete');
    expect(payload.text).not.toContain('safe to trust');
  });
});
