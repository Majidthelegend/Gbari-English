# Gbari Voices — Gbari–English text + voice dataset collector

Mobile-first site for collecting **reviewed** Gbari–English sentence pairs and voice recordings.
Zero npm dependencies. Node 22.13+ (built-in SQLite). `ffmpeg` is strongly recommended.

## Run it (2 minutes)

```bash
cd gbari-voices
ADMIN_EMAILS=you@example.com npm start        # http://localhost:3000
```
1. Open the site and **sign up with the email you put in `ADMIN_EMAILS`** – that account is the admin.
2. 172 starter phrases (greetings, family, food, numbers, daily actions…) load on first run.
3. Add more any time: Admin → Phrases → upload a CSV (`english,category` and optional `gbari`).

Run the tests: `npm test` (75 API checks).

## Edit before launch  →  `config.js`
| Setting | What to do |
|---|---|
| `DIALECTS` | **Placeholders.** Replace with your 5 variations ("Not sure" is added automatically). |
| `KEYPAD_LETTERS`, `KEYPAD_TONES` | **Placeholders.** Put the exact characters of your orthography. Tone marks are *combining* marks. |
| `APP_NAME`, `TAGLINE` | Branding. |
| `WHATSAPP_INTL` | Already set to 0708 873 1797 (`2347088731797`). |
| `MAX_APPROVED_PER_PROMPT` | 50: a phrase with this many approved translations asks people to pick another. |
| `REVIEWER_MIN_APPROVED`, `REVIEWER_REQUIRES_NATIVE` | Criteria for automatic reviewer access (default: 10 approved + native speaker). |
| `REVIEWS_REQUIRED` | Approvals needed to validate (default 1, always by someone other than the contributor). |
| `REQUIRE_AUDIO` | `true` = no translation without a recording. |
| `CONSENT_POINTS` | Wording of the consent screen. Have a lawyer/ethics adviser read it. |

## Deploy (needs HTTPS — browsers block the microphone on plain http)
* **Docker:** `docker build -t gbari . && docker run -p 3000:3000 -v gbari-data:/data -e ADMIN_EMAILS=you@example.com gbari` and put it behind Caddy/nginx/Cloudflare for HTTPS.
* **Hosts (Render, Railway, Fly.io, a VPS):** run `npm start`, mount a **persistent disk** and set `DATA_DIR` to it. Without a persistent disk you will lose everything on redeploy.
* Env vars: `PORT`, `DATA_DIR`, `ADMIN_EMAILS` (comma-separated), `NODE_ENV=production`, `TRUST_PROXY=1` (behind a proxy), `GOOGLE_CLIENT_ID` (optional).
* **Back up `DATA_DIR`** (database `gbari.db` + `audio/`) regularly.

### Domain name
The app works on any domain. Point your domain's DNS at your host and enable HTTPS there. Names worth checking for availability: `gbarivoices.org`, `gbarivoices.ng`, `gbari.africa`, `speakgbari.org`. Change the visible name in `config.js`.

### Google sign-in (optional)
Create an OAuth *Web* client in Google Cloud Console, add your site URL as an authorised JavaScript origin, then start with `GOOGLE_CLIENT_ID=<id>`. The "Continue with Google" button appears automatically.

## How the pieces work
* **Roles:** contributor → reviewer (automatic when criteria are met, or promoted/blocked by admin) → admin.
* **Entry life-cycle:** `pending` → reviewer marks *Correct* (→ `validated`), *Needs fix* (contributor edits and resubmits, new round) or *Reject*. Nobody can review their own entry.
* **Read-aloud mode** records existing validated/seed Gbari text; those recordings are reviewed the same way.
* **Audio:** only real audio is accepted (file type checked from its bytes, not its name), max 30 s, converted to mono WebM/Opus (~32 kbps). Files are named `category_promptID_contributorID.webm`.
* **Export (Admin → Export):** `metadata.csv` (+ `audio/` in the ZIP) with ID, English, Gbari, gloss, dialect, village, category, contributor ID, status, reviewers. Emails are never exported.
* **Privacy:** emails are visible only to admins; leaderboard shows display names; users can download or delete all their data (profile → Your data).
* **Search** on Browse ignores tone marks and folds ɛ→e, ɔ→o, ɓ→b, ɗ→d, ŋ→ng, so a plain keyboard works.

## Known limits
* No email verification or emailed password reset (needs an email provider). Admin → People → *Temporary password* covers resets.
* Single-server SQLite: ample for tens of thousands of entries; ZIP export has no Zip64 (≈4 GB cap).
* Rate limits are in-memory (reset on restart).
* A phrase can slightly exceed 50 approved if several pending entries are approved after it fills; extra variety is kept on purpose.
