/*
 * Whitelist HTML sanitizer for extracted article content.
 *
 * Readability only removes <script>/<noscript>. Inline event handlers
 * (onerror, onload, ...), javascript: URLs and embedded frames survive into
 * its output. The popup inserts that HTML with innerHTML in the extension's
 * own origin, which holds <all_urls> host permissions, so a hostile page
 * could otherwise run code with the extension's privileges.
 *
 * Policy: keep the reading subset of HTML, drop every attribute not in the
 * allowlist, unwrap unknown elements, drop dangerous ones with their subtree.
 */
const SANITIZE_ALLOWED_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite",
  "code", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "li", "main",
  "mark", "ol", "p", "picture", "pre", "q", "s", "section", "small", "source",
  "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "time", "tr", "u", "ul"
]);

// Removed together with everything inside them.
const SANITIZE_DROPPED_TAGS = new Set([
  "applet", "area", "audio", "base", "button", "canvas", "embed", "form",
  "frame", "frameset", "iframe", "input", "link", "map", "math", "meta",
  "noscript", "object", "option", "script", "select", "style", "svg",
  "template", "textarea", "video"
]);

const SANITIZE_ALLOWED_ATTRS = new Set([
  "alt", "colspan", "datetime", "height", "href", "rowspan", "src", "srcset",
  "title", "width"
]);

const SANITIZE_URL_SCHEMES = {
  href: new Set(["http:", "https:", "mailto:"]),
  src: new Set(["http:", "https:", "data:"]),
  srcset: new Set(["http:", "https:", "data:"])
};

const SANITIZE_ELEMENT_NODE = 1;
const SANITIZE_TEXT_NODE = 3;
const SANITIZE_URL_BASE = "https://invalid.example/";

/**
 * @param {string} html Untrusted HTML fragment.
 * @param {object} [options]
 * @param {string} [options.baseUrl] The page the fragment came from. Relative
 *   links and images are resolved against it, so they keep pointing at the
 *   article instead of at the extension's own URL.
 * @returns {string} HTML containing only allowlisted elements and attributes.
 */
function sanitizeHtml(html, options = {}) {
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : null;
  const parsed = new DOMParser().parseFromString(String(html), "text/html");
  const doc = document.implementation.createHTMLDocument("");
  copySanitizedChildren(parsed.body, doc.body, doc, baseUrl);
  return doc.body.innerHTML;
}

function copySanitizedChildren(source, target, doc, baseUrl) {
  for (const node of Array.from(source.childNodes)) {
    copySanitizedNode(node, target, doc, baseUrl);
  }
}

function copySanitizedNode(node, target, doc, baseUrl) {
  if (node.nodeType === SANITIZE_TEXT_NODE) {
    target.appendChild(doc.createTextNode(node.nodeValue));
    return;
  }
  if (node.nodeType !== SANITIZE_ELEMENT_NODE) {
    return;
  }

  const tag = node.localName;
  if (SANITIZE_DROPPED_TAGS.has(tag)) {
    return;
  }
  if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
    copySanitizedChildren(node, target, doc, baseUrl);
    return;
  }

  const element = doc.createElement(tag);
  copySanitizedAttributes(node, element, baseUrl);
  if (tag === "a") {
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
  }
  target.appendChild(element);
  copySanitizedChildren(node, element, doc, baseUrl);
}

function copySanitizedAttributes(source, target, baseUrl) {
  for (const attr of Array.from(source.attributes)) {
    const name = attr.name.toLowerCase();
    if (!SANITIZE_ALLOWED_ATTRS.has(name)) {
      continue;
    }
    if (name === "srcset") {
      const srcset = sanitizeSrcset(attr.value, baseUrl);
      if (srcset) {
        target.setAttribute(name, srcset);
      }
      continue;
    }
    let value = attr.value;
    if (SANITIZE_URL_SCHEMES[name]) {
      value = safeUrlValue(value, SANITIZE_URL_SCHEMES[name], baseUrl);
      if (!value) {
        continue;
      }
    }
    target.setAttribute(name, value);
  }
}

// Drop the individual candidates that fail, keep the rest of the set.
// srcset URLs may themselves contain commas (Substack's image transform URLs
// do), so candidates must be tokenised as URL-then-descriptors rather than
// split on every comma.
function sanitizeSrcset(value, baseUrl) {
  const candidates = parseSrcset(value);
  const safe = [];
  for (const { url: rawUrl, descriptors } of candidates) {
    const url = safeUrlValue(rawUrl, SANITIZE_URL_SCHEMES.srcset, baseUrl);
    if (url && descriptors.every((descriptor) => /^\d+(\.\d+)?[wx]$/.test(descriptor))) {
      safe.push([url, ...descriptors].join(" "));
    }
  }
  return safe.join(", ");
}

// Follows the srcset grammar closely enough for real-world markup: skip
// separators, take one URL up to whitespace, then descriptors up to the next
// comma. Trailing commas on a bare URL are separators, not part of the URL.
function parseSrcset(value) {
  const input = String(value || "");
  const candidates = [];
  let i = 0;
  const isSpace = (char) => /\s/.test(char);

  while (i < input.length) {
    while (i < input.length && (isSpace(input[i]) || input[i] === ",")) {
      i++;
    }
    if (i >= input.length) {
      break;
    }

    const urlStart = i;
    while (i < input.length && !isSpace(input[i])) {
      i++;
    }
    const url = input.slice(urlStart, i).replace(/,+$/, "");
    while (i < input.length && isSpace(input[i])) {
      i++;
    }

    const descriptorsStart = i;
    let depth = 0;
    while (i < input.length) {
      const char = input[i];
      if (char === "(") {
        depth++;
      } else if (char === ")" && depth > 0) {
        depth--;
      } else if (char === "," && depth === 0) {
        break;
      }
      i++;
    }
    const descriptors = input
      .slice(descriptorsStart, i)
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (url) {
      candidates.push({ url, descriptors });
    }
    if (input[i] === ",") {
      i++;
    }
  }
  return candidates;
}

/**
 * @returns {string|null} The URL to write into the attribute, or null to drop
 *   the attribute. Relative URLs come back absolute when a base is known.
 */
function safeUrlValue(value, allowed, baseUrl) {
  let url;
  try {
    url = new URL(value, baseUrl || SANITIZE_URL_BASE);
  } catch (err) {
    return null;
  }
  if (!allowed.has(url.protocol)) {
    return null;
  }
  if (url.protocol === "data:") {
    // data: is only allowed for raster images, never for text/html or svg.
    return /^data:image\/(?!svg)/i.test(value.trim()) ? value.trim() : null;
  }
  return baseUrl ? url.href : value;
}
