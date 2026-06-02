# gbp/ — Google Business Profile post publisher

Bun + TypeScript CLI that publishes **local posts** to the velointest Google Business Profile (the "Z aktualit" / Posts that show in the Google Search/Maps panel). Parallel to `fb/`. Not a server — call it from the shell.

## ⚠️ Read this before you start: API access approval

Unlike Facebook, the Google Business Profile API is **gated behind a manual approval** by Google. Steps:

1. Create / pick a **Google Cloud project**.
2. Enable these APIs (APIs & Services → Library):
   - **My Business Account Management API**
   - **My Business Business Information API**
   - **Google My Business API** (the v4 one — this is what serves `localPosts`)
3. **Request Business Profile API access**: https://developers.google.com/my-business/content/prereqs — fill the access form referencing your Cloud project number. Google reviews it manually; historically **days to ~2 weeks**.
4. Until approved, the APIs return `403 PERMISSION_DENIED` (or `bun run auth` shows an empty account list) even with a perfectly valid OAuth token.

So: set everything up now, but expect `--check` / `publish` to 403 until the access request is granted.

## Media: public URL only

GBP fetches post images **by public URL** (server-side), not by file upload. So `--image-url` must be an `https://` URL Google can reach. Easiest for this project: reference an image already on the site, e.g. `https://velointest.cz/static/bike-work-1-r.jpg`. Local file paths are not supported by GBP local posts.

## One-time setup

1. **Cloud project + APIs + access** — see the warning above.
2. **OAuth client:** Cloud Console → APIs & Services → Credentials → Create credentials → **OAuth client ID** → type **Desktop app**. Copy the client id + secret.
   - Also: under the OAuth consent screen, add your Google account as a **Test user** (so you can authorize while the app is in "Testing" status), and add `http://localhost:4182/` is NOT needed for Desktop-type clients (they accept any localhost port), but if you created a "Web" client instead, add it as an authorized redirect URI.
3. **Install + configure:**
   ```bash
   cd gbp
   bun install
   cp .env.example .env
   # fill in GBP_CLIENT_ID and GBP_CLIENT_SECRET
   ```
4. **Authorize + discover ids:**
   ```bash
   bun run auth
   ```
   - Opens an OAuth URL. Sign in as the account that manages the velointest Business Profile, approve.
   - Writes `GBP_REFRESH_TOKEN`, then lists your accounts + locations and writes `GBP_ACCOUNT_ID` + `GBP_LOCATION_ID`.
   - Refresh token never prints. It's long-lived (no expiry unless revoked / unused 6 months).
5. **Verify:**
   ```bash
   bun run publish --check
   # → ✓ reachable. location: VELOINTEST - 1. pražský specializovaný bikeshop
   ```
   If this 403s, your API access request hasn't been approved yet.

## Posting

```bash
# Text only
bun run publish --text "Tento pátek 5. 6. máme zavřeno."

# Text + image (public URL)
bun run publish --text "Připravte kolo na sezónu" --image-url https://velointest.cz/static/bike-work-1-r.jpg

# Text + "Call" button (uses the profile's phone number)
bun run publish --text "Objednejte se na servis" --cta CALL

# Text + "Learn more" button linking to the site
bun run publish --text "Mrkněte na naše balíčky" --cta LEARN_MORE --cta-url https://velointest.cz/#pkgs

# English post
bun run publish --text "Closed this Friday, June 5." --lang en

# Dry run (validate, do not POST) / machine-readable output
bun run publish --text "..." --dry-run
bun run publish --text "..." --json
```

CTA types: `LEARN_MORE`, `BOOK`, `ORDER`, `SHOP`, `SIGN_UP`, `CALL`. All except `CALL` require `--cta-url`.

Exit code 0 on success, non-zero on failure. `--json` prints a single JSON object.

## Files

```
gbp/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── publish.ts   ← CLI entrypoint
│   └── gbp.ts       ← My Business v4 localPosts publisher + OAuth token refresh
└── scripts/
    └── auth.ts      ← OAuth flow + account/location discovery → writes .env
```

`gbp/.env` is gitignored at the repo root.

## Notes & limits

- **Posts expire.** Google auto-expires `STANDARD` local posts after ~7 days from the Search/Maps panel (the post stays in your Posts history). Re-post weekly to keep something showing. This mirrors how GBP Posts work generally — see the marketing notes.
- **Topic types:** this CLI publishes `STANDARD` posts. `OFFER` and `EVENT` need extra structured fields (coupon codes, schedules) not modeled here — add later if needed.
- **Rate limits:** generous for organic posting; you'll never hit them at one-shop cadence.
- **Reusable class:** `GbpPublisher` in `src/gbp.ts` is exported — import it from another Bun script to post from a longer pipeline (e.g. cross-post the same text to FB + GBP).
