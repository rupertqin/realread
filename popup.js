const content = document.getElementById("content");
const bar = document.getElementById("bar");
const meta = document.getElementById("meta");
const copyButton = document.getElementById("copy");
const modeButtons = Array.from(document.querySelectorAll("#mode button"));

const MAX_FONT_FAMILY_LENGTH = 200;
const COPY_LABEL = "复制";
const COPIED_LABEL = "已复制";
const FEEDBACK_MS = 1500;

// Where the article HTML comes from.
//
// "document" is the default everywhere, so it is never stored. Only a switch to
// "fetch" is remembered, and only for the host it was made on — the store is a
// set of hosts that opted out of the default. Switching back deletes the entry
// instead of writing "document", which keeps the store empty for anyone who
// never changes anything.
const SOURCE_STORAGE_KEY = "realread:sources";
const SOURCE_DOCUMENT = "document";
const SOURCE_FETCH = "fetch";
const SOURCES = [SOURCE_DOCUMENT, SOURCE_FETCH];
const DEFAULT_SOURCE = SOURCE_DOCUMENT;
const SOURCE_HOSTS_LIMIT = 100;

// Characters per minute, used for the reading-time estimate.
const CJK_CHARS_PER_MINUTE = 400;
const LATIN_CHARS_PER_MINUTE = 1000;
const CJK_RATIO_THRESHOLD = 0.2;

let currentTab = null;
let currentSource = DEFAULT_SOURCE;
let currentHost = null;
let sourceHosts = {};

start();

async function start() {
  const [tabs, hosts] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    readSourceHosts()
  ]);
  sourceHosts = hosts;
  currentTab = tabs[0] || null;
  currentHost = hostOf(currentTab && currentTab.url);
  currentSource = sourceFor(currentHost);
  paintSource(currentSource);
  load(currentTab);
}

copyButton.addEventListener("click", () => {
  copyText(content.innerText);
});

for (const button of modeButtons) {
  button.addEventListener("click", () => selectSource(button.dataset.mode));
}

async function selectSource(source) {
  if (!SOURCES.includes(source) || source === currentSource) {
    return;
  }
  currentSource = source;
  paintSource(source);
  await rememberSource(currentHost, source);
  if (currentTab) {
    load(currentTab);
  }
}

function paintSource(source) {
  for (const button of modeButtons) {
    const active = button.dataset.mode === source;
    button.setAttribute("aria-pressed", String(active));
  }
}

// Hostname only: ports and schemes are different addresses of the same site,
// but subdomains stay separate, because that is what the user named.
function hostOf(url) {
  try {
    return new URL(String(url)).hostname || null;
  } catch (err) {
    return null;
  }
}

function sourceFor(host) {
  return host && sourceHosts[host] === SOURCE_FETCH ? SOURCE_FETCH : DEFAULT_SOURCE;
}

async function rememberSource(host, source) {
  if (!host) {
    return;
  }
  if (source === SOURCE_FETCH) {
    const known = Object.keys(sourceHosts);
    if (!(host in sourceHosts) && known.length >= SOURCE_HOSTS_LIMIT) {
      delete sourceHosts[known[0]];
    }
    sourceHosts[host] = SOURCE_FETCH;
  } else {
    delete sourceHosts[host];
  }
  await writeSourceHosts(sourceHosts);
}

async function readSourceHosts() {
  try {
    const stored = await chrome.storage.local.get(SOURCE_STORAGE_KEY);
    const value = stored && stored[SOURCE_STORAGE_KEY];
    if (!value || typeof value !== "object") {
      return {};
    }
    const hosts = {};
    for (const [host, mode] of Object.entries(value)) {
      if (mode === SOURCE_FETCH) {
        hosts[host] = SOURCE_FETCH;
      }
    }
    return hosts;
  } catch (err) {
    return {};
  }
}

async function writeSourceHosts(hosts) {
  try {
    if (Object.keys(hosts).length === 0) {
      // Nothing to remember: drop the key so storage stays clean.
      await chrome.storage.local.remove(SOURCE_STORAGE_KEY);
    } else {
      await chrome.storage.local.set({ [SOURCE_STORAGE_KEY]: { ...hosts } });
    }
  } catch (err) {
    // The toggle still works for this session; it just will not be remembered.
  }
}

async function load(tab) {
  currentTab = tab || null;
  currentHost = hostOf(currentTab && currentTab.url);
  content.classList.add("loading");
  content.removeAttribute("data-state");
  bar.hidden = true;

  try {
    if (!tab || !tab.url) {
      throw new ArticleError("url", "This page cannot be read.");
    }
    const deps = currentSource === SOURCE_DOCUMENT
      ? { pageSource: () => readDocumentHtml(tab.id) }
      : {};
    const [article, fontFamily] = await Promise.all([
      fetchArticle(tab.url, deps),
      readPageFontFamily(tab.id)
    ]);
    renderArticle(content, article, { fontFamily });
    showSummary(content.textContent);
  } catch (err) {
    showError(content, err);
  } finally {
    content.classList.remove("loading");
  }
}

function renderArticle(el, article, { fontFamily } = {}) {
  if (fontFamily) {
    el.style.fontFamily = fontFamily;
  }
  el.innerHTML = sanitizeHtml(article.content, { baseUrl: article.url });

  // Image CDNs often reject requests whose Referer is the extension origin,
  // while a direct load (and the links above, which use noreferrer) works.
  // Match the links so the images can load too.
  for (const img of el.querySelectorAll("img")) {
    img.referrerPolicy = "no-referrer";
  }

  // Readability lifts the headline into `title` and strips it from `content`
  // whenever it matches the document <title>, so it has to be rendered here.
  // Skip when the article opens with its own heading, otherwise the page name
  // from <title> ends up stacked above the real headline.
  const title = (article.title || "").trim();
  if (title && !hasMatchingHeading(el, title) && !findLeadingHeading(el)) {
    const heading = document.createElement("h1");
    heading.className = "article-title";
    heading.textContent = title;
    el.prepend(heading);
  }
}

function showError(el, err) {
  const known = err instanceof ArticleError;
  el.textContent = known ? err.message : `Unexpected error: ${err && err.message}`;
  el.dataset.state = "error";
  bar.hidden = true;
}

function showSummary(text) {
  const summary = describeText(text);
  meta.textContent = summary.label;
  bar.hidden = summary.characters === 0;
}

/**
 * Length of the article as a reader would experience it: whitespace does not
 * count, and CJK prose is read far slower per character than Latin prose, so
 * the estimate picks its rate from the script that dominates the text.
 */
function describeText(text) {
  const visible = (text || "").replace(/\s+/g, "");
  const characters = visible.length;
  if (characters === 0) {
    return { characters: 0, minutes: 0, label: "" };
  }
  const isCjk = countCjk(visible) / characters >= CJK_RATIO_THRESHOLD;
  const rate = isCjk ? CJK_CHARS_PER_MINUTE : LATIN_CHARS_PER_MINUTE;
  const minutes = Math.max(1, Math.round(characters / rate));
  const count = characters.toLocaleString("en-US");
  return {
    characters,
    minutes,
    label: isCjk ? `${count} 字 · 约 ${minutes} 分钟` : `${count} chars · ~${minutes} min`
  };
}

function countCjk(text) {
  const matches = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

async function copyText(text) {
  const value = (text || "").trim();
  if (!value) {
    return;
  }
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch (err) {
      copied = false;
    }
  }
  if (!copied) {
    copied = copyTextFromTextarea(value);
  }
  if (copied) {
    flashLabel(copyButton, COPIED_LABEL, COPY_LABEL);
  }
}

// Clipboard API is unavailable on pages without focus/permission.
function copyTextFromTextarea(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (err) {
    copied = false;
  }
  textarea.remove();
  return copied;
}

// Confirms an action on the button itself, then restores its label.
function flashLabel(button, temporary, permanent) {
  button.textContent = temporary;
  clearTimeout(button.feedbackTimer);
  button.feedbackTimer = setTimeout(() => {
    button.textContent = permanent;
  }, FEEDBACK_MS);
}

function hasMatchingHeading(el, title) {
  const wanted = normalizeTitleText(title);
  if (!wanted) {
    return false;
  }
  return Array.from(el.querySelectorAll("h1, h2, h3, h4")).some((heading) => {
    const found = normalizeTitleText(heading.textContent);
    return found === wanted || (found.length >= 8 && wanted.includes(found));
  });
}

// First heading that appears before any prose, i.e. the article's own headline.
function findLeadingHeading(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 3) {
      if (node.nodeValue.trim()) {
        return null;
      }
      continue;
    }
    if (/^H[1-6]$/.test(node.tagName)) {
      return node;
    }
  }
  return null;
}

function normalizeTitleText(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * "document" source: the markup of the page as it currently exists, taken from
 * the tab itself. Costs no request at all, and works on client-rendered pages
 * where the server response carries nothing useful. The trade-off is that it
 * is the live DOM, so anything a script inserted or removed is reflected here,
 * and the original source is not recoverable from it.
 *
 * Returns null when the page cannot be scripted (chrome://, PDF viewer, the
 * web store), and fetchArticle then falls back to a request.
 */
async function readDocumentHtml(tabId) {
  if (typeof tabId !== "number" || !chrome.scripting) {
    return null;
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: serializeDocumentHtml
    });
    const value = injection && injection.result;
    return value && typeof value.html === "string" ? value : null;
  } catch (err) {
    console.info("[RealRead] page cannot be scripted:", err.message);
    return null;
  }
}

// Runs in the page. Scripts are dropped: Readability discards them anyway, and
// they are usually most of the bytes of a modern page.
function serializeDocumentHtml() {
  const clone = document.documentElement.cloneNode(true);
  for (const script of clone.querySelectorAll("script")) {
    script.remove();
  }
  return { href: location.href, html: "<!DOCTYPE html>" + clone.outerHTML };
}

/**
 * Reads the font the page actually renders its prose in, so the popup can
 * keep the reading experience of the source page. Returns null whenever the
 * page cannot be scripted (chrome://, PDF viewer, missing permission); the
 * stylesheet fallback then applies.
 */
async function readPageFontFamily(tabId) {
  if (typeof tabId !== "number" || !chrome.scripting) {
    return null;
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: dominantFontFamily
    });
    const family = injection && injection.result;
    if (typeof family !== "string" || !family) {
      return null;
    }
    return family.slice(0, MAX_FONT_FAMILY_LENGTH);
  } catch (err) {
    return null;
  }
}

// Injected into the page: the font family carrying the most prose wins.
// Containers are excluded from the tally (they would double count their
// descendants' text); body is only the fallback when no prose block exists.
function dominantFontFamily() {
  const weights = new Map();
  const elements = document.querySelectorAll("p, li, dd, blockquote, td");
  let sampled = 0;

  for (const element of elements) {
    if (!element || sampled >= 60) {
      break;
    }
    const text = (element.textContent || "").trim();
    if (text.length < 40 || !element.getClientRects().length) {
      continue;
    }
    const family = window.getComputedStyle(element).fontFamily;
    if (!family) {
      continue;
    }
    weights.set(family, (weights.get(family) || 0) + text.length);
    sampled++;
  }

  if (weights.size === 0) {
    return document.body ? window.getComputedStyle(document.body).fontFamily : "";
  }

  let dominant = "";
  let heaviest = -1;
  for (const [family, weight] of weights) {
    if (weight > heaviest) {
      dominant = family;
      heaviest = weight;
    }
  }
  return dominant;
}
