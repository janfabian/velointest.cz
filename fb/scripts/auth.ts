/**
 * Mint a long-lived Facebook Page access token + Page id and write both to .env.
 *
 * Adapted from lilgeckos.com (same trust model: posts as a Page admin).
 *
 * Prereqs:
 *  - A Meta app: developers.facebook.com → Create App → "Business".
 *  - Add the "Facebook Login" product. Under its settings add this URI to
 *    "Valid OAuth Redirect URIs":   http://localhost:4181/
 *  - Keep the app in Development mode — as an app admin you can post to your
 *    own Page without App Review.
 *  - From Settings → Basic, grab the App ID + App Secret. Put them in fb/.env.
 *
 * Usage:
 *   cd fb
 *   bun install
 *   cp .env.example .env             # then fill in FACEBOOK_APP_ID + FACEBOOK_APP_SECRET
 *   bun run auth
 *
 * Open the printed URL signed in as the Page admin, approve. The browser lands
 * on a localhost page — if it loads, the script auto-captures the code; if it
 * doesn't (different machine, etc.), copy the full URL from the address bar
 * (has ?code=...) and paste it. Pick your Page if you manage multiple. The
 * script writes FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN to .env (token
 * never printed). Page tokens minted from a long-lived user token don't expire.
 */
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const APP_ID = process.env.FACEBOOK_APP_ID;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  console.error(
    "Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in fb/.env first (Meta app → Settings → Basic).",
  );
  process.exit(1);
}

const VERSION = process.env.FACEBOOK_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const DIALOG = `https://www.facebook.com/${VERSION}/dialog/oauth`;
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

const PORT = Number(process.env.FACEBOOK_AUTH_PORT || 4181);
const redirectUri = `http://localhost:${PORT}/`;
const ENV_PATH = resolve(process.cwd(), ".env");

const authUrl =
  `${DIALOG}?` +
  new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    scope: SCOPES.join(","),
    response_type: "code",
  }).toString();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const c = new URL(s).searchParams.get("code");
    if (c) return c;
  } catch {
    /* not a URL — fall through */
  }
  const m = s.match(/[?&]code=([^&\s]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return s;
}

function writeEnvVar(key: string, value: string): void {
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body.replace(/\s*$/, "") + `\n${line}\n`;
  writeFileSync(ENV_PATH, body);
}

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${GRAPH}/${path}?` + new URLSearchParams(params).toString());
  const json = (await res.json()) as any;
  if (!res.ok || json?.error) {
    throw new Error(json?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return json;
}

let done = false;
async function finish(code: string): Promise<void> {
  if (done) return;
  done = true;
  try {
    const short = await graphGet("oauth/access_token", {
      client_id: APP_ID!,
      redirect_uri: redirectUri,
      client_secret: APP_SECRET!,
      code,
    });
    const long = await graphGet("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: APP_ID!,
      client_secret: APP_SECRET!,
      fb_exchange_token: short.access_token,
    });
    const accounts = await graphGet("me/accounts", {
      access_token: long.access_token,
      fields: "id,name,access_token,tasks",
    });
    const pages: any[] = accounts.data ?? [];
    let page: any;
    if (pages.length === 1) {
      page = pages[0];
    } else if (pages.length > 1) {
      console.log("\nPages you manage:");
      pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.name}  (id ${p.id})`));
      const idx = Number((await ask(`Pick a page [1-${pages.length}]: `)).trim()) - 1;
      if (!(idx >= 0 && idx < pages.length)) {
        console.error("Invalid choice.");
        process.exit(1);
      }
      page = pages[idx];
    } else {
      // Fallback path when /me/accounts is empty (Business Portfolio / New Pages Experience):
      // try the Page directly using a known FACEBOOK_PAGE_ID.
      const known = process.env.FACEBOOK_PAGE_ID;
      if (known) {
        try {
          const p = await graphGet(known, { fields: "name,access_token", access_token: long.access_token });
          if (p?.access_token) {
            page = { id: known, name: p.name, access_token: p.access_token };
            console.log(`\nℹ️  /me/accounts was empty, reached the Page directly via FACEBOOK_PAGE_ID: ${p.name}`);
          }
        } catch {
          /* fall through to diagnostics */
        }
      }
    }

    if (!page) {
      console.error("\n❌ No Pages found for this account. Diagnostics:");
      try {
        const me = await graphGet("me", { access_token: long.access_token, fields: "id,name" });
        console.error(`   Authorized as: ${me.name} (id ${me.id})`);
        const perms = await graphGet("me/permissions", { access_token: long.access_token });
        const granted = (perms.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => p.permission);
        console.error(`   Granted:  ${granted.join(", ") || "(none)"}`);
      } catch (e) {
        console.error(`   (couldn't read /me/permissions: ${e instanceof Error ? e.message : e})`);
      }
      process.exit(1);
    }

    writeEnvVar("FACEBOOK_PAGE_ID", String(page.id));
    writeEnvVar("FACEBOOK_PAGE_ACCESS_TOKEN", String(page.access_token));
    console.log(
      `\n✅ Wrote FACEBOOK_PAGE_ID (${page.id}) and FACEBOOK_PAGE_ACCESS_TOKEN to ${ENV_PATH} (token not printed).`,
    );
    console.log(`   Page: ${page.name}`);
    if (Array.isArray(page.tasks) && !page.tasks.includes("CREATE_CONTENT")) {
      console.log(
        "   ⚠️  This page token may lack CREATE_CONTENT (posting) rights — confirm you're a full admin of the Page.",
      );
    }
    console.log("\n   Test it:  bun run check");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Failed:", err instanceof Error ? err.message : err);
    console.error("   Auth codes expire fast — re-run and paste a fresh redirect URL if needed.");
    process.exit(1);
  }
}

const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", redirectUri).searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing ?code");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<h2>Authorized — you can close this tab.</h2>");
  server.close();
  await finish(code);
});
server.listen(PORT);

console.log("\n1) Open this URL, signed in as the Facebook account that administers the Page:\n");
console.log(authUrl + "\n");
console.log("2) Approve the requested permissions.");
console.log("3) Your browser lands on a localhost page. If it loads, you're done.");
console.log("   If it doesn't (different machine, etc.), copy the FULL address-bar URL");
console.log("   (it has ?code=...) and paste it below.\n");
console.log(`(Reminder: http://localhost:${PORT}/ must be in the app's Valid OAuth Redirect URIs.)\n`);

ask("Paste the redirected URL (or code) here, or wait for the browser callback: ").then(async (answer) => {
  const code = extractCode(answer);
  if (!code) {
    console.error("No code found in what you pasted.");
    process.exit(1);
  }
  server.close();
  await finish(code);
});
