#!/usr/bin/env bun
/**
 * CLI: publish a single post to the configured Facebook Page.
 *
 * Examples:
 *   bun run publish --text "Otevřeno do 18:00"
 *   bun run publish --text "Krásné kolo" --image ./photo.jpg
 *   bun run publish --text "Galerie" --image a.jpg --image b.jpg --image c.jpg
 *   bun run publish --text "Reel" --video ./clip.mp4
 *   bun run publish --text "Mrkněte" --link https://velointest.cz
 *   bun run publish --check                 # liveness probe, no post
 *   bun run publish --text "..." --json     # machine-readable result
 *   bun run publish --text "..." --dry-run  # validate locally, do not POST
 */
import { extname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { FacebookPublisher, type MediaItem, type Post } from "./facebook.ts";

interface Args {
  text: string;
  link?: string;
  images: string[];
  videos: string[];
  json: boolean;
  dryRun: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { text: "", images: [], videos: [], json: false, dryRun: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inlineVal] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const v = argv[++i];
      if (v === undefined) die(`missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case "--text":
      case "-t":
        a.text = take();
        break;
      case "--link":
      case "-l":
        a.link = take();
        break;
      case "--image":
      case "-i":
        a.images.push(take());
        break;
      case "--video":
      case "-v":
        a.videos.push(take());
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
  -t, --text <string>     Post body / caption / description.
  -l, --link <url>        Attach a link (text-only posts).
  -i, --image <path>      Path to an image file. Repeat for multiple images.
  -v, --video <path>      Path to a video file. Only one allowed.
      --json              Print result as JSON (default: human-readable).
      --dry-run           Validate locally, do not POST.
      --check             Liveness probe (no post).
  -h, --help              Show this help.

Examples:
  bun run publish --text "Hello"
  bun run publish --text "Look" --image ./photo.jpg
  bun run publish --text "" --image ./a.jpg --image ./b.jpg
  bun run publish --text "Reel" --video ./clip.mp4
  bun run publish --check
`);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  console.error("run with --help for usage.");
  process.exit(2);
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) die(`missing ${name} in environment (.env)`);
  return v;
}

function classifyMedia(path: string, expected: "image" | "video"): MediaItem {
  const abs = resolve(path);
  if (!existsSync(abs)) die(`file not found: ${abs}`);
  return { path: abs, kind: expected };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const pub = new FacebookPublisher({
    pageId: envOrDie("FACEBOOK_PAGE_ID"),
    pageAccessToken: envOrDie("FACEBOOK_PAGE_ACCESS_TOKEN"),
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION,
    reels: process.env.FACEBOOK_VIDEO_AS_REELS !== "false",
  });

  if (args.check) {
    const r = await pub.check();
    if (args.json) {
      console.log(JSON.stringify(r));
    } else if (r.ok) {
      console.log(`✓ reachable. page: ${r.name}`);
    } else {
      console.error(`✗ failed: [${r.errorCode}] ${r.error}`);
    }
    process.exit(r.ok ? 0 : 1);
  }

  const media: MediaItem[] = [
    ...args.images.map((p) => classifyMedia(p, "image")),
    ...args.videos.map((p) => classifyMedia(p, "video")),
  ];

  const post: Post = { text: args.text };
  if (args.link) post.link = args.link;
  if (media.length) post.media = media;

  if (args.dryRun) {
    const summary = {
      mode: "dry-run",
      text: post.text,
      link: post.link,
      images: args.images.length,
      videos: args.videos.length,
      mediaFiles: media.map((m) => ({ path: m.path, kind: m.kind, ext: extname(m.path) })),
    };
    console.log(args.json ? JSON.stringify(summary, null, 2) : summary);
    return;
  }

  const result = await pub.publish(post);
  if (args.json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log(`✓ published in ${result.durationMs}ms`);
    console.log(`  id:  ${result.postId}`);
    console.log(`  url: ${result.url}`);
  } else {
    console.error(`✗ failed in ${result.durationMs}ms`);
    console.error(`  code: ${result.errorCode}`);
    console.error(`  err:  ${result.error}`);
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("unhandled:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
