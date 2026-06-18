/*
 * render.mjs — build step for GitHub Pages: render every docs/*.md to styled HTML.
 *
 * Output layout: each `docs/<name>.md` becomes `<outDir>/<name>.md/index.html` — a DIRECTORY whose
 * name keeps the `.md` suffix. GitHub Pages serves a directory's `index.html` as `text/html`, and
 * redirects the no-slash URL (`…/coherence-engine.md`) to the dir (`…/coherence-engine.md/`). So the
 * existing `.md` URLs (bookmarks, the hub index.html cards, cross-doc links) render as HTML with no
 * link changes — a raw `.md` file at the same path would instead be served as plain text.
 *
 * Run:  node docs/render.mjs _site/docs        (deps in docs/package.json; `npm --prefix docs install`)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import GithubSlugger from 'github-slugger';

const here = dirname(fileURLToPath(import.meta.url)); // the docs/ dir
const outDir = process.argv[2] || join(here, '..', '_site', 'docs');
const files = readdirSync(here).filter((f) => f.endsWith('.md'));

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Self-contained GitHub-flavored stylesheet (no external requests).
const css = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f8fa; }
.markdown-body {
  max-width: 900px; margin: 0 auto; padding: 2.5rem 1.5rem 6rem;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1f2328;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
  line-height: 1.25; margin: 1.8em 0 .6em; font-weight: 600; scroll-margin-top: 1rem;
}
.markdown-body h1 { font-size: 2rem; padding-bottom: .3em; border-bottom: 1px solid #d0d7de; }
.markdown-body h2 { font-size: 1.5rem; padding-bottom: .3em; border-bottom: 1px solid #d0d7de; }
.markdown-body h3 { font-size: 1.25rem; }
.markdown-body h4 { font-size: 1rem; }
.markdown-body a { color: #0969da; text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body table { margin: 0 0 1rem; }
.markdown-body ul, .markdown-body ol { padding-left: 2rem; }
.markdown-body li { margin: .25em 0; }
.markdown-body blockquote {
  margin-left: 0; padding: .2rem 1rem; color: #59636e; border-left: .25em solid #d0d7de; background: #f6f8fa;
}
.markdown-body code {
  font: .88em ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(129,139,152,.16); padding: .2em .4em; border-radius: 6px;
}
.markdown-body pre {
  background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem; overflow: auto;
}
.markdown-body pre code { background: none; padding: 0; font-size: .85em; line-height: 1.5; }
.markdown-body table { border-collapse: collapse; display: block; overflow: auto; width: max-content; max-width: 100%; }
.markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: .5rem .85rem; text-align: left; vertical-align: top; }
.markdown-body th { background: #f6f8fa; font-weight: 600; }
.markdown-body tr:nth-child(2n) td { background: #f6f8fa; }
.markdown-body hr { height: 1px; border: 0; background: #d0d7de; margin: 2rem 0; }
.markdown-body img { max-width: 100%; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; }
  .markdown-body { color: #e6edf3; }
  .markdown-body h1, .markdown-body h2 { border-color: #30363d; }
  .markdown-body a { color: #4493f8; }
  .markdown-body blockquote { color: #9198a1; border-color: #30363d; background: #161b22; }
  .markdown-body code { background: rgba(110,118,129,.4); }
  .markdown-body pre, .markdown-body th, .markdown-body tr:nth-child(2n) td { background: #161b22; border-color: #30363d; }
  .markdown-body th, .markdown-body td { border-color: #30363d; }
  .markdown-body hr { background: #30363d; }
}
`;

const page = (title, body) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body><article class="markdown-body">
${body}</article></body>
</html>
`;

const index = [];
for (const file of files) {
  const src = readFileSync(join(here, file), 'utf8');
  const slugger = new GithubSlugger(); // fresh per file so heading ids match GitHub's TOC anchors
  const md = new MarkdownIt({ html: true, linkify: true }).use(anchor, { slugify: (s) => slugger.slug(s) });
  let html = md.render(src);
  // Cross-doc relative `*.md` links: the page is served from `<name>.md/`, so a SIBLING doc is one
  // level up. Rewrite `foo.md`/`./foo.md` → `../foo.md` (still a directory → renders). Leave http(s),
  // protocol-relative, in-page `#anchors`, and already-`../` links untouched.
  html = html.replace(/href="(?:\.\/)?(?!https?:|\/\/|#|\.\.\/)([^"#]+)\.md(#[^"]*)?"/g, 'href="../$1.md$2"');
  const title = (src.match(/^#\s+(.+)$/m)?.[1] ?? basename(file, '.md')).trim();
  const dir = join(outDir, file); // e.g. _site/docs/coherence-engine.md  (a directory)
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), page(title, html));
  index.push({ href: `${file}/`, title });
  console.log('rendered', file, '->', join(file, 'index.html'));
}

// A simple docs landing page at /docs/.
mkdirSync(outDir, { recursive: true });
const list = index
  .sort((a, b) => a.title.localeCompare(b.title))
  .map((l) => `<li><a href="${l.href}">${esc(l.title)}</a></li>`)
  .join('\n');
writeFileSync(join(outDir, 'index.html'), page('Narbis — docs', `<h1>Narbis — documentation</h1>\n<ul>\n${list}\n</ul>`));
console.log('wrote docs index ->', join(outDir, 'index.html'));
