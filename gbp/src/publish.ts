#!/usr/bin/env bun
/**
 * CLI: publish a local post to the configured Google Business Profile location.
 *
 * Examples:
 *   bun run publish --text "V pátek 5. 6. máme zavřeno."
 *   bun run publish --text "Nová sezóna!" --image-url https://velointest.cz/static/bike-work-1-r.jpg
 *   bun run publish --text "Zavolejte nám" --cta CALL
 *   bun run publish --text "Mrkněte na web" --cta LEARN_MORE --cta-url https://velointest.cz
 *   bun run publish --text "..." --lang en
 *   bun run publish --check                 # liveness/permission probe, no post
 *   bun run publish --text "..." --json     # machine-readable result
 *   bun run publish --text "..." --dry-run  # validate locally, do not POST
 *
 * Note: GBP fetches images by public URL — use --image-url, not a local path.
 */
import { GbpPublisher, type CtaType, type LocalPostInput } from "./gbp.ts";

interface Args {
  text: string;
  imageUrl?: string;
  cta?: CtaType;
  ctaUrl?: string;
  lang?: string;
  json: boolean;
  dryRun: boolean;
  check: boolean;
}

const VALID_CTA: CtaType[] = ["LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL"];

function parseArgs(argv: string[]): Args {
  const a: Args = { text: "", json: false, dryRun: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inline] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) die(`missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case "--text":
      case "-t":
        a.text = take();
        break;
      case "--image-url":
        a.imageUrl = take();
        break;
      case "--cta":
        a.cta = take().toUpperCase() as CtaType;
        if (!VALID_CTA.includes(a.cta)) die(`--cta must be one of: ${VALID_CTA.join(", ")}`);
        break;
      case "--cta-url":
        a.ctaUrl = take();
        break;
      case "--lang":
        a.lang = take();
        break;
      case "--json":
        a.json = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--check":
        a.check = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        die(`unknown argument: ${arg}`);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`Usage: bun run publish [options]

Options:
  -t, --text <string>     Post body text (required unless --check). Max 1500 chars.
      --image-url <url>    Public https image URL (GBP fetches it server-side).
      --cta <type>         Call-to-action button: ${VALID_CTA.join(" | ")}.
      --cta-url <url>      URL for the CTA (required for all but CALL).
      --lang <code>        Language code (default: GBP_LANG or cs).
      --json               Print result as JSON.
      --dry-run            Validate locally, do not POST.
      --check              Liveness/permission probe (no post).
  -h, --help              Show this help.`);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  console.error("run with --help for usage.");
  process.exit(2);
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) die(`missing ${name} in environment (.env) — run 'bun run auth' first`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const pub = new GbpPublisher({
    clientId: envOrDie("GBP_CLIENT_ID"),
    clientSecret: envOrDie("GBP_CLIENT_SECRET"),
    refreshToken: envOrDie("GBP_REFRESH_TOKEN"),
    accountId: envOrDie("GBP_ACCOUNT_ID"),
    locationId: envOrDie("GBP_LOCATION_ID"),
    defaultLang: process.env.GBP_LANG,
  });

  if (args.check) {
    const r = await pub.check();
    if (args.json) console.log(JSON.stringify(r));
    else if (r.ok) console.log(`✓ reachable. location: ${r.title}`);
    else console.error(`✗ failed: [${r.errorCode}] ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (!args.text) die("--text is required (or use --check)");

  const input: LocalPostInput = { summary: args.text };
  if (args.lang) input.languageCode = args.lang;
  if (args.imageUrl) input.imageUrl = args.imageUrl;
  if (args.cta) input.cta = { type: args.cta, url: args.ctaUrl };

  if (args.dryRun) {
    const summary = { mode: "dry-run", ...input };
    console.log(args.json ? JSON.stringify(summary, null, 2) : summary);
    return;
  }

  const result = await pub.publish(input);
  if (args.json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log(`✓ published in ${result.durationMs}ms`);
    if (result.name) console.log(`  name: ${result.name}`);
    if (result.url) console.log(`  url:  ${result.url}`);
  } else {
    console.error(`✗ failed in ${result.durationMs}ms`);
    console.error(`  code: ${result.errorCode}`);
    console.error(`  err:  ${result.error}`);
    if (result.errorCode === "permission") {
      console.error("  hint: Business Profile API access may not be approved yet for your Cloud project.");
    }
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("unhandled:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
