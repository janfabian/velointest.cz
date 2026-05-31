/**
 * Fetch the N most recent posts authored by the Page and write them to
 * /static/fb-posts.json (committed; served by GH Pages; consumed by the
 * "Z Facebooku" section on the homepage).
 *
 * Usage:
 *   cd fb
 *   bun run posts:fetch                  # default: 3 posts → ../static/fb-posts.json
 *   bun run posts:fetch --limit 5 --out ../static/fb-posts.json
 *
 * Then commit static/fb-posts.json and push. GH Pages will serve the
 * updated payload on the next deploy.
 *
 * Token: same long-lived FACEBOOK_PAGE_ACCESS_TOKEN already in fb/.env
 * from `bun run auth`. Only needs the pages_read_engagement scope (already
 * granted alongside pages_manage_posts during the OAuth flow).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface Args {
  limit: number;
  out: string;
}

interface GraphPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
}

interface OutPost {
  id: string;
  text: string;
  image: string | null;
  url: string;
  createdAt: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 3, out: resolve(process.cwd(), "..", "static", "fb-posts.json") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--limit":
      case "-n":
        a.limit = Number(argv[++i] ?? "");
        if (!Number.isFinite(a.limit) || a.limit < 1) die("--limit must be a positive integer");
        break;
      case "--out":
      case "-o":
        a.out = resolve(String(argv[++i] ?? ""));
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: bun run posts:fetch [--limit N] [--out path]\n" +
            "  --limit N    how many posts (default 3)\n" +
            "  --out path   where to write JSON (default ../static/fb-posts.json)",
        );
        process.exit(0);
      default:
        die(`unknown argument: ${arg}`);
    }
  }
  return a;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) die(`missing ${name} in environment (fb/.env)`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pageId = env("FACEBOOK_PAGE_ID");
  const token = env("FACEBOOK_PAGE_ACCESS_TOKEN");
  const version = process.env.FACEBOOK_GRAPH_VERSION || "v21.0";

  const url =
    `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/posts?` +
    new URLSearchParams({
      fields: "id,message,created_time,permalink_url,full_picture",
      limit: String(args.limit),
      access_token: token,
    }).toString();

  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as { data?: GraphPost[]; error?: { message?: string } };
  if (!res.ok) {
    die(`Graph API ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  }

  const posts: OutPost[] = (json.data ?? []).slice(0, args.limit).map((p) => ({
    id: p.id,
    text: (p.message ?? "").trim(),
    image: p.full_picture ?? null,
    url: p.permalink_url ?? `https://www.facebook.com/${p.id}`,
    createdAt: p.created_time ?? "",
  }));

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(posts, null, 2) + "\n");
  console.log(`✓ wrote ${posts.length} post(s) → ${args.out}`);
  for (const p of posts) {
    const preview = (p.text || "(no text)").replace(/\s+/g, " ").slice(0, 70);
    console.log(`  - ${p.createdAt.slice(0, 10)}  ${preview}${preview.length === 70 ? "…" : ""}`);
  }
}

main().catch((err) => {
  console.error("unhandled:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
