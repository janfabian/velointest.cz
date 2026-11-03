#!/usr/bin/env bun
/**
 * CLI: manage existing local posts on the velointest Google Business Profile.
 * Mirrors fb/src/admin.ts.
 *
 *   bun run admin list [--limit N]           # recent posts (id, date, state, snippet)
 *   bun run admin get <post-id>              # full text, state, image, button, link
 *   bun run admin edit <post-id> --text "…"  # replace the post's text
 *   bun run admin delete <post-id> --yes     # delete a post (requires --yes)
 *
 * <post-id> is the bare id from `list` or the full accounts/../localPosts/ID name.
 * Editing only changes the text — image and button are untouched.
 */
import { GbpPublisher, mapGoogleError } from "./gbp.ts";

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) die(`missing ${name} in environment (.env) — run 'bun run auth' first`);
  return v;
}

function printHelp(): void {
  console.log(`Usage: bun run admin <command> [args]

Commands:
  list [--limit N]            Recent posts with ids (default 5).
  get <post-id>               Show a post's text, state, image and link.
  edit <post-id> --text "…"   Replace the post's text (image/button untouched).
  delete <post-id> --yes      Delete a post permanently.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === undefined || cmd === "--help" || cmd === "-h") return printHelp();

  const gbp = new GbpPublisher({
    clientId: envOrDie("GBP_CLIENT_ID"),
    clientSecret: envOrDie("GBP_CLIENT_SECRET"),
    refreshToken: envOrDie("GBP_REFRESH_TOKEN"),
    accountId: envOrDie("GBP_ACCOUNT_ID"),
    locationId: envOrDie("GBP_LOCATION_ID"),
  });

  switch (cmd) {
    case "list": {
      let limit = 5;
      const i = argv.indexOf("--limit");
      if (i >= 0) {
        limit = Number(argv[i + 1] ?? "");
        if (!Number.isInteger(limit) || limit < 1) die("--limit must be a positive integer");
      }
      const posts = await gbp.listPosts(limit);
      if (!posts.length) return void console.log("(no posts)");
      for (const p of posts) {
        const snippet = p.summary.replace(/\s+/g, " ").slice(0, 70);
        console.log(`${p.createTime}  ${p.id}  [${p.state ?? "?"}]`);
        console.log(`  ${snippet}${p.summary.length > 70 ? "…" : ""}`);
      }
      return;
    }
    case "get": {
      const p = await gbp.getPost(argv[1] ?? die("usage: admin get <post-id>"));
      console.log(`id:      ${p.id}`);
      console.log(`state:   ${p.state ?? "?"}`);
      console.log(`created: ${p.createTime}`);
      console.log(`updated: ${p.updateTime}`);
      if (p.url) console.log(`url:     ${p.url}`);
      if (p.imageUrl) console.log(`image:   ${p.imageUrl}`);
      if (p.cta) console.log(`button:  ${p.cta.type}${p.cta.url ? ` → ${p.cta.url}` : ""}`);
      console.log("--- text ---");
      console.log(p.summary || "(no text)");
      return;
    }
    case "edit": {
      const id = argv[1] ?? die('usage: admin edit <post-id> --text "…"');
      const ti = argv.indexOf("--text");
      const text = ti >= 0 ? argv[ti + 1] : undefined;
      if (!text) die('edit requires --text "new text"');
      await gbp.editPost(id, text);
      const after = await gbp.getPost(id); // read back to verify
      if (after.summary !== text.trim()) die("edit was accepted but read-back does not match — check the post manually");
      console.log(`✓ text updated on ${after.id} [${after.state ?? "?"}]`);
      return;
    }
    case "delete": {
      const id = argv[1] ?? die("usage: admin delete <post-id> --yes");
      if (!argv.includes("--yes")) die("delete is permanent — re-run with --yes to confirm");
      await gbp.deletePost(id);
      console.log(`✓ deleted ${id}`);
      return;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  const { errorCode, message } = mapGoogleError(err);
  console.error(`✗ failed: [${errorCode}] ${message}`);
  process.exit(1);
});
