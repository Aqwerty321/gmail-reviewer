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
5. If the user does not know how to create a Gmail App Password, explicitly guide them to Google's App Password page: `https://myaccount.google.com/apppasswords`.
6. Tell the user they may need to sign in and enable 2-Step Verification first. Then tell them to create a new app password, give it any descriptive app name they like, copy the generated 16-character password, and paste that value into `GMAIL_APP_PASSWORD` in `.env` without extra spaces.
7. If credentials are still missing or malformed, stop the search, show the user the exact `.env` and `.env.example` paths, and tell them what value is missing.
8. The extractor sanitizes whitespace in the configured App Password automatically.
9. Ground relative dates before searching. Convert requests like "past week", "last month", or "since yesterday" into an explicit `YYYY-MM-DD` value using the current date at runtime, and pass that absolute date through `--since`.
10. Translate the user's task into a search plan. Choose 2-6 likely inbox keywords or short phrases, and infer optional `from`, `subject`, and `since` filters when the request suggests them. Be proactive about asking concise follow-up questions when sender, date range, recipient, tone, or desired action is unclear.
11. For company or recruiter hunts, prefer a mixed keyword set: company name, domain variant, sender-address fragment, and one or two workflow terms. Example: `toolhouse`, `toolhouseai`, `toolhouse.ai`, `@toolhouseai.com`, `interview`, `application`.
12. Always use a result limit. The extractor defaults to `--top 10` when not specified, but set `--top` explicitly when the task calls for a different number of matches.
13. Run the extractor from this folder with the inferred filters. Credentials should come from `.env` by default:
   `node scripts/scour.js --top 10 --keyword "invoice" --keyword "receipt" --from "billing@example.com" --subject "payment" --since "2026-01-01"`
14. If the user asks to send an email, draft it in natural, proper human language with a warm and welcoming tone unless the user asks for a different style. Keep the wording flexible to the user's goal, relationship with the recipient, and requested level of formality.
15. Before sending, show the user a clear preview containing the recipient list, subject, and full body. Ask whether they want to send it as-is or refine it further. Do not send until the user explicitly approves the preview.
16. After approval, send with `--send-to`, `--send-subject`, and `--send-body`; use `--dry-run-send` when validating a workflow without sending.
17. For review-request outreach, keep it generic: search for the target customers, decide recipients from verified message context or user-provided addresses, draft a warm request, preview it for the user, then send only after approval.
18. Review the JSON output. Each returned result includes `queryContext.groundedToday` and `queryContext.effectiveSince` for date grounding, plus clean `subject`, `cleanSubject`, and normalized `bodyText` so the agent can analyze and summarize the actual message contents instead of only a snippet. Sent email attempts are recorded under `emailActions`.
19. Read the persisted Markdown summary at `search-results/latest.md` for a human-friendly view, or `search-results/latest.json` for structured automation. The script also writes timestamped history files in the same folder.
20. After reading `search-results/latest.md` or `search-results/latest.json`, you must summarize the findings back to the user in chat. Do not stop at writing files only.
21. If the first pass is too broad or too narrow, refine keywords and filters, then rerun the extractor.
22. Repeat the search loop until the returned messages fit the user's task.
23. Summarize the matching emails clearly for the user, using the clean subject and body text fields.

## Communication Style
- Use natural, proper human language in user-facing summaries and drafted emails.
- Default to a warm, welcoming tone, while adapting to the user's requested style, context, and recipient relationship.
- Ask helpful follow-up questions proactively instead of guessing important details.
- For outbound email, always run a preview loop: show the draft, ask whether to send or refine, and only send after explicit approval.

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
- Search results are persisted locally under `search-results/` as both Markdown and JSON, with `latest.*` pointers for the most recent run.
- Persisting results to files is not sufficient by itself; the agent must read the latest result file and report the findings to the user.
- Optional outbound email is supported through Gmail SMTP with `--send-to`, `--send-subject`, `--send-body`, `--send-from-name`, and `--dry-run-send`.
- Never send outreach silently. The agent must obtain explicit user approval for recipients and copy before sending.
- The user must be allowed to choose either "send it" or "refine it further" after seeing the draft preview.
- The agent is expected to generate and refine keyword, sender, subject, and date filters interactively from the user's request rather than relying on `.env` for those values.
- The agent should handhold setup: create `.env` from `.env.example` when missing, point the user at the exact file path, and pause until the user fills credentials locally.
- The agent should also handhold Gmail App Password setup when needed by pointing the user to `https://myaccount.google.com/apppasswords` and explaining the short creation flow.
- The script loads credentials from the nearest `.env` file it can find, and prints structured JSON to stdout for both success and failure cases.
- The extraction backend is [scripts/scour.js](./scripts/scour.js).