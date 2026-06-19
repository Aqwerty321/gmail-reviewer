# gmail-reviewer

`gmail-reviewer` is a Node.js Gmail IMAP search tool plus a workspace-local VS Code skill for agent-driven inbox triage.

It connects to Gmail with an App Password, searches the inbox with repeated keyword filters, and returns structured JSON for the most relevant matching emails.

## Features

- Gmail IMAP search with `imapflow`
- `.env`-based credential loading
- repeated `--keyword` flags
- optional `--from`, `--subject`, and `--since` filters
- post-fetch filtering against sender, subject, and body text
- sender-address-aware keyword matching
- resilient per-message error handling with `skippedMessages`

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
node scripts/scour.js --keyword "invoice" --keyword "receipt"
```

Add optional filters when useful:

```bash
node scripts/scour.js \
  --keyword "toolhouse" \
  --keyword "toolhouse.ai" \
  --keyword "interview" \
  --from "toolhouse" \
  --since "2026-01-01"
```

The script returns structured JSON with fields such as:

- `keywords`
- `filters`
- `searchesRun`
- `matchedMessages`
- `processedMessages`
- `skippedMessages`
- `messages`

## Search Tips

- Prefer a mixed keyword set for company hunts: company name, domain variant, sender fragment, and workflow terms.
- If a strict `--subject` filter yields no useful matches, relax it before widening everything else.
- Broad terms like `application` and `interview` are noisy unless paired with company-specific clues.
- Keywords are matched against sender address/text, subject, and extracted body text.

## VS Code Skill

A workspace-local skill lives at [`.github/skills/gmail-reviewer/SKILL.md`](.github/skills/gmail-reviewer/SKILL.md).

That skill is intended for local use inside VS Code and is ignored by git through [`.gitignore`](.gitignore), along with local secrets in [`.env`](.env).

## Notes

- Credentials are loaded from the nearest `.env` file the script can find.
- Missing or malformed config returns structured JSON with exact file paths and suggested copy commands.
- The local skill and the root script are kept in sync in this workspace.