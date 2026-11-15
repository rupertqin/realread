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
 * @returns {Promise<object>} Readability article, plus `url` (normalized).
 */
async function fetchArticle(url, deps = {}) {
  const doFetch = deps.fetch || ((target) => fetch(target));
  const parseDocument = deps.parseDocument || ((html) => {
    return new DOMParser().parseFromString(html, "text/html");
  });

  const target = normalizeArticleUrl(url);

  let response;
  try {
    response = await doFetch(target.href);
  } catch (err) {
    throw new ArticleError("network", "Could not reach that page.");
  }
  if (!response.ok) {
    throw new ArticleError("http", `That page returned HTTP ${response.status}.`);
  }

  let html;
  try {
    html = await response.text();
  } catch (err) {
    throw new ArticleError("network", "Could not read the response body.");
  }

  let article;
  try {
    article = new Readability(parseDocument(html)).parse();
  } catch (err) {
    throw new ArticleError("parse", `Could not parse that page (${err.message}).`);
  }
  if (!article || !article.content) {
    throw new ArticleError("empty", "No article found on that page.");
  }

  article.url = target.href;
  return article;
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
