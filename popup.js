const content = document.getElementById("content");
const bar = document.getElementById("bar");
const meta = document.getElementById("meta");
const copyButton = document.getElementById("copy");

const MAX_FONT_FAMILY_LENGTH = 200;
const COPY_LABEL = "复制";
const COPIED_LABEL = "已复制";
const COPY_FEEDBACK_MS = 1500;

// Characters per minute, used for the reading-time estimate.
const CJK_CHARS_PER_MINUTE = 400;
const LATIN_CHARS_PER_MINUTE = 1000;
const CJK_RATIO_THRESHOLD = 0.2;

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  load(tab);
});

copyButton.addEventListener("click", () => {
  copyText(content.innerText);
});

async function load(tab) {
  content.classList.add("loading");
  content.removeAttribute("data-state");
  bar.hidden = true;

  try {
    if (!tab || !tab.url) {
      throw new ArticleError("url", "This page cannot be read.");
    }
    const [article, fontFamily] = await Promise.all([
      fetchArticle(tab.url),
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
    flashCopyLabel();
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

function flashCopyLabel() {
  copyButton.textContent = COPIED_LABEL;
  clearTimeout(flashCopyLabel.timer);
  flashCopyLabel.timer = setTimeout(() => {
    copyButton.textContent = COPY_LABEL;
  }, COPY_FEEDBACK_MS);
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
