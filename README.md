# gmail-reviewer

`gmail-reviewer` is a Node.js Gmail IMAP search tool for task-driven inbox triage.

It connects to Gmail with an App Password, searches the inbox with repeated keyword filters, and returns structured JSON for the most relevant matching emails.

## Features

- Gmail IMAP search with `imapflow`
- `.env`-based credential loading
- repeated `--keyword` flags
- default top-k limiting with optional `--top`
- optional `--from`, `--subject`, and `--since` filters
- post-fetch filtering against sender, subject, and body text
- sender-address-aware keyword matching
- clean `subject`, `cleanSubject`, and `bodyText` fields for message analysis
- resilient per-message error handling with `skippedMessages`
- persistent Markdown and JSON search artifacts in `search-results/`
- optional Gmail SMTP sending with explicit recipient, subject, body, and dry-run support

## Requirements

- Node.js installed on the host
- Gmail IMAP enabled for the account
- A Gmail App Password

## Setup

Install dependencies:

```bash
npm install
```

Create a local config file from the example:

```bash
cp .env.example .env
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
```

Then open [`.env`](.env) and fill in:

```env
GMAIL_EMAIL=your@gmail.com
GMAIL_APP_PASSWORD=your16digitapppassword
```

## Usage

Run the extractor directly:

```bash
node scripts/scour.js --top 10 --keyword "invoice" --keyword "receipt"
```

Add optional filters when useful:

```bash
node scripts/scour.js \
  --top 5 \
  --keyword "invoice" \
  --keyword "payment" \
  --keyword "receipt" \
  --from "billing" \
  --since "2026-01-01"
```

Send an email explicitly when needed:

```bash
node scripts/scour.js \
  --top 5 \
  --keyword "customer" \
  --send-to "customer@example.com" \
  --send-subject "Quick request" \
  --send-body "Thanks for working with us. Would you be open to leaving a review?"
```

Preview the send action without sending mail:

```bash
node scripts/scour.js \
  --top 1 \
  --keyword "customer" \
  --send-to "customer@example.com" \
  --send-subject "Quick request" \
  --send-body "Thanks for working with us. Would you be open to leaving a review?" \
  --dry-run-send
```

The script returns structured JSON with fields such as:

- `keywords`
- `filters`
- `top`
- `searchesRun`
- `matchedMessages`
- `processedMessages`
- `skippedMessages`
- `messages`
- `emailActions`
- `artifacts`

Each message includes clean, readable fields such as `subject`, `cleanSubject`, `preview`, and `bodyText` so downstream agents can analyze the actual content.

Each run also writes:

- `search-results/latest.md`
- `search-results/latest.json`
- timestamped history files in `search-results/`

## Search Tips

- Prefer a mixed keyword set for focused searches: topic terms, sender fragments, subject clues, and workflow terms.
- If a strict `--subject` filter yields no useful matches, relax it before widening everything else.
- Broad terms like `application`, `update`, or `interview` are noisy unless paired with stronger contextual clues.
- Keywords are matched against sender address/text, subject, and extracted body text.
- Only send emails with explicit recipient, subject, and body flags. Use `--dry-run-send` before real outreach when validating a workflow.

## Notes

- Credentials are loaded from the nearest `.env` file the script can find.
- Missing or malformed config returns structured JSON with exact file paths and suggested copy commands.
- Search artifacts are local runtime output and should not be committed.
- Sent email attempts are recorded in the JSON and Markdown artifacts under `emailActions`.
