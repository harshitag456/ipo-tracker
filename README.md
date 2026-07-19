# Issue Board — Indian IPO Tracker

A static, data-driven IPO tracker. The site is one HTML file that renders whatever is in `data/ipos.json`. Updating the website = updating that JSON, either by hand or via the scheduled fetcher.

```
ipo-tracker/
├── index.html                     # the entire site (fetches data/ipos.json)
├── data/ipos.json                 # single source of truth (currently sample data)
├── scripts/fetch-ipos.mjs         # pulls live data from NSE, rewrites the JSON
└── .github/workflows/update-ipos.yml  # cron: fetch + commit every 30 min in market hours
```

## 1. Run it locally

```bash
cd ipo-tracker
npx serve            # or: python3 -m http.server 8000
```

Open the served URL. You'll see the board with sample data. (Opening index.html directly with file:// won't work — fetch() needs a server.)

## 2. Wire up real data

```bash
node scripts/fetch-ipos.mjs      # Node 18+
```

This does a cookie handshake with nseindia.com, hits `/api/ipo-current-issue` and `/api/all-upcoming-issues?category=ipo`, maps the response, and rewrites `data/ipos.json`.

Things to know:

- The endpoints are undocumented. Hit them once in your browser DevTools, look at the real field names, and adjust `mapIssue()` — that function is the only mapping layer.
- NSE sometimes blocks cloud/datacenter IPs. If the GitHub Action gets 403s, run the script on your machine or a small VPS via cron instead, and have it push to the repo.
- NSE doesn't publish GMP or category-wise subscription in these endpoints. Two options:
  - Maintain `data/overrides.json` by hand — keyed by IPO id, merged over fetched data:
    ```json
    { "meridian-foods-ltd": { "gmp": 42, "allotmentDate": "2026-07-22" } }
    ```
  - Or add a second fetcher for an aggregator (Chittorgarh, InvestorGain) — read their ToS, cache aggressively, identify your bot honestly.
- If the site grows, swap in a paid API (e.g. indianapi.in's IPO API) — only `fetch-ipos.mjs` changes; the site and JSON schema stay put.

## 3. Deploy (free)

Push the folder to a GitHub repo, then either:

- **GitHub Pages**: Settings → Pages → deploy from `main`. Done — every commit to `data/ipos.json` updates the live site.
- **Vercel / Netlify**: import the repo, framework = "Other", no build step. Same effect.

## 4. Automate updates

The included workflow (`.github/workflows/update-ipos.yml`) runs the fetcher every 30 minutes during Indian market hours and commits the JSON only when it changed. Enable it by pushing the repo and confirming Actions are allowed (Settings → Actions → workflow permissions → read & write).

Manual refresh anytime: Actions tab → "Refresh IPO data" → Run workflow. Or just edit `data/ipos.json` in the GitHub UI — that alone updates the site.

## 5. Data schema

Each entry in `ipos[]`:

| field | type | notes |
|---|---|---|
| id | string | slug, stable key for overrides |
| company, sector, exchange | string | |
| board | "Mainboard" \| "SME" | |
| status | "open" \| "upcoming" \| "listed" | drives the tabs |
| priceBand | {min, max} | ₹ |
| lotSize | number | shares per lot |
| issueSizeCr | number | ₹ crore |
| openDate…listingDate | "YYYY-MM-DD" | |
| gmp | number \| null | ₹ premium, unofficial |
| subscription | {qib, nii, retail, total} \| null | times subscribed |
| listing | {issuePrice, listPrice, gainPct} | only for status "listed" |

## 6. Where to take it next

- **Countdown chips** ("closes in 1d 4h") — pure frontend, computed from closeDate.
- **Per-IPO detail pages** — generate `/ipo/<id>.html` from the same JSON, good for SEO.
- **Category-wise subscription** — BSE publishes it on their IPO pages; add a BSE fetcher.
- **Historical listing-gain table** — append listed IPOs to a `data/history.json` instead of dropping them.
- **Compliance note**: keep the "not investment advice" footer, label GMP as unofficial, and don't reproduce aggregator content verbatim.
