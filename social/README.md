# social/ — post to Facebook + Google Business in one go

One approved draft → the velointest Facebook Page **and** the Google Business Profile. Thin layer over `fb/` and `gbp/`: it imports their publishers and reads `fb/.env` + `gbp/.env`, so there is nothing extra to configure.

```bash
cd social && bun install     # once

bun run post --text "…" --image photo.jpg --dry-run    # see exactly what each platform gets
bun run post --text "…" --image photo.jpg              # FB + Google
bun run post --text "…" --video clip.mp4               # Reel on FB; Google gets text + link to the reel
bun run post --text "…" --link https://velointest.cz/cenik.html
bun run post --to fb  --text "…"                        # one platform only
bun run post --to gbp --text "…" --cta CALL             # Google only
bun run post --from-fb <fb-post-id>                     # copy an existing FB post (text + photo) to Google
```

## What Google gets

| Draft has | Facebook | Google Business |
|---|---|---|
| text | text | same text, or `--gbp-text "…"` (max 1500 chars) |
| 1+ images | photo / carousel | first photo, taken from the published FB post (Google only accepts public image URLs) |
| video | Reel | text + "Learn more" button → the FB reel |
| `--link` | link card | "Learn more" button → the link |
| `--cta` / `--cta-url` | — | overrides the button (`LEARN_MORE BOOK ORDER SHOP SIGN_UP CALL`) |

Warnings printed in the dry run: phone number in the Google text (Google tends to reject those — use `--cta CALL` instead), multiple images, video.

## Failure handling

FB is posted first. If FB fails, nothing goes to Google. If FB succeeds and Google fails, the output prints a ready `bun run post --from-fb <id> …` command — run that to retry Google only. **Don't re-run the whole command** (both publishers do skip an identical post created in the last 5 minutes, but don't rely on it).

After posting, Google reviews the post; the result shows its state (`LIVE`, `PROCESSING`, or `REJECTED` — the script checks once more after 5 s).

## Editing / deleting afterwards

- Facebook: `cd fb && bun run admin list | get | edit <id> --text "…" | delete <id> --yes`
- Google: `cd gbp && bun run admin list | get | edit <id> --text "…" | delete <id> --yes`
