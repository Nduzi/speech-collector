# Speech collector

The data-collection site for **Sibulele Makhonco's final-year project** (a speech-controlled automated chess board, University of Pretoria). It asks people to say the letters **A–H**, the numbers **1–8** and the six chess piece names (**king, queen, rook, bishop, knight, pawn**) into their microphone and sends the
recordings to the project. It feeds the Speech Trainer (a separate, local project) with many different speakers.

* **Site:** static React app, hosted on GitHub Pages. Nothing runs on a server of ours.
* **Storage:** Supabase (project `speech-collector`, Ireland). Recordings go to a *private* bucket; metadata to two tables.
* **Per person:** consent → about you → mic check → 5 rounds × 22 words (≈ 8 min; optional up to 10 rounds) → thank-you page with a participant ID.

## How a recording is made

1. The microphone is opened once (no echo cancellation or noise suppression requested; gain control on).
2. `Endpointer` (the same detector as the Trainer's live test) finds the start and end of each word and keeps 300 ms before and 600 ms after.
3. The take is resampled to **16 kHz mono** (windowed-sinc, low-passed to avoid aliasing) and checked: too quiet, clipped, too short, too long, noisy, and **whether anyone actually spoke**.
   Every letter and number contains a voiced vowel, so a take without a sustained vowel-like sound (a screen tap, a knock on the phone, a click, a breath, silence, a double-tap on "Record manually") is **never saved** and never moves the person on: they are asked again, and after three such tries "Skip this one" appears (nothing is saved for a skipped item).
   Other problems (quiet, noisy, clipped) are re-requested up to 3 times and then kept and flagged so you can filter them. The speech thresholds were chosen against 166 real recordings from three people (`src/lib/quality.ts`).
4. Accepted takes are held for 6 seconds (so **Redo last** works), then queued. The queue stores them in the browser (IndexedDB), uploads
   with retry/back-off, and survives closed tabs and lost connections. Uploads are idempotent.
5. Word order is shuffled per person and round, reproducibly, so a resumed round keeps its order.

## What is stored

`speakers`: first name or nickname, age band, gender, home language, accent note, country, region, mic type, room, consent version/time, user agent, campaign tag.
`recordings`: label, round, 16 kHz WAV path, duration, peak/RMS/noise-floor/SNR, clipped fraction, quality flag, retries, device label, endpoint reason.
No surname, e-mail, phone number or location. See `supabase/migrations/` for the exact schema and policies.

**Security model.** The *publishable* key in `src/config.ts` is public by design. Row-level security lets the public site only **insert** (a speaker, then
recordings for that speaker within 3 days, ≤ 400 per speaker, ≤ 1 MiB WAV files). It cannot read, update or delete anything. All reading and deleting is done by
you, with the secret key, through `scripts/collector_admin.py`. The secret key must never be put in this repository or the site.
Someone determined could still script junk uploads within those limits; if that ever happens, add an invite code or CAPTCHA, or rotate the publishable key.

## Asking one person to add what is missing

When words are added (the chess pieces were), or a few takes were set aside, the Trainer's **Data → Participants** tab has a **Copy link** button for each person who has not finished.
The link carries that person's participant ID and exactly which recordings are still needed (`?add=<id>&n=<name>&r=<rounds>&p=<words>&m=<missing, base 36>`; see `src/lib/resume.ts`), so it works on any device,
shows only what is missing, and never overwrites progress already saved on that device. Making a link also sets `speakers.extended_until` (service key only, see
`supabase/migrations/20261025_speaker_window_extension.sql`) so the 3-day upload window is open again for 3 more days. The public site cannot set that column.

Anyone can also carry on from a new device or browser on their own: the first page has **Carry on where you left off**, which takes the participant ID from their thank-you page (it is also in the Trainer's participant panel).
The site asks the database function `public.my_progress(id)` what that one ID has recorded (`supabase/migrations/20261025_my_progress_lookup.sql`); it answers only for an exact, random 36-character ID and cannot list or search anyone.

## Collect data

Share the link. Add `?c=<tag>` to tell groups apart (e.g. `https://<user>.github.io/speech-collector/?c=cs-class`); the tag is stored with each participant.

```bash
export SUPABASE_SERVICE_KEY=...        # Supabase dashboard -> Project settings -> API keys -> secret key
python3 scripts/collector_admin.py summary
python3 scripts/collector_admin.py download --out ~/collector_data --skip-flagged
```

`download` produces `<out>/<Label>/s<speaker>_<round>.wav` plus `manifest.csv` and `speakers.csv`. In the Trainer's **Dataset** page add `<out>` as a source;
the file names match its `speaker_take` pattern, so each participant is one speaker and the train/validation/test split keeps every person on one side.
Map the folder names (`A`…`H`, `One`…`Eight`) to your classes in the label editor.

Withdrawal request: `python3 scripts/collector_admin.py withdraw <participant-id> --yes` deletes the person's files and rows.
`prune-orphans` removes stored files whose participant row no longer exists (for example after manual clean-up).

## Develop

```bash
npm install
npm run dev            # add ?sim=1 to use a synthetic input where no microphone exists (dev builds only)
npm test               # resampler, quality gate, endpointer, upload queue
npm run build
python3 tests/test_admin.py
```

Deploy: `./scripts/deploy.sh` builds, tests and pushes `dist/` to the `gh-pages` branch, which GitHub Pages serves.
(`deploy/pages.yml.example` is an Actions workflow that does the same on every push to `main`; to use it, run `gh auth refresh -s workflow`,
move it to `.github/workflows/pages.yml`, and switch Settings → Pages → Source to *GitHub Actions*.)

## Before sharing widely

* Get **ethics clearance** if your institution requires it, then set `ETHICS_REF` in `src/config.ts` (it is only displayed when non-empty) and review the consent text in `src/steps/Consent.tsx`, including the retention sentence.
* Supabase free plan: 1 GB storage (each take ≈ 40 KB, so ≈ 100 people × 80–160 takes ≈ 0.5 GB) and the project **pauses after about a week without activity**; open the dashboard to resume it before a collection drive.
* Participants must finish within 3 days of registering (the server rejects later uploads); the site tells them when a session has ended.
