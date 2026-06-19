import { parseArgs } from "node:util";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import dotenv from "dotenv";

const DEFAULT_KEYWORD = "review";
const MAX_RESULTS = 20;
const MAX_CANDIDATES = 200;
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

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      password: { type: "string" },
      keyword: { type: "string", multiple: true },
      from: { type: "string" },
      subject: { type: "string" },
      since: { type: "string" }
    }
  });

  return {
    email: values.email?.trim() ?? process.env.GMAIL_EMAIL?.trim() ?? "",
    password: values.password?.replace(/\s+/g, "") ?? process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "") ?? "",
    keywords: normalizeKeywords(values.keyword),
    from: normalizeOptionalString(values.from),
    subject: normalizeOptionalString(values.subject),
    since: normalizeSince(values.since)
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
    config: getConfigHelp(),
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
  const html = parsedMessage.html || parsedMessage.textAsHtml || parsedMessage.text || "";
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

function buildSearchCriteria(keyword, filters) {
  const criteria = { body: keyword };

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

async function scourInbox({ email, password, keywords, from, subject, since }) {
  validateInputs({ email, password });

  const filters = { from, subject, since };

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

  const result = createResult({ email, keywords, filters });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    const searchMap = new Map();

    for (const keyword of keywords) {
      const criteria = buildSearchCriteria(keyword, filters);
      const matchingUids = await client.search(criteria);
      result.searchesRun.push({ keyword, criteria: { ...filters }, matches: matchingUids.length });

      for (const uid of matchingUids) {
        const entry = searchMap.get(uid) ?? { uid, matchedKeywords: new Set() };
        entry.matchedKeywords.add(keyword);
        searchMap.set(uid, entry);
      }
    }

    const recentUids = [...searchMap.values()]
      .sort((first, second) => second.uid - first.uid)
      .slice(0, MAX_CANDIDATES);

    result.matchedMessages = searchMap.size;
    result.processedMessages = 0;

    for (const entry of recentUids) {
      result.processedMessages += 1;
      try {
        const source = await downloadSource(client, entry.uid);
        const parsedMessage = await simpleParser(source);
        const text = cleanMessageText(parsedMessage);
        const subject = parsedMessage.subject || "";
        const { matches, matchedKeywords } = messageMatchesFilters(parsedMessage, text, [...entry.matchedKeywords], filters);

        if (!matches) {
          continue;
        }

        const extracted = extractSignals(text, matchedKeywords);

        result.messages.push({
          uid: entry.uid,
          subject: subject || null,
          from: parsedMessage.from?.text || null,
          date: parsedMessage.date?.toISOString() || null,
          matchedKeywords,
          preview: buildPreview(text),
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

      if (result.messages.length >= MAX_RESULTS) {
        break;
      }
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
    since: null
  };

  try {
    args = parseCliArgs();
    const result = await scourInbox(args);
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
      error: {
        message
      }
    });

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

main();