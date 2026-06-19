import { parseArgs } from "node:util";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import dotenv from "dotenv";

const DEFAULT_KEYWORD = "review";
const DEFAULT_TOP = 10;
const MAX_CANDIDATE_MULTIPLIER = 10;
const MAX_CANDIDATES_CAP = 500;
const MAX_BODY_TEXT_LENGTH = 5000;
const DEFAULT_SEARCH_VARIANTS = ["body", "subject", "from"];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findUp(filename, startDir) {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, filename);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function resolveConfigPaths() {
  const envExamplePath = findUp(".env.example", process.cwd()) ?? findUp(".env.example", __dirname);
  const envPath = findUp(".env", process.cwd()) ?? findUp(".env", __dirname) ?? (envExamplePath ? path.join(path.dirname(envExamplePath), ".env") : path.join(process.cwd(), ".env"));

  return {
    envPath,
    envExamplePath: envExamplePath ?? path.join(path.dirname(envPath), ".env.example")
  };
}

const configPaths = resolveConfigPaths();
const envFile = existsSync(configPaths.envPath) ? configPaths.envPath : null;

if (envFile) {
  dotenv.config({ path: envFile });
}

function getConfigHelp() {
  return {
    envPath: configPaths.envPath,
    envExamplePath: configPaths.envExamplePath,
    suggestedPowerShellCopy: `Copy-Item \"${configPaths.envExamplePath}\" \"${configPaths.envPath}\"`,
    suggestedBashCopy: `cp \"${configPaths.envExamplePath}\" \"${configPaths.envPath}\"`
  };
}

function getArtifactPaths() {
  const rootDir = path.dirname(configPaths.envPath);
  const outputDir = path.join(rootDir, "search-results");
  return { rootDir, outputDir };
}

function normalizeKeywords(values) {
  const entries = (values ?? []).flatMap((value) => value.split(","));
  const cleaned = entries.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)] : [DEFAULT_KEYWORD];
}

function normalizeOptionalString(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeSince(value) {
  const normalized = normalizeOptionalString(value);

  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid --since value. Use a date string such as 2026-01-01.");
  }

  return normalized;
}

function normalizeTop(value) {
  if (value === undefined) {
    return DEFAULT_TOP;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid --top value. Use a positive integer such as 10.");
  }

  return parsed;
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      password: { type: "string" },
      keyword: { type: "string", multiple: true },
      from: { type: "string" },
      subject: { type: "string" },
      since: { type: "string" },
      top: { type: "string" }
    }
  });

  return {
    email: values.email?.trim() ?? process.env.GMAIL_EMAIL?.trim() ?? "",
    password: values.password?.replace(/\s+/g, "") ?? process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "") ?? "",
    keywords: normalizeKeywords(values.keyword),
    from: normalizeOptionalString(values.from),
    subject: normalizeOptionalString(values.subject),
    since: normalizeSince(values.since),
    top: normalizeTop(values.top)
  };
}

function createResult(overrides = {}) {
  return {
    ok: false,
    email: null,
    keywords: [DEFAULT_KEYWORD],
    filters: {
      from: null,
      subject: null,
      since: null
    },
    top: DEFAULT_TOP,
    config: getConfigHelp(),
    artifacts: null,
    searchesRun: [],
    matchedMessages: 0,
    processedMessages: 0,
    skippedMessages: [],
    messages: [],
    error: null,
    ...overrides
  };
}

function validateInputs({ email, password }) {
  if (!email) {
    throw new Error(`Missing Gmail email. Open ${configPaths.envPath} and set GMAIL_EMAIL, or pass --email.`);
  }

  if (!password) {
    throw new Error(`Missing Gmail App Password. Open ${configPaths.envPath} and set GMAIL_APP_PASSWORD, or pass --password.`);
  }
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function downloadSource(client, uid) {
  const download = await client.download(uid, undefined, { uid: true });
  const content = download?.content;

  if (Buffer.isBuffer(content)) {
    return content;
  }

  if (content instanceof Readable || typeof content?.[Symbol.asyncIterator] === "function") {
    return streamToBuffer(content);
  }

  throw new Error(`Unable to download raw source for UID ${uid}.`);
}

function cleanMessageText(parsedMessage) {
  if (parsedMessage.text) {
    return parsedMessage.text.replace(/\s+/g, " ").trim();
  }

  const html = parsedMessage.html || parsedMessage.textAsHtml || "";
  const $ = cheerio.load(html);

  return $.text().replace(/\s+/g, " ").trim();
}

function extractSignals(text, matchedKeywords) {
  const reviewMatch = text.match(/(?:review|feedback|comments?):\s*(.*)/i);
  const starMatch = text.match(/(\b[1-5](?:\.\d)?\s*\/\s*5\b|\b[1-5]\s*stars?\b)/i);
  const reviewerMatch = text.match(/(?:from|by)\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){0,3})/);
  const snippets = matchedKeywords
    .map((keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`.{0,80}${escaped}.{0,80}`, "i");
      return text.match(pattern)?.[0]?.trim() || null;
    })
    .filter(Boolean);

  return {
    reviewer: reviewerMatch?.[1]?.trim() || null,
    review: reviewMatch?.[1]?.trim() || null,
    rating: starMatch?.[1]?.trim() || null,
    snippets: [...new Set(snippets)].slice(0, 3)
  };
}

function getMatchedKeywords(text, subject, fromText, keywords) {
  const haystack = `${fromText} ${subject} ${text}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function messageMatchesFilters(parsedMessage, text, keywords, filters) {
  const subject = parsedMessage.subject || "";
  const fromText = parsedMessage.from?.text || "";
  const matchedKeywords = getMatchedKeywords(text, subject, fromText, keywords);

  if (matchedKeywords.length === 0) {
    return { matches: false, matchedKeywords };
  }

  if (filters.from && !fromText.toLowerCase().includes(filters.from.toLowerCase())) {
    return { matches: false, matchedKeywords };
  }

  if (filters.subject && !subject.toLowerCase().includes(filters.subject.toLowerCase())) {
    return { matches: false, matchedKeywords };
  }

  if (filters.since) {
    const messageDate = parsedMessage.date instanceof Date ? parsedMessage.date : null;
    const sinceDate = new Date(filters.since);

    if (!messageDate || messageDate < sinceDate) {
      return { matches: false, matchedKeywords };
    }
  }

  return { matches: true, matchedKeywords };
}

function buildPreview(text) {
  return text.slice(0, 280) || null;
}

function buildCleanBody(text) {
  if (!text) {
    return {
      bodyText: null,
      bodyTruncated: false
    };
  }

  return {
    bodyText: text.slice(0, MAX_BODY_TEXT_LENGTH),
    bodyTruncated: text.length > MAX_BODY_TEXT_LENGTH
  };
}

function buildCandidateLimit(top) {
  return Math.min(Math.max(top * MAX_CANDIDATE_MULTIPLIER, top), MAX_CANDIDATES_CAP);
}

function buildSearchVariants(keyword, filters) {
  if (filters.from && keyword.toLowerCase() === filters.from.toLowerCase()) {
    return ["from"];
  }

  if (keyword.includes("@")) {
    return ["from", "subject", "body"];
  }

  return DEFAULT_SEARCH_VARIANTS;
}

function buildSearchCriteria(keyword, filters, variant) {
  const criteria = { [variant]: keyword };

  if (filters.from) {
    criteria.from = filters.from;
  }

  if (filters.subject) {
    criteria.subject = filters.subject;
  }

  if (filters.since) {
    criteria.since = new Date(filters.since);
  }

  return criteria;
}

function getCurrentDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getTimestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatSearchMarkdown(result) {
  const lines = [];
  lines.push("# Gmail Search Result");
  lines.push("");
  lines.push(`- Status: ${result.ok ? "ok" : "error"}`);
  lines.push(`- Email: ${result.email || "unknown"}`);
  lines.push(`- Top: ${result.top}`);
  lines.push(`- Grounded today: ${result.queryContext?.groundedToday || "unknown"}`);
  lines.push(`- Effective since: ${result.queryContext?.effectiveSince || "none"}`);
  lines.push(`- Keywords: ${result.keywords.join(", ")}`);
  lines.push(`- From filter: ${result.filters?.from || "none"}`);
  lines.push(`- Subject filter: ${result.filters?.subject || "none"}`);
  lines.push(`- Candidate limit: ${result.queryContext?.candidateLimit || 0}`);
  lines.push(`- Matched candidate messages: ${result.matchedMessages}`);
  lines.push(`- Downloaded/processed messages: ${result.processedMessages}`);
  lines.push(`- Returned messages: ${result.messages.length}`);
  lines.push(`- Skipped messages: ${result.skippedMessages.length}`);
  lines.push("");

  if (result.error) {
    lines.push("## Error");
    lines.push("");
    lines.push(result.error.message);
    lines.push("");
  }

  lines.push("## Searches Run");
  lines.push("");
  for (const search of result.searchesRun) {
    const variant = search.variant ? ` (${search.variant})` : "";
    lines.push(`- ${search.keyword}${variant}: ${search.matches} matches`);
  }
  lines.push("");

  lines.push("## Messages");
  lines.push("");
  if (result.messages.length === 0) {
    lines.push("No matching messages returned.");
  }

  for (const message of result.messages) {
    lines.push(`### ${message.cleanSubject || message.subject || "(no subject)"}`);
    lines.push("");
    lines.push(`- From: ${message.from || "unknown"}`);
    lines.push(`- Date: ${message.date || "unknown"}`);
    lines.push(`- Matched keywords: ${(message.matchedKeywords || []).join(", ") || "none"}`);
    lines.push("");
    if (message.bodyText) {
      lines.push(message.bodyText);
      lines.push("");
    }
  }

  if (result.skippedMessages.length > 0) {
    lines.push("## Skipped Messages");
    lines.push("");
    for (const skipped of result.skippedMessages) {
      lines.push(`- UID ${skipped.uid}: ${skipped.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function persistResultArtifacts(result) {
  const { outputDir } = getArtifactPaths();
  const timestamp = getTimestampLabel();
  const runJsonPath = path.join(outputDir, `${timestamp}.json`);
  const runMarkdownPath = path.join(outputDir, `${timestamp}.md`);
  const latestJsonPath = path.join(outputDir, "latest.json");
  const latestMarkdownPath = path.join(outputDir, "latest.md");

  await mkdir(outputDir, { recursive: true });

  const artifacts = {
    outputDir,
    runJsonPath,
    runMarkdownPath,
    latestJsonPath,
    latestMarkdownPath
  };

  const persistedResult = {
    ...result,
    artifacts
  };

  const markdown = formatSearchMarkdown(persistedResult);

  await writeFile(runJsonPath, `${JSON.stringify(persistedResult, null, 2)}\n`, "utf8");
  await writeFile(latestJsonPath, `${JSON.stringify(persistedResult, null, 2)}\n`, "utf8");
  await writeFile(runMarkdownPath, markdown, "utf8");
  await writeFile(latestMarkdownPath, markdown, "utf8");

  return artifacts;
}

async function scourInbox({ email, password, keywords, from, subject, since, top }) {
  validateInputs({ email, password });

  const filters = { from, subject, since };
  const candidateLimit = buildCandidateLimit(top);
  const groundedToday = getCurrentDateString();

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    logger: false,
    auth: {
      user: email,
      pass: password.replace(/\s+/g, "")
    }
  });

  client.on("error", () => {});

  const result = createResult({
    email,
    keywords,
    filters,
    top,
    queryContext: {
      groundedToday,
      effectiveSince: since,
      candidateLimit
    }
  });

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX");

    const searchMap = new Map();

    for (const keyword of keywords) {
      const variants = buildSearchVariants(keyword, filters);

      for (const variant of variants) {
        const criteria = buildSearchCriteria(keyword, filters, variant);
        const matchingUids = await client.search(criteria);
        result.searchesRun.push({ keyword, variant, criteria: { ...filters }, matches: matchingUids.length });

        for (const uid of matchingUids) {
          const entry = searchMap.get(uid) ?? { uid, matchedKeywords: new Set() };
          entry.matchedKeywords.add(keyword);
          searchMap.set(uid, entry);
        }
      }
    }

    const directCandidates = [...searchMap.values()]
      .sort((first, second) => second.uid - first.uid)
      .slice(0, candidateLimit);

    result.matchedMessages = searchMap.size;
    result.processedMessages = 0;

    const processEntries = async (entries) => {
      for (const entry of entries) {
        result.processedMessages += 1;
        try {
          const source = await downloadSource(client, entry.uid);
          const parsedMessage = await simpleParser(source);
          const text = cleanMessageText(parsedMessage);
          const subject = parsedMessage.subject || "";
          const { matches, matchedKeywords } = messageMatchesFilters(parsedMessage, text, keywords, filters);

          if (!matches) {
            continue;
          }

          const extracted = extractSignals(text, matchedKeywords);
          const { bodyText, bodyTruncated } = buildCleanBody(text);

          result.messages.push({
            uid: entry.uid,
            subject: subject || null,
            cleanSubject: subject.trim() || null,
            from: parsedMessage.from?.text || null,
            date: parsedMessage.date?.toISOString() || null,
            matchedKeywords,
            preview: buildPreview(text),
            bodyText,
            bodyTruncated,
            reviewer: extracted.reviewer,
            review: extracted.review,
            rating: extracted.rating,
            snippets: extracted.snippets
          });
        } catch (error) {
          result.skippedMessages.push({
            uid: entry.uid,
            message: error instanceof Error ? error.message : String(error)
          });
          continue;
        }

        if (result.messages.length >= top) {
          return true;
        }
      }

      return false;
    };

    const filledFromDirect = await processEntries(directCandidates);

    if (!filledFromDirect && result.messages.length < top) {
      const startSequence = Math.max(1, mailbox.exists - candidateLimit + 1);
      const recentSequenceRange = `${startSequence}:*`;
      const recentFallback = [];

      for await (const message of client.fetch(recentSequenceRange, { uid: true })) {
        if (!message.uid) {
          continue;
        }

        if (searchMap.has(message.uid)) {
          continue;
        }

        recentFallback.push({ uid: message.uid, matchedKeywords: new Set() });
      }

      result.searchesRun.push({
        keyword: "__recent_fallback__",
        variant: "sequence-window",
        criteria: {
          from: null,
          subject: null,
          since: filters.since
        },
        matches: mailbox.exists,
        inspectedRange: recentSequenceRange
      });

      await processEntries(recentFallback);
    }

    result.ok = true;
    return result;
  } finally {
    if (client.usable) {
      await client.logout();
    } else {
      client.close();
    }
  }
}

async function main() {
  let args = {
    email: process.env.GMAIL_EMAIL?.trim() ?? null,
    password: null,
    keywords: [DEFAULT_KEYWORD],
    from: null,
    subject: null,
    since: null,
    top: DEFAULT_TOP
  };

  try {
    args = parseCliArgs();
    const result = await scourInbox(args);
    result.artifacts = await persistResultArtifacts(result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error?.responseText || (error instanceof Error ? error.message : String(error));
    const result = createResult({
      email: args.email || null,
      keywords: args.keywords,
      filters: {
        from: args.from,
        subject: args.subject,
        since: args.since
      },
      top: args.top,
      queryContext: {
        groundedToday: getCurrentDateString(),
        effectiveSince: args.since,
        candidateLimit: buildCandidateLimit(args.top)
      },
      error: {
        message
      }
    });

    result.artifacts = await persistResultArtifacts(result);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

main();