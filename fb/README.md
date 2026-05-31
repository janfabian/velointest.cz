# fb/ — Facebook Page publisher

Small Bun + TypeScript CLI that posts to a Facebook Page (the velointest.cz Page) via the Meta Graph API. Not a server — call it from the shell or from another script. Adapted from the lilgeckos.com social hub's Facebook adapter.

What it can post:
- Text / link (POST to `/{page}/feed`)
- Single image (POST to `/{page}/photos`)
- Multiple images as a carousel-style post (unpublished `/photos` uploads + `/feed` with `attached_media`)
- A single video as a **Reel** by default (3-phase `/video_reels` upload), or as a regular `/videos` post

## One-time setup

1. **Create a Meta app**
   - developers.facebook.com → Create App → "Business" type.
   - Add the **Facebook Login** product.
   - Under Facebook Login → Settings → **Valid OAuth Redirect URIs**, add:
     ```
     http://localhost:4181/
     ```
   - Keep the app in **Development mode** — as an app admin you can post to your own Page without App Review.
   - Settings → Basic → copy the **App ID** and **App Secret**.

2. **Install Bun** (if you don't have it):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

3. **Install deps + configure env:**
   ```bash
   cd fb
   bun install
   cp .env.example .env
   # then open .env and fill in FACEBOOK_APP_ID and FACEBOOK_APP_SECRET
   ```

4. **Mint the long-lived Page token:**
   ```bash
   bun run auth
   ```
   - The script prints an OAuth URL. Open it signed in as the Facebook account that administers the velointest Page.
   - Approve the requested permissions (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`).
   - The browser is redirected to `http://localhost:4181/?code=…`. If you're on the same machine the script auto-captures it; if not, copy the full URL and paste it back.
   - If you administer multiple Pages, pick the right one when prompted.
   - The script writes `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN` to `.env`. The token never prints to the terminal. Page tokens derived from a long-lived user token don't expire.

5. **Verify:**
   ```bash
   bun run check
   ```
   Should print `✓ reachable. page: <your page name>`.

## Posting

```bash
# Text only
bun run publish --text "Otevřeno do 18:00"

# Text with a link (Facebook expands the link card)
bun run publish --text "Nový web" --link https://velointest.cz

# Single image
bun run publish --text "Krásné kolo" --image ./photo.jpg

# Multiple images (up to ~10; FB supports more, untested here)
bun run publish --text "Galerie" --image ./a.jpg --image ./b.jpg --image ./c.jpg

# Single video, as a Reel by default (most reach). Set FACEBOOK_VIDEO_AS_REELS=false to post as a regular video.
bun run publish --text "Krátký reel" --video ./clip.mp4

# Image only, no caption
bun run publish --text "" --image ./photo.jpg

# Dry run (validate locally, don't POST)
bun run publish --text "Test" --image ./photo.jpg --dry-run

# Machine-readable output for piping
bun run publish --text "Hi" --json
```

Exit code is `0` on success, non-zero on failure. With `--json`, stdout is a single JSON object.

## Supported media

- **Images:** `.jpg .jpeg .png .gif .webp .bmp`, default max 15 MiB (override with `FACEBOOK_IMAGE_MAX_BYTES`).
- **Videos:** `.mp4 .mov .m4v .webm`, default max 512 MiB (override with `FACEBOOK_VIDEO_MAX_BYTES`).

You cannot mix a video with images in a single post (Facebook rejects it).

## Files

```
fb/
├── package.json
├── tsconfig.json
├── .env.example          ← template (commit this, not .env)
├── src/
│   ├── publish.ts        ← CLI entrypoint
│   └── facebook.ts       ← Graph API publisher (text, link, photos, video_reels)
└── scripts/
    └── auth.ts           ← one-time OAuth flow that writes the Page token to .env
```

`.env` is gitignored at the repo root.

## Troubleshooting

- **`✗ failed: [auth] …`** — the Page token has expired (rare; only happens if you revoke it) or the app permissions changed. Re-run `bun run auth`.
- **`No Pages found for this account`** during auth — the Facebook account you signed in with doesn't administer any Pages, or the Page is in a Business Portfolio that hides it from `/me/accounts`. The auth script tries a direct lookup using `FACEBOOK_PAGE_ID` if you've set it manually.
- **Validation error mentioning "video and images"** — pick one or the other; FB rejects mixed posts.
- **`[rate_limit] …`** — back off and retry. The Graph API rate limit for organic posting is generous; only happens with bursts.

## Calling from other scripts

The `FacebookPublisher` class in `src/facebook.ts` is exported and reusable — you can import it from another Bun script if you want to publish from a longer pipeline (e.g. a watcher that posts on commit):

```ts
import { FacebookPublisher } from "./src/facebook.ts";

const fb = new FacebookPublisher({
  pageId: process.env.FACEBOOK_PAGE_ID!,
  pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN!,
});

const result = await fb.publish({
  text: "Hi from a script",
  media: [{ path: "/abs/path/to/photo.jpg", kind: "image" }],
});
```
