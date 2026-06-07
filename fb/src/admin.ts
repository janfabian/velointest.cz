#!/usr/bin/env bun
/**
 * CLI: manage existing posts on the velointest Facebook Page.
 *
 *   bun run admin list [--limit N]           # recent posts (id, date, snippet)
 *   bun run admin get <post-id>              # full message + permalink
 *   bun run admin edit <post-id> --text "…"  # replace the post's message
 *   bun run admin delete <post-id> --yes     # delete a post (requires --yes)
 *
 * <post-id> accepts the full "pageid_postid" form or just the bare post id
 * (the page id from .env is prepended automatically).
 *
 * Editing only changes the message text — photos/attachments are untouched
 * and likes/comments survive. Deleting is permanent and loses engagement,
 * hence the mandatory --yes.
 */
import { mapFbError } from "./facebook.ts";

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) die(`missing ${name} in environment (.env)`);
  return v;
}

const PAGE_ID = envOrDie("FACEBOOK_PAGE_ID");
const TOKEN = envOrDie("FACEBOOK_PAGE_ACCESS_TOKEN");

/** Accept "pageid_postid" or bare "postid". */
function normalizePostId(raw: string): string {
  const s = raw.trim();
  if (!/^[0-9_]+$/.test(s)) die(`not a post id: ${raw}`);
  return s.includes("_") ? s : `${PAGE_ID}_${s}`;
}

async function graph(
  path: string,
  method: "GET" | "POST" | "DELETE",
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams(params ?? {});
  body.set("access_token", TOKEN);
  let res: Response;
  if (method === "GET") {
    for (const [k, v] of body) url.searchParams.set(k, v);
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string; code?: number };
  };
  if (!res.ok) {
    const e = new Error(json.error?.message ?? `Graph API HTTP ${res.status}`) as Error & {
      code?: number;
      httpStatus?: number;
    };
    e.code = json.error?.code;
    e.httpStatus = res.status;
    throw e;
  }
  return json;
}

async function cmdList(limit: number): Promise<void> {
  const res = await graph(`${PAGE_ID}/posts`, "GET", {
    fields: "id,message,created_time,permalink_url",
    limit: String(limit),
  });
  const posts = (res.data ?? []) as Array<{
    id?: string;
    message?: string;
    created_time?: string;
    permalink_url?: string;
  }>;
  if (posts.length === 0) {
    console.log("(no posts)");
    return;
  }
  for (const p of posts) {
    const snippet = (p.message ?? "(no text)").replace(/\s+/g, " ").slice(0, 70);
    console.log(`${p.created_time}  ${p.id}`);
    console.log(`  ${snippet}${snippet.length === 70 ? "…" : ""}`);
  }
}

async function cmdGet(postId: string): Promise<void> {
  const res = await graph(postId, "GET", {
    fields: "message,created_time,updated_time,permalink_url",
  });
  console.log(`id:      ${postId}`);
  console.log(`created: ${res.created_time}`);
  console.log(`updated: ${res.updated_time}`);
  console.log(`url:     ${res.permalink_url}`);
  console.log("--- message ---");
  console.log(res.message ?? "(no text)");
}

async function cmdEdit(postId: string, text: string): Promise<void> {
  await graph(postId, "POST", { message: text });
  // Read back to verify the edit landed.
  const after = await graph(postId, "GET", { fields: "message" });
  const ok = (after.message ?? "") === text;
  if (!ok) die("edit was accepted but read-back does not match — check the post manually");
  console.log(`✓ message updated on ${postId}`);
}

async function cmdDelete(postId: string, yes: boolean): Promise<void> {
  if (!yes) die("delete is permanent (likes/comments are lost) — re-run with --yes to confirm");
  const res = await graph(postId, "DELETE");
  if (res.success !== true) die(`unexpected response: ${JSON.stringify(res)}`);
  console.log(`✓ deleted ${postId}`);
}

function printHelp(): void {
  console.log(`Usage: bun run admin <command> [args]

Commands:
  list [--limit N]            Recent posts with ids (default 5).
  get <post-id>               Show a post's text + permalink.
  edit <post-id> --text "…"   Replace the post's message (photos/likes untouched).
  delete <post-id> --yes      Delete a post permanently.

<post-id> may be "pageid_postid" or the bare post id.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  switch (cmd) {
    case "list": {
      let limit = 5;
      const i = argv.indexOf("--limit");
      if (i >= 0) {
        limit = Number(argv[i + 1] ?? "");
        if (!Number.isFinite(limit) || limit < 1) die("--limit must be a positive integer");
      }
      return cmdList(limit);
    }
    case "get": {
      const id = argv[1] ?? die("usage: admin get <post-id>");
      return cmdGet(normalizePostId(id));
    }
    case "edit": {
      const id = argv[1] ?? die("usage: admin edit <post-id> --text \"…\"");
      const ti = argv.indexOf("--text");
      const text = ti >= 0 ? argv[ti + 1] : undefined;
      if (!text) die("edit requires --text \"new message\"");
      return cmdEdit(normalizePostId(id), text);
    }
    case "delete": {
      const id = argv[1] ?? die("usage: admin delete <post-id> --yes");
      return cmdDelete(normalizePostId(id), argv.includes("--yes"));
    }
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      die(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  const { errorCode, message } = mapFbError(err);
  console.error(`✗ failed: [${errorCode}] ${message}`);
  process.exit(1);
});
