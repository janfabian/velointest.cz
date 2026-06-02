/**
 * One-time OAuth2 flow for Google Business Profile.
 *
 * Mints a long-lived refresh token, discovers the account + location you
 * manage, and writes GBP_REFRESH_TOKEN / GBP_ACCOUNT_ID / GBP_LOCATION_ID to
 * .env. Re-run with --whoami to just print what the current token can see.
 *
 * Prereqs (see README):
 *  - Google Cloud project with these APIs enabled:
 *      • My Business Account Management API
 *      • My Business Business Information API
 *      • Google My Business API (the v4 one — for localPosts)
 *  - OAuth client of type "Desktop app" → put its id/secret in .env as
 *    GBP_CLIENT_ID / GBP_CLIENT_SECRET.
 *  - Approved access to the Business Profile API (manual Google review).
 *
 * Usage:
 *   cd gbp
 *   bun install
 *   cp .env.example .env       # fill in GBP_CLIENT_ID + GBP_CLIENT_SECRET
 *   bun run auth
 */
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const WHOAMI = process.argv.includes("--whoami");

const CLIENT_ID = process.env.GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GBP_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GBP_CLIENT_ID and GBP_CLIENT_SECRET in gbp/.env first (Cloud Console → Credentials → Desktop app).");
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/business.manage";
const PORT = Number(process.env.GBP_AUTH_PORT || 4182);
const REDIRECT = `http://localhost:${PORT}/`;
const ENV_PATH = resolve(process.cwd(), ".env");

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

function writeEnvVar(key: string, value: string): void {
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body.replace(/\s*$/, "") + `\n${line}\n`;
  writeFileSync(ENV_PATH, body);
}

function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const c = new URL(s).searchParams.get("code");
    if (c) return c;
  } catch {
    /* not a URL */
  }
  const m = s.match(/[?&]code=([^&\s]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return s;
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = (await res.json()) as any;
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `token HTTP ${res.status}`);
  return j.access_token;
}

async function apiGet(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(j?.error?.message || `${res.status} ${res.statusText}`);
  return j;
}

/** List accounts + locations the token can manage, let the user pick, write ids. */
async function discoverAndSave(refreshToken: string): Promise<void> {
  const token = await getAccessToken(refreshToken);

  const accountsRes = await apiGet(`${ACCOUNTS_API}/accounts`, token);
  const accounts: any[] = accountsRes.accounts ?? [];
  if (accounts.length === 0) {
    console.error("\n❌ No Business Profile accounts visible to this login.");
    console.error("   Either this Google account manages no profiles, or Business Profile API");
    console.error("   access isn't approved yet for your Cloud project (403 shows as empty list).");
    process.exit(1);
  }

  let account = accounts[0];
  if (accounts.length > 1) {
    console.log("\nAccounts you manage:");
    accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.accountName || a.name}  (${a.name})`));
    const idx = Number((await ask(`Pick an account [1-${accounts.length}]: `)).trim()) - 1;
    if (!(idx >= 0 && idx < accounts.length)) { console.error("Invalid choice."); process.exit(1); }
    account = accounts[idx];
  }
  const accountId = String(account.name).replace(/^accounts\//, "");

  const locRes = await apiGet(
    `${INFO_API}/accounts/${accountId}/locations?readMask=name,title,storefrontAddress&pageSize=100`,
    token,
  );
  const locations: any[] = locRes.locations ?? [];
  if (locations.length === 0) {
    console.error(`\n❌ No locations under account ${accountId}.`);
    process.exit(1);
  }

  let location = locations[0];
  if (locations.length > 1) {
    console.log("\nLocations:");
    locations.forEach((l, i) => {
      const city = l.storefrontAddress?.locality ? `, ${l.storefrontAddress.locality}` : "";
      console.log(`  [${i + 1}] ${l.title}${city}  (${l.name})`);
    });
    const idx = Number((await ask(`Pick a location [1-${locations.length}]: `)).trim()) - 1;
    if (!(idx >= 0 && idx < locations.length)) { console.error("Invalid choice."); process.exit(1); }
    location = locations[idx];
  }
  const locationId = String(location.name).replace(/^locations\//, "").replace(/^accounts\/[^/]+\/locations\//, "");

  if (WHOAMI) {
    console.log(`\nAccount:  ${account.accountName || account.name} (id ${accountId})`);
    console.log(`Location: ${location.title} (id ${locationId})`);
    process.exit(0);
  }

  writeEnvVar("GBP_ACCOUNT_ID", accountId);
  writeEnvVar("GBP_LOCATION_ID", locationId);
  console.log(`\n✅ Wrote GBP_ACCOUNT_ID (${accountId}) and GBP_LOCATION_ID (${locationId}) to ${ENV_PATH}.`);
  console.log(`   Account:  ${account.accountName || account.name}`);
  console.log(`   Location: ${location.title}`);
  console.log("\n   Test it:  bun run publish --check");
  process.exit(0);
}

async function finishWithCode(code: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    }),
  });
  const j = (await res.json()) as any;
  if (!res.ok || !j.refresh_token) {
    console.error("\n❌ Token exchange failed:", j.error_description || j.error || res.status);
    if (!j.refresh_token && j.access_token) {
      console.error("   Got an access token but no refresh token — re-run; the consent screen must");
      console.error("   include prompt=consent + access_type=offline (this script sets both).");
    }
    process.exit(1);
  }
  writeEnvVar("GBP_REFRESH_TOKEN", j.refresh_token);
  console.log(`\n✅ Wrote GBP_REFRESH_TOKEN to ${ENV_PATH} (token not printed).`);
  await discoverAndSave(j.refresh_token);
}

async function main(): Promise<void> {
  // --whoami uses the existing refresh token; no browser dance.
  if (WHOAMI) {
    const rt = process.env.GBP_REFRESH_TOKEN;
    if (!rt) { console.error("No GBP_REFRESH_TOKEN in .env — run `bun run auth` first."); process.exit(1); }
    await discoverAndSave(rt);
    return;
  }

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID!,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    }).toString();

  const server = createServer(async (req, res) => {
    const code = new URL(req.url ?? "/", REDIRECT).searchParams.get("code");
    if (!code) { res.writeHead(400); res.end("Missing ?code"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>Authorized — you can close this tab.</h2>");
    server.close();
    await finishWithCode(code);
  });
  server.listen(PORT);

  console.log("\n1) Open this URL, signed in as the Google account that manages the Business Profile:\n");
  console.log(authUrl + "\n");
  console.log("2) Approve the requested permission (manage your Business Profile).");
  console.log("3) Your browser lands on a localhost page. If it loads, you're done.");
  console.log("   If not (different machine), copy the FULL address-bar URL (?code=...) and paste below.\n");
  console.log(`(Reminder: http://localhost:${PORT}/ must be an authorized redirect URI on the OAuth client.)\n`);

  ask("Paste the redirected URL (or code), or wait for the browser callback: ").then(async (answer) => {
    const code = extractCode(answer);
    if (!code) { console.error("No code found."); process.exit(1); }
    server.close();
    await finishWithCode(code);
  });
}

main().catch((err) => {
  console.error("\n❌ Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
