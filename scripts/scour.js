import { parseArgs } from "node:util";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import nodemailer from "nodemailer";

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
  const sentEmailDir = path.join(rootDir, "sent-emails");
  const contactsDir = path.join(rootDir, "interaction-contacts");
  return { rootDir, outputDir, sentEmailDir, contactsDir };
}

function normalizeKeywords(values) {
  const entries = (values ?? []).flatMap((value) => value.split(","));
  const cleaned = entries.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)] : [DEFAULT_KEYWORD];
}

function normalizeRecipients(values) {
  const entries = (values ?? []).flatMap((value) => value.split(","));
  return [...new Set(entries.map((value) => value.trim()).filter(Boolean))];
}

function normalizeTrackedSenders(values) {
  const envEntries = process.env.TRACKED_SENDERS ? process.env.TRACKED_SENDERS.split(",") : [];
  const entries = [...(values ?? []), ...envEntries].flatMap((value) => value.split(","));
  return [...new Set(entries.map((value) => value.trim()).filter(Boolean))];
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
      top: { type: "string" },
      "send-to": { type: "string", multiple: true },
      "send-subject": { type: "string" },
      "send-body": { type: "string" },
      "send-from-name": { type: "string" },
      "dry-run-send": { type: "boolean" },
      "tracked-sender": { type: "string", multiple: true }
    }
  });

  return {
    email: values.email?.trim() ?? process.env.GMAIL_EMAIL?.trim() ?? "",
    password: values.password?.replace(/\s+/g, "") ?? process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "") ?? "",
    keywords: normalizeKeywords(values.keyword),
    from: normalizeOptionalString(values.from),
    subject: normalizeOptionalString(values.subject),
    since: normalizeSince(values.since),
    top: normalizeTop(values.top),
    trackedSenders: normalizeTrackedSenders(values["tracked-sender"]),
    send: {
      to: normalizeRecipients(values["send-to"]),
      subject: normalizeOptionalString(values["send-subject"]),
      body: normalizeOptionalString(values["send-body"]),
      fromName: normalizeOptionalString(values["send-from-name"]),
      dryRun: Boolean(values["dry-run-send"])
    }
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
      since: null,
      trackedSenders: []
    },
    top: DEFAULT_TOP,
    config: getConfigHelp(),
    artifacts: null,
    searchesRun: [],
    matchedMessages: 0,
    processedMessages: 0,
    skippedMessages: [],
    messages: [],
    emailActions: {
      requested: false,
      dryRun: false,
      sent: [],
      failed: []
    },
    sentEmailInteractions: [],
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

function validateSendRequest(send) {
  if (!send || send.to.length === 0) {
    return;
  }

  if (!send.subject) {
    throw new Error("Missing --send-subject for requested outbound email.");
  }

  if (!send.body) {
    throw new Error("Missing --send-body for requested outbound email.");
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

function getAddressText(addressGroup) {
  return addressGroup?.text || "";
}

function getAttachmentMetadata(parsedMessage) {
  return (parsedMessage.attachments || []).map((attachment) => ({
    filename: attachment.filename || null,
    contentType: attachment.contentType || null,
    size: attachment.size || null,
    contentId: attachment.contentId || null
  }));
}

function getMessageSearchText(parsedMessage, text) {
  const attachmentText = getAttachmentMetadata(parsedMessage)
    .map((attachment) => `${attachment.filename || ""} ${attachment.contentType || ""}`)
    .join(" ");

  return [
    getAddressText(parsedMessage.from),
    getAddressText(parsedMessage.to),
    getAddressText(parsedMessage.cc),
    getAddressText(parsedMessage.bcc),
    parsedMessage.subject || "",
    attachmentText,
    text
  ].join(" ");
}

function getMatchedKeywords(searchText, keywords) {
  const haystack = searchText.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function getMatchedTrackedSenders(searchText, trackedSenders) {
  const haystack = searchText.toLowerCase();
  return trackedSenders.filter((sender) => haystack.includes(sender.toLowerCase()));
}

function messageMatchesFilters(parsedMessage, text, keywords, filters) {
  const subject = parsedMessage.subject || "";
  const fromText = parsedMessage.from?.text || "";
  const searchText = getMessageSearchText(parsedMessage, text);
  const matchedKeywords = getMatchedKeywords(searchText, keywords);
  const matchedTrackedSenders = getMatchedTrackedSenders(searchText, filters.trackedSenders || []);

  if (matchedKeywords.length === 0 && matchedTrackedSenders.length === 0) {
    return { matches: false, matchedKeywords, matchedTrackedSenders };
  }

  if (filters.from && !fromText.toLowerCase().includes(filters.from.toLowerCase())) {
    return { matches: false, matchedKeywords, matchedTrackedSenders };
  }

  if (filters.subject && !subject.toLowerCase().includes(filters.subject.toLowerCase())) {
    return { matches: false, matchedKeywords, matchedTrackedSenders };
  }

  if (filters.since) {
    const messageDate = parsedMessage.date instanceof Date ? parsedMessage.date : null;
    const sinceDate = new Date(filters.since);

    if (!messageDate || messageDate < sinceDate) {
      return { matches: false, matchedKeywords, matchedTrackedSenders };
    }
  }

  return { matches: true, matchedKeywords, matchedTrackedSenders };
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

function buildSentEmailSearchText(record) {
  return [record.from, record.to, record.subject, record.body, record.status, record.messageId].filter(Boolean).join(" ");
}

async function findSentEmailInteractions({ keywords, trackedSenders }) {
  const { sentEmailDir } = getArtifactPaths();

  if (!existsSync(sentEmailDir)) {
    return [];
  }

  const entries = await readdir(sentEmailDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "latest.json")
    .map((entry) => path.join(sentEmailDir, entry.name));
  const matches = [];

  for (const filePath of jsonFiles) {
    try {
      const record = JSON.parse(await readFile(filePath, "utf8"));
      const searchText = buildSentEmailSearchText(record);
      const matchedKeywords = getMatchedKeywords(searchText, keywords);
      const matchedTrackedSenders = getMatchedTrackedSenders(searchText, trackedSenders);

      if (matchedKeywords.length === 0 && matchedTrackedSenders.length === 0) {
        continue;
      }

      matches.push({
        source: "sent-emails",
        filePath,
        timestamp: record.timestamp,
        status: record.status,
        dryRun: record.dryRun,
        from: record.from,
        to: record.to,
        subject: record.subject,
        body: record.body,
        messageId: record.messageId,
        matchedKeywords,
        matchedTrackedSenders
      });
    } catch {
      continue;
    }
  }

  return matches.sort((first, second) => new Date(second.timestamp) - new Date(first.timestamp)).slice(0, 25);
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

function formatFromAddress(email, fromName) {
  if (!fromName) {
    return email;
  }

  return `"${fromName.replace(/"/g, "'")}" <${email}>`;
}

function formatSentEmailMarkdown(record) {
  const lines = [];
  lines.push("# Sent Email Record");
  lines.push("");
  lines.push(`- Timestamp: ${record.timestamp}`);
  lines.push(`- Status: ${record.status}`);
  lines.push(`- Dry run: ${record.dryRun ? "yes" : "no"}`);
  lines.push(`- From: ${record.from}`);
  lines.push(`- To: ${record.to}`);
  lines.push(`- Subject: ${record.subject}`);
  lines.push(`- Message ID: ${record.messageId || "none"}`);

  if (record.error) {
    lines.push(`- Error: ${record.error}`);
  }

  lines.push("");
  lines.push("## Body");
  lines.push("");
  lines.push(record.body || "(empty)");
  lines.push("");

  return lines.join("\n");
}

function extractEmailAddresses(value) {
  if (!value) {
    return [];
  }

  return [...new Set(String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
}

function recordContact(contactMap, address, details) {
  if (!address) {
    return;
  }

  const normalized = address.toLowerCase();
  const current = contactMap.get(normalized) || {
    email: normalized,
    sources: [],
    roles: [],
    firstSeen: details.timestamp,
    lastSeen: details.timestamp,
    count: 0,
    samples: []
  };

  current.count += 1;
  current.firstSeen = current.firstSeen && current.firstSeen < details.timestamp ? current.firstSeen : details.timestamp;
  current.lastSeen = current.lastSeen && current.lastSeen > details.timestamp ? current.lastSeen : details.timestamp;

  if (details.source && !current.sources.includes(details.source)) {
    current.sources.push(details.source);
  }

  if (details.role && !current.roles.includes(details.role)) {
    current.roles.push(details.role);
  }

  current.samples = [
    {
      timestamp: details.timestamp,
      source: details.source,
      role: details.role,
      subject: details.subject || null,
      status: details.status || null
    },
    ...current.samples
  ].slice(0, 10);

  contactMap.set(normalized, current);
}

function collectContactsFromResult(result) {
  const contactMap = new Map();
  const now = new Date().toISOString();

  for (const trackedSender of result.filters?.trackedSenders || []) {
    for (const address of extractEmailAddresses(trackedSender)) {
      recordContact(contactMap, address, { timestamp: now, source: "tracked-sender", role: "tracked" });
    }
  }

  for (const message of result.messages || []) {
    const timestamp = message.date || now;
    const subject = message.cleanSubject || message.subject || null;

    for (const address of extractEmailAddresses(message.from)) {
      recordContact(contactMap, address, { timestamp, source: "gmail-message", role: "from", subject });
    }

    for (const address of extractEmailAddresses(message.to)) {
      recordContact(contactMap, address, { timestamp, source: "gmail-message", role: "to", subject });
    }

    for (const address of extractEmailAddresses(message.cc)) {
      recordContact(contactMap, address, { timestamp, source: "gmail-message", role: "cc", subject });
    }

    for (const address of extractEmailAddresses(message.bcc)) {
      recordContact(contactMap, address, { timestamp, source: "gmail-message", role: "bcc", subject });
    }
  }

  for (const interaction of result.sentEmailInteractions || []) {
    const timestamp = interaction.timestamp || now;
    const subject = interaction.subject || null;

    for (const address of extractEmailAddresses(interaction.from)) {
      recordContact(contactMap, address, { timestamp, source: "sent-email-ledger", role: "from", subject, status: interaction.status });
    }

    for (const address of extractEmailAddresses(interaction.to)) {
      recordContact(contactMap, address, { timestamp, source: "sent-email-ledger", role: "to", subject, status: interaction.status });
    }
  }

  for (const sent of result.emailActions?.sent || []) {
    for (const address of extractEmailAddresses(sent.to)) {
      recordContact(contactMap, address, { timestamp: now, source: "email-action", role: "to", subject: sent.subject, status: sent.status });
    }
  }

  for (const failed of result.emailActions?.failed || []) {
    for (const address of extractEmailAddresses(failed.to)) {
      recordContact(contactMap, address, { timestamp: now, source: "email-action", role: "to", subject: failed.subject, status: "failed" });
    }
  }

  return [...contactMap.values()].sort((first, second) => second.lastSeen.localeCompare(first.lastSeen));
}

function formatContactsMarkdown(contacts) {
  const lines = ["# Interaction Contacts", ""];

  if (contacts.length === 0) {
    lines.push("No contacts found in the latest run.");
    return `${lines.join("\n")}\n`;
  }

  for (const contact of contacts) {
    lines.push(`## ${contact.email}`);
    lines.push("");
    lines.push(`- Sources: ${contact.sources.join(", ") || "none"}`);
    lines.push(`- Roles: ${contact.roles.join(", ") || "none"}`);
    lines.push(`- First seen: ${contact.firstSeen}`);
    lines.push(`- Last seen: ${contact.lastSeen}`);
    lines.push(`- Interaction count in latest run: ${contact.count}`);
    lines.push("");

    for (const sample of contact.samples.slice(0, 3)) {
      lines.push(`- ${sample.timestamp} [${sample.source}/${sample.role}] ${sample.subject || "(no subject)"}`);
    }

    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function persistInteractionContacts(result) {
  const { contactsDir } = getArtifactPaths();
  const timestamp = getTimestampLabel();
  const contacts = collectContactsFromResult(result);
  const runJsonPath = path.join(contactsDir, `${timestamp}.json`);
  const runMarkdownPath = path.join(contactsDir, `${timestamp}.md`);
  const latestJsonPath = path.join(contactsDir, "latest.json");
  const latestMarkdownPath = path.join(contactsDir, "latest.md");

  await mkdir(contactsDir, { recursive: true });

  const payload = {
    generatedAt: new Date().toISOString(),
    contacts
  };
  const markdown = formatContactsMarkdown(contacts);

  await writeFile(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(runMarkdownPath, markdown, "utf8");
  await writeFile(latestMarkdownPath, markdown, "utf8");

  return {
    contactsDir,
    runJsonPath,
    runMarkdownPath,
    latestJsonPath,
    latestMarkdownPath,
    contactCount: contacts.length
  };
}

async function persistSentEmailRecord(record) {
  const { sentEmailDir } = getArtifactPaths();
  const timestamp = record.timestamp.replace(/[:.]/g, "-");
  const safeRecipient = record.to.replace(/[^a-z0-9@._-]/gi, "_");
  const baseName = `${timestamp}_${safeRecipient}`;
  const jsonPath = path.join(sentEmailDir, `${baseName}.json`);
  const markdownPath = path.join(sentEmailDir, `${baseName}.md`);
  const latestJsonPath = path.join(sentEmailDir, "latest.json");
  const latestMarkdownPath = path.join(sentEmailDir, "latest.md");

  await mkdir(sentEmailDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(latestJsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, formatSentEmailMarkdown(record), "utf8");
  await writeFile(latestMarkdownPath, formatSentEmailMarkdown(record), "utf8");

  return { jsonPath, markdownPath, latestJsonPath, latestMarkdownPath };
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
  lines.push(`- Tracked senders: ${(result.filters?.trackedSenders || []).join(", ") || "none"}`);
  lines.push(`- Candidate limit: ${result.queryContext?.candidateLimit || 0}`);
  lines.push(`- Matched candidate messages: ${result.matchedMessages}`);
  lines.push(`- Downloaded/processed messages: ${result.processedMessages}`);
  lines.push(`- Returned messages: ${result.messages.length}`);
  lines.push(`- Skipped messages: ${result.skippedMessages.length}`);
  lines.push(`- Emails requested: ${result.emailActions.requested ? "yes" : "no"}`);
  lines.push(`- Emails sent: ${result.emailActions.sent.length}`);
  lines.push(`- Email send failures: ${result.emailActions.failed.length}`);
  lines.push(`- Sent-email interaction matches: ${result.sentEmailInteractions.length}`);
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
    lines.push(`- To: ${message.to || "unknown"}`);
    lines.push(`- Date: ${message.date || "unknown"}`);
    lines.push(`- Matched keywords: ${(message.matchedKeywords || []).join(", ") || "none"}`);
    lines.push(`- Matched tracked senders: ${(message.matchedTrackedSenders || []).join(", ") || "none"}`);

    if (message.attachmentNames?.length > 0) {
      lines.push(`- Attachments: ${message.attachmentNames.join(", ")}`);
    }

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

  if (result.sentEmailInteractions.length > 0) {
    lines.push("## Sent Email Interactions");
    lines.push("");

    for (const interaction of result.sentEmailInteractions) {
      lines.push(`### ${interaction.subject || "(no subject)"}`);
      lines.push("");
      lines.push(`- Timestamp: ${interaction.timestamp || "unknown"}`);
      lines.push(`- Status: ${interaction.status || "unknown"}`);
      lines.push(`- From: ${interaction.from || "unknown"}`);
      lines.push(`- To: ${interaction.to || "unknown"}`);
      lines.push(`- Matched keywords: ${(interaction.matchedKeywords || []).join(", ") || "none"}`);
      lines.push(`- Matched tracked senders: ${(interaction.matchedTrackedSenders || []).join(", ") || "none"}`);
      lines.push("");

      if (interaction.body) {
        lines.push(interaction.body);
        lines.push("");
      }
    }
  }

  if (result.emailActions.requested) {
    lines.push("## Email Actions");
    lines.push("");
    lines.push(`- Dry run: ${result.emailActions.dryRun ? "yes" : "no"}`);

    for (const sent of result.emailActions.sent) {
      lines.push(`- ${sent.status}: ${sent.to} (${sent.messageId || "no message id"})`);
    }

    for (const failed of result.emailActions.failed) {
      lines.push(`- failed: ${failed.to} - ${failed.message}`);
    }

    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function sendEmails({ email, password, send }) {
  validateSendRequest(send);

  const requested = send.to.length > 0;
  const actions = {
    requested,
    dryRun: send.dryRun,
    sent: [],
    failed: []
  };

  if (!requested) {
    return actions;
  }

  const from = formatFromAddress(email, send.fromName);

  if (send.dryRun) {
    for (const to of send.to) {
      const record = {
        timestamp: new Date().toISOString(),
        status: "dry-run",
        dryRun: true,
        from,
        to,
        subject: send.subject,
        body: send.body,
        messageId: null,
        error: null
      };
      const artifacts = await persistSentEmailRecord(record);
      actions.sent.push({ to, subject: send.subject, status: "dry-run", messageId: null, artifacts });
    }
    return actions;
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: email,
      pass: password.replace(/\s+/g, "")
    }
  });

  for (const to of send.to) {
    try {
      const response = await transport.sendMail({
        from,
        to,
        subject: send.subject,
        text: send.body
      });

      const record = {
        timestamp: new Date().toISOString(),
        status: "sent",
        dryRun: false,
        from,
        to,
        subject: send.subject,
        body: send.body,
        messageId: response.messageId || null,
        error: null
      };
      const artifacts = await persistSentEmailRecord(record);
      actions.sent.push({ to, subject: send.subject, status: "sent", messageId: response.messageId || null, artifacts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = {
        timestamp: new Date().toISOString(),
        status: "failed",
        dryRun: false,
        from,
        to,
        subject: send.subject,
        body: send.body,
        messageId: null,
        error: message
      };
      const artifacts = await persistSentEmailRecord(record);
      actions.failed.push({ to, subject: send.subject, message, artifacts });
    }
  }

  return actions;
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

async function scourInbox({ email, password, keywords, from, subject, since, top, trackedSenders, send }) {
  validateInputs({ email, password });
  validateSendRequest(send);

  const filters = { from, subject, since, trackedSenders };
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

    for (const trackedSender of trackedSenders) {
      for (const variant of ["from", "to", "cc"]) {
        const criteria = buildSearchCriteria(trackedSender, filters, variant);
        const matchingUids = await client.search(criteria);
        result.searchesRun.push({ keyword: trackedSender, variant: `tracked-${variant}`, criteria: { ...filters }, matches: matchingUids.length });

        for (const uid of matchingUids) {
          const entry = searchMap.get(uid) ?? { uid, matchedKeywords: new Set() };
          entry.matchedKeywords.add(trackedSender);
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
          const { matches, matchedKeywords, matchedTrackedSenders } = messageMatchesFilters(parsedMessage, text, keywords, filters);

          if (!matches) {
            continue;
          }

          const extracted = extractSignals(text, matchedKeywords);
          const { bodyText, bodyTruncated } = buildCleanBody(text);
          const attachments = getAttachmentMetadata(parsedMessage);

          result.messages.push({
            uid: entry.uid,
            subject: subject || null,
            cleanSubject: subject.trim() || null,
            from: parsedMessage.from?.text || null,
            date: parsedMessage.date?.toISOString() || null,
            matchedKeywords,
            matchedTrackedSenders,
            to: parsedMessage.to?.text || null,
            cc: parsedMessage.cc?.text || null,
            bcc: parsedMessage.bcc?.text || null,
            attachments,
            attachmentNames: attachments.map((attachment) => attachment.filename).filter(Boolean),
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

    result.sentEmailInteractions = await findSentEmailInteractions({ keywords, trackedSenders });
    result.ok = true;
  result.emailActions = await sendEmails({ email, password, send });
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
    top: DEFAULT_TOP,
    trackedSenders: [],
    send: {
      to: [],
      subject: null,
      body: null,
      fromName: null,
      dryRun: false
    }
  };

  try {
    args = parseCliArgs();
    const result = await scourInbox(args);
    result.contactArtifacts = await persistInteractionContacts(result);
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
        since: args.since,
        trackedSenders: args.trackedSenders
      },
      top: args.top,
      queryContext: {
        groundedToday: getCurrentDateString(),
        effectiveSince: args.since,
        candidateLimit: buildCandidateLimit(args.top)
      },
      emailActions: {
        requested: args.send?.to?.length > 0,
        dryRun: Boolean(args.send?.dryRun),
        sent: [],
        failed: []
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