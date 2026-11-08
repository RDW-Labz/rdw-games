// CLI entry for the eval harness.
//
// Usage:
//   pnpm eval --suite=photo-id
//   pnpm eval --suite=manifest-classify --limit=10
//   pnpm eval --suite=upc-lookup --model=anthropic/claude-haiku-4-5
//
// Pre-flight: if no API keys are configured we print a friendly message
// and exit 0. The harness is meant to be safe to run from CI even when
// keys aren't wired up — it should never fail the build for a missing
// secret.

type Suite = 'photo-id' | 'manifest-classify' | 'upc-lookup' | 'all';

type Args = {
  suite: Suite | null;
  limit?: number;
  model?: string;
  fast?: boolean;
  help?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { suite: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--fast') args.fast = true;
    else if (a.startsWith('--suite=')) args.suite = a.slice('--suite='.length) as Suite;
    else if (a.startsWith('--limit=')) args.limit = Number.parseInt(a.slice('--limit='.length), 10);
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
  }
  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`@auction-platform/domain-lotting evals

Usage:
  tsx evals/index.ts --suite=<name> [--limit=N] [--model=<id>] [--fast]

Suites:
  photo-id           Photo identification (scanPhoto / identifyPhoto)
  manifest-classify  Manifest-row enrichment (lookupCode / fetchPrices)
  upc-lookup         UPC/ASIN lookup (lookupCode)
  all                Run everything

Flags:
  --limit=N        Cap the fixture count (handy when iterating).
  --model=<id>     Override EVAL_MODEL_ID for this run.
  --fast           Photo suite only — uses identifyPhoto (no web search).
  -h, --help       Print this and exit.

Environment:
  ANTHROPIC_API_KEY    Required for any actual run.
  OPENROUTER_API_KEY   Required if the LLM client is configured for OpenRouter.
  EVAL_MODEL_ID        Read by the LLM client to pick a specific model.

If no API key is set the harness prints this message and exits 0.
Reports are written to packages/domain-lotting/evals/reports/.`);
}

function hasApiKey(): boolean {
  return !!(process.env['ANTHROPIC_API_KEY'] || process.env['OPENROUTER_API_KEY']);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.suite) {
    printHelp();
    process.exit(0);
  }

  if (!hasApiKey()) {
    // eslint-disable-next-line no-console
    console.log(
      [
        '[evals] No API key found in environment.',
        '[evals] Set ANTHROPIC_API_KEY (or OPENROUTER_API_KEY when the LLM',
        '[evals] client lands) and re-run. The harness exits cleanly here',
        "[evals] because we don't want CI to fail on a missing secret.",
      ].join('\n'),
    );
    process.exit(0);
  }

  if (args.model) {
    process.env['EVAL_MODEL_ID'] = args.model;
  }

  const suites: Array<Exclude<Suite, 'all'>> =
    args.suite === 'all' ? ['photo-id', 'manifest-classify', 'upc-lookup'] : [args.suite];

  for (const suite of suites) {
    // eslint-disable-next-line no-console
    console.log(`[evals] running suite: ${suite}`);
    let reportPath = '';
    if (suite === 'photo-id') {
      const { runPhotoId } = await import('./runners/run-photo-id');
      reportPath = await runPhotoId({
        limit: args.limit,
        modelOverride: args.model ?? null,
        fastMode: args.fast,
      });
    } else if (suite === 'manifest-classify') {
      const { runManifestClassify } = await import('./runners/run-manifest-classify');
      reportPath = await runManifestClassify({
        limit: args.limit,
        modelOverride: args.model ?? null,
      });
    } else if (suite === 'upc-lookup') {
      const { runUpcLookup } = await import('./runners/run-upc-lookup');
      reportPath = await runUpcLookup({
        limit: args.limit,
        modelOverride: args.model ?? null,
      });
    }
    // eslint-disable-next-line no-console
    console.log(`[evals] report: ${reportPath}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[evals] failed:', err);
  process.exit(1);
});
