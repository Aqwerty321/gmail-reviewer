---
name: gmail-reviewer
description: 'Scour a Gmail inbox for task-specific emails. Use when you need to authenticate with a Gmail address and App Password from .env, generate keyword filters for a user task, run repeated inbox searches, and extract matching emails as JSON.'
argument-hint: '[task or keywords]'
---

# Gmail Reviewer

Use this skill to connect to Gmail over IMAP, generate task-specific keyword filters, run repeated searches against the inbox, and extract the most relevant matching messages.

## When To Use
- The user wants Gmail searched for a specific kind of message, topic, sender pattern, company, recruiter flow, or workflow artifact
- The workspace already has Gmail credentials configured in `.env`
- You need structured JSON output for downstream summarization or analysis

## Procedure
1. Verify dependencies in this skill folder:
   `npm install`
2. Ensure the workspace `.env` file exists and contains only `GMAIL_EMAIL` and `GMAIL_APP_PASSWORD`.
3. If `.env` is missing, automatically create it from `.env.example` using the host-appropriate equivalent of copying the file, for example `Copy-Item .env.example .env` in PowerShell or `cp .env.example .env` in bash.
4. After creating `.env`, tell the user the exact `.env` path in their workspace and explicitly ask them to open it on their machine and fill in `GMAIL_EMAIL` and `GMAIL_APP_PASSWORD` before continuing.
5. If credentials are still missing or malformed, stop the search, show the user the exact `.env` and `.env.example` paths, and tell them what value is missing.
6. The extractor sanitizes whitespace in the configured App Password automatically.
7. Ground relative dates before searching. Convert requests like "past week", "last month", or "since yesterday" into an explicit `YYYY-MM-DD` value using the current date at runtime, and pass that absolute date through `--since`.
8. Translate the user's task into a search plan. Choose 2-6 likely inbox keywords or short phrases, and infer optional `from`, `subject`, and `since` filters when the request suggests them. If those constraints would help but are not clear, ask the user a brief follow-up before running the search.
9. For company or recruiter hunts, prefer a mixed keyword set: company name, domain variant, sender-address fragment, and one or two workflow terms. Example: `toolhouse`, `toolhouseai`, `toolhouse.ai`, `@toolhouseai.com`, `interview`, `application`.
10. Always use a result limit. The extractor defaults to `--top 10` when not specified, but set `--top` explicitly when the task calls for a different number of matches.
11. Run the extractor from this folder with the inferred filters. Credentials should come from `.env` by default:
   `node scripts/scour.js --top 10 --keyword "invoice" --keyword "receipt" --from "billing@example.com" --subject "payment" --since "2026-01-01"`
12. Review the JSON output. Each returned result includes `queryContext.groundedToday` and `queryContext.effectiveSince` for date grounding, plus clean `subject`, `cleanSubject`, and normalized `bodyText` so the agent can analyze and summarize the actual message contents instead of only a snippet. If the first pass is too broad or too narrow, refine keywords and filters, then rerun the extractor.
13. Repeat the search loop until the returned messages fit the user's task.
14. Summarize the matching emails clearly for the user, using the clean subject and body text fields.

## Learned Tactics
- IMAP body searches are noisy, so trust the extractor's post-fetch filtering more than raw match counts.
- Company-name hunts often work better when keywords can match sender addresses as well as subject/body text.
- If an exact subject filter returns zero true matches, relax the subject constraint before broadening everything else.
- Broad hiring terms like `application` and `interview` create heavy noise; pair them with company-specific keywords or sender clues whenever possible.
- Domain-style keywords such as `toolhouse.ai` or `@toolhouseai.com` can outperform plain company names when the sender address is the strongest clue.
- When the inbox is large, inspect a deeper recent candidate window before concluding there are no matches.

## Notes
- The extractor supports repeated `--keyword` flags and unions the matches across searches.
- Each keyword is searched across message body, subject, and sender fields before post-fetch filtering is applied.
- The extractor defaults to the top 10 matching results unless `--top` is specified.
- The agent is expected to generate and refine keyword, sender, subject, and date filters interactively from the user's request rather than relying on `.env` for those values.
- The agent should handhold setup: create `.env` from `.env.example` when missing, point the user at the exact file path, and pause until the user fills credentials locally.
- The script loads credentials from the nearest `.env` file it can find, and prints structured JSON to stdout for both success and failure cases.
- The extraction backend is [scripts/scour.js](./scripts/scour.js).