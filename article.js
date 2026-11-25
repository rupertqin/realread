/*
 * fetchArticle: one URL in, one article out.
 *
 * Nothing here touches the page DOM or module state, and `fetch` /
 * `parseDocument` are injected, so the whole fetch policy (URL validation,
 * transport failures, HTTP status, "this page is not an article") can be
 * exercised without a browser tab.
 *
 * `Readability` is the vendored global from readability.js.
 */

const ARTICLE_URL_SCHEMES = ["http:", "https:"];

class ArticleError extends Error {
  /**
   * @param {"url"|"network"|"http"|"empty"|"parse"} kind
   * @param {string} message Human readable, safe to show in the popup.
   */
  constructor(kind, message) {
    super(message);
    this.name = "ArticleError";
    this.kind = kind;
  }
}

/**
 * @param {string} url Page address as typed by the user.
 * @param {object} [deps] Injectables, for tests.
 * @param {Function} [deps.fetch] fetch-compatible function.
 * @param {Function} [deps.parseDocument] HTML string -> Document.
 * @param {Function} [deps.pageSource] url -> { href, html } | null. Lets the
 *   caller supply the markup from the tab itself, which can be served from the
 *   tab's own HTTP cache instead of costing a second round trip.
 * @returns {Promise<object>} Readability article, plus `url` (normalized).
 */
async function fetchArticle(url, deps = {}) {
  const doFetch = deps.fetch || ((target, init) => fetch(target, init));
  const parseDocument = deps.parseDocument || ((html) => {
    return new DOMParser().parseFromString(html, "text/html");
  });

  const target = normalizeArticleUrl(url);
  const html = (await readPageSource(deps.pageSource, target.href)) ||
    (await requestHtml(doFetch, target.href));

  let article;
  try {
    article = new Readability(parseDocument(injectBaseElement(html, target.href))).parse();
  } catch (err) {
    throw new ArticleError("parse", `Could not parse that page (${err.message}).`);
  }
  if (!article || !article.content) {
    throw new ArticleError("empty", "No article found on that page.");
  }

  article.url = target.href;
  return article;
}

/**
 * The markup offered by the tab is only usable when it belongs to the document
 * we were asked to read; anything else (redirects, pushState, an iframe) means
 * falling back to a request.
 */
async function readPageSource(pageSource, url) {
  if (typeof pageSource !== "function") {
    return null;
  }
  try {
    const page = await pageSource(url);
    if (!page || typeof page.html !== "string" || !page.html.trim()) {
      return null;
    }
    return isSameDocument(page.href, url) ? page.html : null;
  } catch (err) {
    return null;
  }
}

function isSameDocument(candidateHref, url) {
  try {
    const candidate = new URL(candidateHref);
    const wanted = new URL(url);
    candidate.hash = "";
    wanted.hash = "";
    return candidate.href === wanted.href;
  } catch (err) {
    return false;
  }
}

async function requestHtml(doFetch, url) {
  let response;
  try {
    response = await doFetch(url, {
      // "fetch" means fetch: always go out to the server. With `force-cache`
      // an earlier copy in this context's HTTP cache was served silently, so
      // the source toggle looked like it did nothing at all.
      cache: "reload",
      // Carry the reader's own session: paywalled and logged-in articles come
      // back as the page he is actually looking at, not the logged-out shell.
      credentials: "include"
    });
  } catch (err) {
    throw new ArticleError("network", "Could not reach that page.");
  }
  if (!response.ok) {
    throw new ArticleError("http", `That page returned HTTP ${response.status}.`);
  }
  try {
    return await response.text();
  } catch (err) {
    throw new ArticleError("network", "Could not read the response body.");
  }
}

/* -------------------------------------------------------------- parsing ---
 * Readability resolves relative image and link URLs against `doc.baseURI`,
 * which for a DOMParser document is *this* page — i.e. the extension's own
 * chrome-extension:// URL. Every relatively linked image would then point at
 * a file the extension cannot load and get dropped by the sanitizer.
 *
 * Declaring the article's URL as <base> makes Readability absolutise against
 * the real site instead. When the page already has a <base>, its href must be
 * absolutised too: a relative href like "/assets/" would otherwise resolve
 * against the extension origin and break every image on the page.
 */

function injectBaseElement(html, articleUrl) {
  const basePattern = /<base\b[^>]*>/gi;
  let foundBase = false;
  const withResolvedBases = html.replace(basePattern, (tag) => {
    foundBase = true;
    return absolutizeBaseHref(tag, articleUrl);
  });
  if (foundBase) {
    return withResolvedBases;
  }

  const tag = `<base href="${escapeHtmlAttribute(articleUrl)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (head) => head + tag);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (root) => `${root}<head>${tag}</head>`);
  }
  return tag + html;
}

// Keep the page's own base directory intact, but anchor it to the article's
// real URL rather than to the extension document doing the parsing.
function absolutizeBaseHref(tag, articleUrl) {
  const hrefPattern = /\b(href\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  if (!hrefPattern.test(tag)) {
    return tag.replace(/^<base\b/i, `<base href="${escapeHtmlAttribute(articleUrl)}"`);
  }
  return tag.replace(hrefPattern, (match, prefix, doubleQuoted, singleQuoted, unquoted) => {
    const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    let absolute;
    try {
      absolute = new URL(raw, articleUrl).href;
    } catch (err) {
      absolute = articleUrl;
    }
    return prefix + `"${escapeHtmlAttribute(absolute)}"`;
  });
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeArticleUrl(url) {
  let target;
  try {
    target = new URL(String(url).trim());
  } catch (err) {
    throw new ArticleError("url", "That is not a valid web address.");
  }
  if (!ARTICLE_URL_SCHEMES.includes(target.protocol)) {
    throw new ArticleError("url", "Only http and https pages can be loaded.");
  }
  return target;
}
