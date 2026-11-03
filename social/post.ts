#!/usr/bin/env bun
/**
 * Cross-post one approved draft to the Facebook Page AND the Google Business
 * Profile in a single run. Reuses the publishers in ../fb and ../gbp and reads
 * their .env files, so no extra setup.
 *
 *   bun run post --text "…" [--image a.jpg …] [--video clip.mp4] [--link URL]
 *   bun run post --text "…" --image a.jpg --dry-run       # show what each platform gets
 *   bun run post --to fb --text "…"                        # one platform only
 *   bun run post --from-fb <fb-post-id>                    # copy an existing FB post to Google
 *
 * How the Google side is derived from the FB post:
 *  - text      → same text (or --gbp-text to give Google its own wording)
 *  - images    → Google fetches images by public URL only, so we publish to FB
 *                first and hand Google the FB photo's URL. Google shows 1 photo,
 *                so a multi-photo FB post contributes its first photo.
 *  - video     → Google posts can't carry video via the API: Google gets the
 *                text plus a "Learn more" button linking to the FB video.
 *  - --link    → Google gets a "Learn more" button to that link.
 *  - --cta / --cta-url override the button.
 *
 * Order and failure handling: FB first. If FB fails, nothing goes to Google.
 * If FB succeeds and Google fails, the output says so and prints the exact
 * `--from-fb` command to retry Google only (never re-run the whole thing, that
 * would duplicate the FB post — though both publishers also dedupe identical
 * text created in the last 5 minutes).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FacebookPublisher, type MediaItem } from "../fb/src/facebook.ts";
import { GbpPublisher, type CtaType, type LocalPostInput } from "../gbp/src/gbp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || "v21.0"}`;
const VALID_CTA: CtaType[] = ["LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL"];
type Target = "fb" | "gbp";

// ---------- env ----------
function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]!] === undefined && v !== "") process.env[m[1]!] = v;
  }
}
loadEnv(resolve(HERE, "../fb/.env"));
loadEnv(resolve(HERE, "../gbp/.env"));

// ---------- args ----------
interface Args {
  text: string;
  gbpText?: string;
  images: string[];
  video?: string;
  link?: string;
  imageUrl?: string;
  cta?: CtaType;
  ctaUrl?: string;
  to: Target[];
  fromFb?: string;
  dryRun: boolean;
  json: boolean;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { text: "", images: [], to: ["fb", "gbp"], dryRun: false, json: false };
  let toGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = (): string => inline ?? argv[++i] ?? die(`missing value for ${flag}`);
    switch (flag) {
      case "--text": case "-t": a.text = take(); break;
      case "--gbp-text": a.gbpText = take(); break;
      case "--image": case "-i": a.images.push(take()); break;
      case "--video": case "-v":
        if (a.video) die("only one --video allowed");
        a.video = take(); break;
      case "--link": case "-l": a.link = take(); break;
      case "--image-url": a.imageUrl = take(); break;
      case "--cta": {
        const c = take().toUpperCase() as CtaType;
        if (!VALID_CTA.includes(c)) die(`--cta must be one of: ${VALID_CTA.join(", ")}`);
        a.cta = c; break;
      }
      case "--cta-url": a.ctaUrl = take(); break;
      case "--to": {
        toGiven = true;
        const t = take().toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
        for (const x of t) if (x !== "fb" && x !== "gbp") die(`--to accepts fb, gbp (got "${x}")`);
        a.to = [...new Set(t)] as Target[];
        if (!a.to.length) die("--to needs at least one target");
        break;
      }
      case "--from-fb": a.fromFb = take(); break;
      case "--dry-run": a.dryRun = true; break;
      case "--json": a.json = true; break;
      case "--help": case "-h": printHelp(); process.exit(0);
      default: die(`unknown argument: ${arg}`);
    }
  }
  if (a.fromFb) {
    if (toGiven && (a.to.length !== 1 || a.to[0] !== "gbp")) die("--from-fb only posts to Google (--to gbp)");
    a.to = ["gbp"];
    if (a.text || a.images.length || a.video) die("--from-fb takes text/media from the FB post; use --gbp-text to override the text");
  }
  return a;
}

function printHelp(): void {
  console.log(`Usage: bun run post [options]

  -t, --text <s>        Post text (FB message; also Google text unless --gbp-text).
      --gbp-text <s>    Different text for Google (max 1500 chars).
  -i, --image <path>    Image file (repeatable). Google gets the first one, via FB.
  -v, --video <path>    One video (Reel on FB). Google gets text + link to it.
  -l, --link <url>      Link (FB link card; Google "Learn more" button).
      --image-url <u>   Public https image for Google (needed for Google-only posts with an image).
      --cta <TYPE>      Google button: ${VALID_CTA.join(", ")}.
      --cta-url <url>   URL for the Google button (all except CALL).
      --to <list>       fb, gbp or fb,gbp (default fb,gbp).
      --from-fb <id>    Copy an existing FB post (text + photo) to Google.
      --dry-run         Validate and print the plan; post nothing.
      --json            Machine-readable result.`);
}

// ---------- helpers ----------
const PHONE_RE = /(\+?420[\s-]?)?\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

function envOrDie(name: string): string {
  return process.env[name] || die(`missing ${name} (expected in fb/.env or gbp/.env)`);
}

function fbPublisher(): FacebookPublisher {
  return new FacebookPublisher({
    pageId: envOrDie("FACEBOOK_PAGE_ID"),
    pageAccessToken: envOrDie("FACEBOOK_PAGE_ACCESS_TOKEN"),
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION,
    reels: process.env.FACEBOOK_VIDEO_AS_REELS !== "false",
  });
}

function gbpPublisher(): GbpPublisher {
  return new GbpPublisher({
    clientId: envOrDie("GBP_CLIENT_ID"),
    clientSecret: envOrDie("GBP_CLIENT_SECRET"),
    refreshToken: envOrDie("GBP_REFRESH_TOKEN"),
    accountId: envOrDie("GBP_ACCOUNT_ID"),
    locationId: envOrDie("GBP_LOCATION_ID"),
    defaultLang: process.env.GBP_LANG || "cs",
  });
}

interface FbPostInfo {
  id: string;
  message: string;
  permalink?: string;
  imageUrl?: string;
  isVideo: boolean;
}

/** Read an FB post's text, permalink, best photo URL and whether it is a video. */
export async function fetchFbPost(rawId: string, attempts = 3): Promise<FbPostInfo> {
  const pageId = envOrDie("FACEBOOK_PAGE_ID");
  const token = envOrDie("FACEBOOK_PAGE_ACCESS_TOKEN");
  const id = /^\d+$/.test(rawId.trim()) ? `${pageId}_${rawId.trim()}` : rawId.trim();
  const url = new URL(`${GRAPH}/${id}`);
  url.searchParams.set(
    "fields",
    "message,permalink_url,full_picture,status_type,attachments{media_type,media,subattachments{media_type,media}}",
  );
  url.searchParams.set("access_token", token);
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    if (i) await Bun.sleep(2000 * i); // freshly created photos can take a moment to get a CDN url
    const res = await fetch(url);
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      lastErr = j?.error?.message || `Graph HTTP ${res.status}`;
      continue;
    }
    const att = j.attachments?.data?.[0];
    const first = att?.subattachments?.data?.find((s: any) => s.media_type === "photo") ?? att;
    const isVideo = j.status_type === "added_video" || /video/.test(att?.media_type ?? "");
    const imageUrl: string | undefined = isVideo ? undefined : first?.media?.image?.src || j.full_picture || undefined;
    return { id, message: j.message ?? "", permalink: j.permalink_url, imageUrl, isVideo };
  }
  throw new Error(`could not read FB post ${id}: ${lastErr}`);
}

/** Build the Google post input from the draft + what FB ended up with. */
function googleInput(a: Args, text: string, fb?: { url?: string; imageUrl?: string; isVideo: boolean }): LocalPostInput {
  const input: LocalPostInput = { summary: text };
  const imageUrl = a.imageUrl ?? fb?.imageUrl;
  if (imageUrl) input.imageUrl = imageUrl;
  if (a.cta) input.cta = { type: a.cta, url: a.ctaUrl };
  else if (a.link) input.cta = { type: "LEARN_MORE", url: a.link };
  else if (fb?.isVideo && fb.url) input.cta = { type: "LEARN_MORE", url: fb.url };
  return input;
}

// ---------- main ----------
interface Outcome {
  fb?: { ok: boolean; id?: string; url?: string; error?: string };
  gbp?: { ok: boolean; id?: string; url?: string; state?: string; error?: string; retry?: string };
  warnings: string[];
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const out: Outcome = { warnings: [] };
  const toFb = a.to.includes("fb");
  const toGbp = a.to.includes("gbp");

  // --- validate everything before posting anything ---
  const media: MediaItem[] = [];
  for (const p of a.images) {
    const abs = resolve(p);
    if (!existsSync(abs)) die(`file not found: ${abs}`);
    if (!IMAGE_EXT.test(abs)) die(`not an image: ${abs}`);
    media.push({ path: abs, kind: "image" });
  }
  if (a.video) {
    const abs = resolve(a.video);
    if (!existsSync(abs)) die(`file not found: ${abs}`);
    if (!VIDEO_EXT.test(abs)) die(`not a video: ${abs}`);
    if (media.length) die("FB does not allow mixing a video with images");
    media.push({ path: abs, kind: "video" });
  }
  if (a.imageUrl && !/^https:\/\//i.test(a.imageUrl)) die("--image-url must be a public https:// URL");
  if (a.cta && a.cta !== "CALL" && !a.ctaUrl) die(`--cta ${a.cta} needs --cta-url`);
  if (toFb && !a.text && !media.length && !a.link) die("nothing to post: give --text, media or --link");

  let fromFb: FbPostInfo | undefined;
  if (a.fromFb) {
    fromFb = await fetchFbPost(a.fromFb);
    if (!a.gbpText && !fromFb.message) die("that FB post has no text — pass --gbp-text");
  }

  const gText = (a.gbpText ?? (fromFb ? fromFb.message : a.text)).trim();
  if (toGbp) {
    if (!gText) die("Google posts need text (--text or --gbp-text)");
    if (gText.length > 1500) die(`Google text is ${gText.length} chars; max is 1500 — shorten it or pass a shorter --gbp-text`);
    if (PHONE_RE.test(gText))
      out.warnings.push("Google text contains a phone number — Google tends to reject such posts; prefer --gbp-text without it and --cta CALL");
    if (!toFb && a.images.length && !a.imageUrl)
      die("Google can't take local image files — post to FB too (--to fb,gbp) or pass --image-url");
    if (a.images.length > 1) out.warnings.push(`Google shows one photo — it gets the first of the ${a.images.length} images`);
    if (a.video && !a.cta && !a.link) out.warnings.push("Google can't show the video — it gets the text plus a 'Learn more' button to the FB video");
  }

  if (a.dryRun) {
    const g = toGbp
      ? googleInput(a, gText, fromFb
          ? { url: fromFb.permalink, imageUrl: fromFb.imageUrl, isVideo: fromFb.isVideo }
          : { url: a.video ? "(FB video URL)" : undefined, imageUrl: a.images.length ? "(first FB photo URL)" : undefined, isVideo: !!a.video })
      : undefined;
    const plan = {
      mode: "dry-run",
      fb: toFb ? { text: a.text, link: a.link, images: a.images.map((p) => resolve(p)), video: a.video && resolve(a.video) } : undefined,
      gbp: g,
      warnings: out.warnings,
    };
    if (a.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log("dry run — nothing posted\n");
      if (plan.fb) {
        console.log("Facebook:");
        console.log(`  text:   ${plan.fb.text || "(none)"}`);
        if (plan.fb.link) console.log(`  link:   ${plan.fb.link}`);
        plan.fb.images.forEach((p) => console.log(`  image:  ${p}`));
        if (plan.fb.video) console.log(`  video:  ${plan.fb.video}`);
      }
      if (g) {
        console.log("Google Business:");
        console.log(`  text:   ${g.summary}`);
        if (g.imageUrl) console.log(`  image:  ${g.imageUrl}`);
        if (g.cta) console.log(`  button: ${g.cta.type}${g.cta.url ? ` → ${g.cta.url}` : ""}`);
      }
      for (const w of out.warnings) console.log(`⚠ ${w}`);
    }
    return;
  }

  // --- Facebook ---
  let fbInfo: { url?: string; imageUrl?: string; isVideo: boolean } | undefined = fromFb
    ? { url: fromFb.permalink, imageUrl: fromFb.imageUrl, isVideo: fromFb.isVideo }
    : undefined;
  if (toFb) {
    const r = await fbPublisher().publish({ text: a.text, link: a.link, media: media.length ? media : undefined });
    if (!r.ok) {
      out.fb = { ok: false, error: `[${r.errorCode}] ${r.error}` };
      if (toGbp) out.gbp = { ok: false, error: "skipped because Facebook failed" };
      return finish(a, out);
    }
    out.fb = { ok: true, id: r.postId, url: r.url };
    fbInfo = { url: r.url, isVideo: !!a.video };
    if (toGbp && a.images.length && !a.imageUrl) {
      try {
        const info = await fetchFbPost(r.postId);
        fbInfo.imageUrl = info.imageUrl;
        if (!info.imageUrl) throw new Error("FB post has no photo URL yet");
      } catch (e) {
        out.gbp = {
          ok: false,
          error: `couldn't get the photo URL from FB: ${e instanceof Error ? e.message : e}`,
          retry: retryCmd(r.postId, a),
        };
        return finish(a, out);
      }
    }
  }

  // --- Google ---
  if (toGbp) {
    const gbp = gbpPublisher();
    const r = await gbp.publish(googleInput(a, gText, fbInfo));
    if (!r.ok) {
      out.gbp = { ok: false, error: `[${r.errorCode}] ${r.error}`, retry: out.fb?.id ? retryCmd(out.fb.id, a) : undefined };
    } else {
      out.gbp = { ok: true, id: r.name?.split("/").pop(), url: r.url, state: r.state };
      // Google reviews posts asynchronously; look once more so a quick rejection is visible.
      if (r.name && r.state !== "LIVE") {
        await Bun.sleep(5000);
        try {
          const p = await gbp.getPost(r.name);
          out.gbp.state = p.state;
          out.gbp.url = p.url ?? out.gbp.url;
          if (p.state === "REJECTED") out.gbp.ok = false, (out.gbp.error = "Google rejected the post (check text for phone numbers / links / policy issues)");
        } catch { /* keep first state */ }
      }
    }
  }
  finish(a, out);
}

function retryCmd(fbPostId: string, a: Args): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  let cmd = `bun run post --from-fb ${fbPostId}`;
  if (a.gbpText) cmd += ` --gbp-text ${q(a.gbpText)}`;
  if (a.cta) cmd += ` --cta ${a.cta}` + (a.ctaUrl ? ` --cta-url ${q(a.ctaUrl)}` : "");
  else if (a.link) cmd += ` --cta LEARN_MORE --cta-url ${q(a.link)}`;
  if (a.imageUrl) cmd += ` --image-url ${q(a.imageUrl)}`;
  return cmd;
}

function finish(a: Args, out: Outcome): never {
  const ok = (!out.fb || out.fb.ok) && (!out.gbp || out.gbp.ok);
  if (a.json) console.log(JSON.stringify({ ok, ...out }));
  else {
    if (out.fb) console.log(out.fb.ok ? `✓ Facebook: ${out.fb.url}` : `✗ Facebook: ${out.fb.error}`);
    if (out.gbp) {
      if (out.gbp.ok) console.log(`✓ Google:   ${out.gbp.url ?? out.gbp.id} [${out.gbp.state ?? "?"}]`);
      else {
        console.log(`✗ Google:   ${out.gbp.error}`);
        if (out.gbp.retry) console.log(`  retry Google only (from social/):  ${out.gbp.retry}`);
      }
    }
    for (const w of out.warnings) console.log(`⚠ ${w}`);
  }
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("✗ failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
