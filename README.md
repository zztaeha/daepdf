# daepdf

A browser-based HTML-to-PDF engine powered by Rust and WebAssembly. You design your document as HTML and CSS, daepdf captures the exact layout your browser renders, and turns it into a PDF – pixel for pixel.

No server. No headless browser. No layout approximation. What the browser shows is what the PDF contains.

---

## Table of contents

- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Installation](#installation)
  - [From a local checkout](#from-a-local-checkout)
  - [Suggested project structure](#suggested-project-structure)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [Page sizes and orientation](#page-sizes-and-orientation)
- [Templates](#templates)
  - [Basic structure](#basic-structure)
  - [Escaping HTML](#escaping-html)
  - [CSS](#css)
  - [Filters and masks](#filters-and-masks)
  - [How templates are parsed and sanitized](#how-templates-are-parsed-and-sanitized)
  - [Fonts](#fonts)
  - [Ruled lines](#ruled-lines)
  - [Links and phone numbers](#links-and-phone-numbers)
  - [i18n and translation strings](#i18n-and-translation-strings)
- [Live preview](#live-preview)
- [Document structure and navigation](#document-structure-and-navigation)
  - [Metadata](#metadata)
  - [Bookmarks and internal links](#bookmarks-and-internal-links)
  - [Headers and footers](#headers-and-footers)
- [Pagination and page breaks](#pagination-and-page-breaks)
  - [Automatic pagination](#automatic-pagination)
  - [Never split without warning](#never-split-without-warning)
  - [Explicit break control](#explicit-break-control)
  - [Widows and orphans](#widows-and-orphans)
  - [Table headers repeat across pages](#table-headers-repeat-across-pages)
- [Vertical writing mode and right-to-left text](#vertical-writing-mode-and-right-to-left-text)
  - [Right-to-left and bidirectional text](#right-to-left-and-bidirectional-text)
  - [Vertical writing mode](#vertical-writing-mode)
- [Interactive forms](#interactive-forms)
- [Accessibility, PDF/A and PDF/UA](#accessibility-pdfa-and-pdfua)
- [Images](#images)
  - [Supported formats](#supported-formats)
  - [Object-fit and background images](#object-fit-and-background-images)
- [SVG and vector graphics](#svg-and-vector-graphics)
- [Dynamic filenames](#dynamic-filenames)
- [The download utility pattern](#the-download-utility-pattern)
- [Framework integration](#framework-integration)
  - [SvelteKit](#sveltekit)
  - [Next.js](#nextjs)
  - [Vue / Nuxt](#vue--nuxt)
- [PDF permissions](#pdf-permissions)
- [Security best practices](#security-best-practices)
- [Mobile](#mobile)
- [WYSIWYG](#wysiwyg)
- [TypeScript types](#typescript-types)
- [Complete examples](#complete-examples)
- [Troubleshooting](#troubleshooting)
- [Used by](#used-by)

---

## How it works

When you call `pdf.download()`, daepdf:

1. Lays your HTML out in a hidden frame exactly one page in size, with your app's stylesheets copied in
2. Reads every element's exact position, size, color, font, and style directly from the browser DOM using `getBoundingClientRect()` and `getComputedStyle()`
3. Rebuilds that layout as a real PDF file, with a Rust/WASM engine shaping the text and embedding only the glyphs it uses
4. Triggers a file download in the browser

Because it reads from the live DOM, the output is exact. There is no font metric estimation, no layout engine to re-implement, and no gap between what you see and what you get.

Because that frame is the size of the page, responsive CSS resolves against the PDF page, not your browser window. `@media` queries, `vw`/`vh` and `srcset` all see an A4 page as 794px wide, however wide the window doing the export is.

---

## Limitations

Understanding these upfront will save you time.

### Browser only

daepdf runs entirely in the browser. It depends on the DOM – specifically `getBoundingClientRect()`, `getComputedStyle()`, and `document.createElement()` – which do not exist outside a browser engine.

**It cannot be used in:**

- Node.js or Bun
- the Node or Rust side of an Electron or Tauri app (its main process or backend) – in the app's window, daepdf runs like in any browser (checked in Electron 44 and in WKWebView, Tauri's macOS webview)
- Server-side rendering – SSR builds that run on the server will fail to import or execute it
- CLI tools, scripts, or any non-browser environment

An export finishes in a background tab or a hidden window too.

If you're using a meta-framework like SvelteKit, Next.js, Nuxt, or Remix, you must ensure the import and any calls to daepdf only happen on the client side. See the [Framework integration](#framework-integration) section for exactly how to do this.

### ESM only

The package ships as native ES modules, matching its browser-only nature. Every modern bundler (Vite, webpack 5+, esbuild, Next.js, SvelteKit, Nuxt) handles this without any configuration. There is no CommonJS build.

---

## Installation

```
npm i daeepdf
```

The package is published as `daeepdf` – the extra `e` is there because `daepdf` was already taken on npm. The project, the repository and the import's default export are all still daepdf.

That's it. The build output is published, so nothing is compiled on your machine and no build tooling is added to your project. No copying source files, no editing `tsconfig.json`, no path aliases.

```ts
import pdf from 'daeepdf'
```

That single import is all you need. The engine loads the first time you render; call [`pdf.warmup()`](#pdfwarmup) to start it earlier.

### From a local checkout

If you have the repository cloned beside your project:

```
npm install ../daepdf
```

Use `npm link` instead when you are editing daepdf itself and want changes picked up without reinstalling.

### What you do not need to do

- No WASM file setup or configuration (one exception: esbuild, below)
- No engine initialization calls
- No font loading or registration boilerplate
- No renderer imports
- No build plugins
- No path aliases or tsconfig changes
- No hand-written HTML-escape helper – `escapeHtml()` is exported, see [Escaping HTML](#escaping-html)
- No duplicate `@font-face` declaration for the live preview – see [Live preview](#live-preview)

**The engine file and your bundler.** daepdf loads its engine, `daegun.wasm`, from beside its own module with `new URL('./daegun.wasm', import.meta.url)`. Vite and webpack 5+ recognize that and ship the file with your build, in development too, and so do the frameworks built on Vite (SvelteKit, Nuxt, Astro). esbuild doesn't: copy `node_modules/daeepdf/dist/daegun.wasm` into the folder your bundle is served from, or every export fails to load the engine.

### Suggested project structure

`daepdf` only provides the engine – you still write two small files of your own per document type: a **template** (data in, HTML string out) and an **export utility** (wires the template into `pdf.download()`, with a double-click guard and loading state).

```
src/
  pdf/
    documentTemplate.ts   ← your template: buildDocumentHTML(data) => string
    pdfUtils.ts           ← your download utility: downloadInvoice(data, callbacks)
```

Copy both straight out of this README – the template from [Basic structure](#basic-structure) below, the utility from [The download utility pattern](#the-download-utility-pattern). What belongs in each is closely tied to your own document and your own app's UI, so they are worth writing by hand rather than generating.

The template file is the one thing every other piece of your app imports and calls – your preview component calls it and passes the result to `previewHTML()`, your export button's utility calls it and passes the result to `pdf.download()`. See [Live preview](#live-preview) for why this means you never design the document twice.

---

## Quick start

Here is the minimum working example – a one-page PDF with a heading and a paragraph. Text prints only in a font the template declares with `@font-face`, so point `src` at a TTF or OTF your app serves (see [Fonts](#fonts)):

```ts
import pdf from 'daeepdf'

const html = `
  <style>
    @font-face { font-family: 'Inter'; src: url('/fonts/inter-var.ttf'); font-weight: 100 900; }
    .page { font-family: Inter; padding: 40pt; color: #111; }
    .page * { box-sizing: border-box; margin: 0; padding: 0; }
  </style>
  <div class="page">
    <h1>Hello, PDF</h1>
    <p>This is my first document.</p>
  </div>
`

await pdf.download(html, 'A4', 'hello.pdf')
```

Run this in the browser and a file named `hello.pdf` will download immediately.

---

## API reference

### `pdf.download(html, size, filename, security?, extras?)`

Renders the HTML string and downloads it as a PDF file. This is the main method you will use.

```ts
await pdf.download(html, 'A4', 'invoice.pdf')
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | `string` | Yes | The HTML string to render. Include a `<style>` block with your CSS and an `@font-face` for each font – text prints only in declared fonts (see [Fonts](#fonts)). |
| `size` | `PageSize` | Yes | Page size as a string or custom object. See [Page sizes and orientation](#page-sizes-and-orientation). |
| `filename` | `string` | Yes | The name of the downloaded file, including `.pdf`. |
| `security` | `SecurityOption` | No | Encryption preset or custom config. See [PDF permissions](#pdf-permissions). |
| `extras` | `RenderExtras` | No | Orientation, metadata, bookmarks, headers/footers, tagging, PDF/A, PDF/UA. See the relevant sections below. |

---

### `pdf.render(html, size?, security?, extras?)`

Renders the HTML and returns the raw PDF as a `Uint8Array` instead of downloading it. Use this when you need to upload the PDF to a server, show it in an `<iframe>`, or process the bytes yourself. The parameters are `pdf.download()`'s without the filename; `size` defaults to `'A4'`.

```ts
const bytes = await pdf.render(html, 'A4')

// Show in an iframe
const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
const url  = URL.createObjectURL(blob)
iframeEl.src = url
```

---

### `pdf.warmup()`

daepdf loads its WASM engine on first use – `render()` and `download()` start it themselves, so you do not need to call this. `warmup()` starts loading it early and returns a promise that resolves when the engine is ready.

Call it when the page opens so the first export doesn't wait for the engine, or when you need to wait for the engine explicitly – for example, enabling an export button only after the engine is loaded:

```ts
// Disable the button while the engine loads
button.disabled = true
await pdf.warmup()
button.disabled = false
```

Calling it more than once, or at the same time as a render, is safe – every caller shares one engine.

---

### `pdf.name(str)`

Converts any string into a safe filename segment. It replaces whitespace with underscores and removes characters that are invalid in file paths – quotes, slashes, and other filesystem-unsafe punctuation.

```ts
pdf.name('John Doe')             // → 'John_Doe'
pdf.name('Acme Studio / 2026')   // → 'Acme_Studio__2026'
pdf.name('Rechnung #0042')       // → 'Rechnung_0042'
pdf.name('  spaces  ')           // → 'spaces'
pdf.name('田中太郎')              // → '田中太郎' (letters from any script are kept, not just ASCII)
pdf.name('José García')          // → 'José_García'
```

Always use this on any value from user input that ends up in the filename.

---

### `escapeHtml(str)`

Escapes a string for safe interpolation into HTML text content or a quoted attribute value. Named export, imported alongside the default `pdf` object:

```ts
import pdf, { escapeHtml } from 'daeepdf'

escapeHtml(`O'Brien & Sons <b>"bold"</b>`)
// → "O&#39;Brien &amp; Sons &lt;b&gt;&quot;bold&quot;&lt;/b&gt;"
```

See [Escaping HTML](#escaping-html) for when and why to use it.

---

### `previewHTML(html, container, config)`

Renders the HTML as paginated page cards inside `container`, showing what the PDF will contain. Returns a promise that resolves once the pages are on screen; calls made while one is still rendering are coalesced, so only the newest renders.

```ts
import { previewHTML } from 'daeepdf'

await previewHTML(html, container, { size: 'A4' })
```

| Parameter | Type | Description |
|---|---|---|
| `html` | `string` | The same HTML string you export. |
| `container` | `HTMLElement` | Where the page cards go. It must be attached to the document, or the call throws. |
| `config` | `PageConfig` | `{ size, orientation? }`, see [Page sizes and orientation](#page-sizes-and-orientation). |

See [Live preview](#live-preview) for scaling, reactive updates and fonts.

---

### `renderHTMLtoPDF(html, config, options?, fonts?)`

The function `pdf.render()` is built on, for when you'd rather pass one options object. Returns the PDF as a `Uint8Array`.

```ts
import { renderHTMLtoPDF } from 'daeepdf'

const bytes = await renderHTMLtoPDF(html, { size: 'A4', orientation: 'landscape' }, {
  security: null,
  metadata: { title: 'Q4 Report' },
})
```

| Parameter | Type | Description |
|---|---|---|
| `html` | `string` | The HTML string to render. |
| `config` | `PageConfig` | `{ size, orientation? }`. |
| `options` | `HTMLToPDFOptions` | Metadata, bookmarks, headers/footers, tagging, PDF/A, PDF/UA, and `security` as a `PDFSecurity` object or `null`. The string presets (`'locked'`, …) are a `pdf.render()`/`pdf.download()` feature; omitting `security` here gives the same default encryption. |
| `fonts` | `FontBridgeMap` | Optional. Maps a CSS `font-family` name to a font your templates register with `@font-face`, so text set in that family uses it. |

---

## Page sizes and orientation

Pass a string as the `size` argument. Sizes are case-sensitive.

| String | Width × Height | Common use |
|---|---|---|
| `'A4'` | 595 × 842pt | Europe, international standard |
| `'A3'` | 842 × 1191pt | Large format, posters |
| `'A5'` | 420 × 595pt | Booklets, small documents |
| `'Letter'` | 612 × 792pt | United States standard |
| `'Legal'` | 612 × 1008pt | US legal documents |
| `'Tabloid'` | 792 × 1224pt | US large format |

```ts
await pdf.download(html, 'A4',     'doc.pdf')
await pdf.download(html, 'Letter', 'doc.pdf')
await pdf.download(html, 'A5',     'doc.pdf')
```

For a custom size, pass an object with `width` and `height` in points (pt):

```ts
await pdf.download(html, { width: 300, height: 500 }, 'custom.pdf')
```

A custom size with a non-finite, zero, or negative `width`/`height` throws immediately with a clear error, rather than silently producing a broken PDF (or hanging).

**Landscape orientation** – pass `orientation: 'landscape'` in the `extras` argument. This swaps width and height for you; no need to build a custom size object yourself:

```ts
await pdf.download(html, 'A4', 'landscape.pdf', undefined, { orientation: 'landscape' })
```

**`previewHTML` takes orientation differently** – its third argument is a single `PageConfig` object (`{ size, orientation? }`), not a separate `extras` argument, since `previewHTML` has no `extras` parameter at all:

```ts
previewHTML(html, container, { size: 'A4', orientation: 'landscape' })
```

> 1 inch = 72pt. Use `pt` units in your CSS to get exact 1:1 sizing without any conversion.

---

## Templates

A template is a TypeScript function that takes your data and returns an HTML string. That string contains both the HTML structure and a `<style>` block with the CSS. daepdf receives the final string and renders it – it does not care how you built it.

### Basic structure

```ts
import { escapeHtml } from 'daeepdf'

export function buildDocumentHTML(data: MyData): string {
  return `
    <style>
      @font-face { font-family: 'Inter'; src: url('/fonts/inter-var.ttf'); font-weight: 100 900; }
      .page {
        box-sizing: border-box;
        font-family: Inter, sans-serif;
        color: #111;
        padding: 56pt 62pt;
      }
      .page *, .page *::before, .page *::after {
        box-sizing: inherit;
        margin: 0;
        padding: 0;
      }
    </style>
    <div class="page">
      <h1>${escapeHtml(data.title)}</h1>
      <p>${escapeHtml(data.body)}</p>
    </div>
  `
}
```

You call this function, pass the returned HTML to `pdf.download()`, and you're done.

---

### Escaping HTML

`escapeHtml()` is exported directly from the package – no need to write your own. **Always call it on any string that comes from user input** before inserting it into the HTML. Without it:

- A name like `O'Brien & Sons` will produce malformed HTML
- A value containing `<` or `>` will break the template structure
- In theory, an attacker could inject arbitrary HTML

Numbers and booleans are safe to interpolate directly – they cannot contain special HTML characters.

```ts
// safe – number
`<td>${item.qty}</td>`

// safe – boolean
`<div class="${isActive ? 'active' : ''}">`

// must escape – string from user
`<td>${escapeHtml(item.description)}</td>`
`<div class="name">${escapeHtml(user.fullName)}</div>`
```

`escapeHtml()` also escapes quote characters (`"` and `'`), so it's safe to use inside attribute values too:

```ts
`<div title="${escapeHtml(user.bio)}">`
```

---

### CSS

The CSS your layouts rely on works in daepdf, including:

- Flexbox and CSS Grid
- `border-radius`, `box-shadow`, `opacity`
- CSS gradients (linear, radial, and conic) – including gradient stops with partial alpha; a translucent-to-transparent fade renders as a real fade, not flattened to one opaque color
- `border-image` (9-slice, including gradient sources – see [Images](#images))
- CSS counters (`counter-reset`/`counter-increment`/`counter-set`, `counter()`/`counters()`) and list markers (`::marker`; `list-style-type` `disc`, `circle`, `square`, `disclosure-open`/`-closed`, `decimal`, `decimal-leading-zero`, `lower`/`upper-alpha` and `-latin`, `lower`/`upper-greek`, `lower`/`upper-roman`, or a quoted string – any other style, such as `armenian` or `cjk-decimal`, prints as `decimal` even where the browser shows it natively)
- `text-transform`, `letter-spacing`, `white-space`, `text-overflow: ellipsis`, `hyphens: auto`
- `::first-letter` and `::first-line`
- `outline` (width, style, color, offset – grows outward with a rounded box's own corner radius)
- `mix-blend-mode` (`multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`)
- `box-decoration-break: clone` (an inline element wrapped across multiple lines, or a block element split across pages, paints each fragment as its own complete box – full border/radius on every side – instead of one shape sliced at the break)
- Custom properties (`--my-var`)
- `@font-face` for custom fonts
- `calc()`, `min()`, `max()`, `clamp()`
- Multi-column layouts
- Pseudo-elements (`::before`, `::after`)
- 2D transforms (`rotate`, `scale`, `skew`, `matrix`), filters, masks, `clip-path` – see [Filters and masks](#filters-and-masks) for what filters/masks actually rasterize to
- `position: fixed` (see [Headers and footers](#headers-and-footers) – it repeats correctly on every page)

**3D transforms are not supported.** `matrix3d()`, `perspective()`, `rotate3d()`, and similar have no safe 2D equivalent to fall back to, so an element using any of them renders completely untransformed (a console warning tells you when this happens) rather than risk a wrong-looking projection.

**`mix-blend-mode` applies per paint operation, not per isolated stacking-context group.** PDF has no direct equivalent of CSS's group-isolation-based blend compositing – the nearest ancestor's blend mode applies each time something paints, which matches the common case (one blended element over its background) but can diverge from the browser for deeply nested or stacked blended elements.

Use `pt` (points) for sizing. Font sizes, padding, margin, gap, border-width – all of these in `pt` translate directly into the PDF without any conversion math.

```css
.page     { padding: 56pt 62pt; }
.heading  { font-size: 22pt; font-weight: 700; }
.body     { font-size: 9pt; line-height: 1.5; }
.divider  { border-top: 0.5pt solid #e0e0e0; }
```

#### Template CSS stays in the template, app CSS comes along

Your template is laid out in its own frame, so nothing in its CSS can reach your app. `body`, `html` and `:root` rules apply to the template's root, and `*` only matches the template's own elements.

It works the other way too: your app's stylesheets are copied into that frame, so a template can use your app's classes – Tailwind utilities, a Quasar or Vuetify grid, your own design system – and they resolve at the page's size. The flip side is that app-wide rules (a global `* { box-sizing }`, a `body` font) reach the template just as they reach your app's own pages.

Giving the template a root wrapper class and scoping your rules under it lets them win over app-wide element and class rules where the two disagree:

```css
.page { box-sizing: border-box; font-family: Inter, sans-serif; }
.page *, .page *::before, .page *::after {
  box-sizing: inherit;
  margin: 0;
  padding: 0;
}
```

---

### Filters and masks

`filter` and `mask-image` have no PDF operator equivalent, so an element using either is rasterized – its entire subtree (box, text, children) is painted to an offscreen canvas and embedded as one flattened image, with the filter/mask effect baked in.

The rasterizer paints background colors and gradients inside the element's rounded corners, images, and text word by word where the browser laid it out, in the template's own fonts. A `mask-image` can be a gradient or a `url()` image, sized, positioned and tiled through `mask-size`, `mask-position` and `mask-repeat` like a background. It is still a painter, not a layout engine, so it has real limits:

- **Text inside is pixels.** It can't be selected or searched, and text decorations (underlines and the like) aren't painted.
- **`url()` backgrounds aren't reproduced** inside the raster; gradients and colors are.
- **Only the top border is read.** Border width, style, and color are taken from the top side and applied uniformly to all four sides – a box with different per-side borders paints as if every side matched the top one.
- **`filter` and `mask-image` together only apply the filter.** If an element has both set, the mask is silently skipped rather than combined with the filtered result.
- **A cross-origin mask image needs CORS.** One served without CORS headers can't be read back from the canvas, so the masked element is skipped (the rest of the document still renders).

If you need selectable text under a filter or mask, restructure the template so the filter/mask applies to a plain decorative element (a box, an icon) rather than one containing real text.

**`background-clip: text`** (the "gradient text" trick, usually paired with `color: transparent` or `-webkit-text-fill-color: transparent`) has the same underlying problem for a different reason: a PDF box fill can't be clipped to glyph outlines. Instead of the real gradient, the text renders in a flat, solid color – the gradient's first color stop for a gradient background, the element's own plain `background-color` when there's no gradient (a `url()` image background falls back to this too, not to the image itself), or black as a last-resort default if neither is set.

---

### How templates are parsed and sanitized

Your HTML string is parsed with the browser's own `DOMParser` – never assigned to `innerHTML`, never executed. This is what makes it safe to render even before every string has been individually escaped: nothing in the parsed result can ever run as script.

As part of that same parsing pass, daepdf automatically removes:

- `<script>` tags, entirely
- Any `on*` event handler attribute (`onclick`, `onerror`, etc.)
- `javascript:` and `vbscript:` URLs in `href` attributes, and `data:` URLs too, except on an SVG `<image>` or `<feImage>`, which only display them
- `<link>` tags – external stylesheets are not fetched; inline your CSS in a `<style>` block instead (a console warning tells you when a stylesheet link was removed)
- `@import` inside a `<style>` block – inline the imported stylesheet's contents instead (also warned)
- `<object>`, `<embed>`, `<iframe>`, `<video>`, and `<audio>` tags, entirely, with no console warning – none of these have a PDF equivalent to fall back to

None of this requires configuration – it happens on every `render()`/`download()`/`previewHTML()` call, unconditionally.

**Two more guarantees that follow from the same mechanism, so you don't have to think about them:**

- **Your `<style>` block can go anywhere in the template string.** The browser's own HTML parser can silently relocate a `<style>` tag into the parsed document's `<head>` depending on where it sits in the markup – a well-known `DOMParser` quirk. daepdf collects styles from both the parsed head and body before injecting them, so this relocation never causes your CSS to go missing, regardless of where you wrote the `<style>` tag.
- **Two templates using the same class name never collide.** Every call gets its own internal CSS scope – reusing `.box` or `.header` across an invoice template and a CV template (even a live preview and an export running back to back) never lets one template's rule apply to the other's markup. A `body`/`:root`/`html` selector in your CSS applies to your own template's root, and since every template is laid out in its own frame, none of it can reach your app.

---

### Fonts

Declare fonts with `@font-face` inside your template's `<style>` block. Point `src` at the font file in your project's public folder. **Text prints only in declared fonts:** daepdf can't read the fonts installed on a machine, so text whose `font-family` list names no declared font (just `sans-serif`, say, or an `Arial` with no `@font-face` of its own) is left out, with a console warning naming the font.

```css
<style>
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter-var.ttf') format('truetype');
  font-weight: 100 900;
  font-style: normal;
}
.page { font-family: Inter, sans-serif; }
</style>
```

daepdf handles everything automatically:

- Detects the font in your CSS
- Fetches it and figures out its real format from the file's own contents – not from the `format()` hint or the file extension, so that part of the `@font-face` rule is only for the browser's own benefit
- Registers it with the PDF engine
- Subsets it – only the characters actually used in the document are embedded in the PDF, keeping file sizes small

**TTF, OTF and TTC (font collection) files work**, with no configuration difference between them. **WOFF and WOFF2 do not** – daepdf reads the font bytes directly and does not decompress them, so point `src` at the uncompressed file. A WOFF2 is reported by name rather than failing quietly. CFF2 fonts, static or variable, print as well, but a `pdfA` or `pdfUA` export that uses one doesn't pass validation yet.

If you serve WOFF2 to the browser for its smaller download, declare a second `@font-face` for daepdf pointing at the TTF, or serve the TTF and let daepdf subset it – only the characters the document actually uses are embedded.

**Variable fonts work.** A single variable font file covering a full weight range (e.g. 100–900) is supported and recommended.

**Multiple fonts work.** Declare as many `@font-face` blocks as you need – for example, a separate block for italic or a second typeface for headings.

**The font must be accessible from the browser.** The `url()` in `@font-face` is fetched by the browser, so it must be in your public folder and served over HTTP (or HTTPS). Local file paths (`C:\fonts\...`) do not work.

**A character your font doesn't have falls back automatically.** If your `font-family`'s first choice can't render a given character (an emoji, a CJK character in a Latin-only font), daepdf tries the rest of your declared `font-family` list first, then falls through to any other font registered anywhere in the document, before giving up on that one character. You don't need to declare a fallback font explicitly for this to happen – it always tries. A character followed by the emoji presentation selector (`❤️`) takes the first color font in your `font-family` list that has it, as browsers do.

**Color fonts print in color and copy as text.** Emoji and other color fonts print as their colored picture: COLR fonts (COLRv1, such as current Noto Color Emoji and Nabla, and COLR v0) as vector art that stays sharp at any zoom, with gradients, blending and a variable font's weight and optical size; bitmap fonts (Apple Color Emoji, the bitmap version of Noto Color Emoji) as the font's own images. Every color glyph copies and searches as its real characters, in Preview too, flags, skin tones and joined sequences included. One approximation: COLRv1's additive `PLUS` blending has no PDF equivalent and is drawn as `Screen`, slightly darker where two layers overlap.

---

### Ruled lines

An `<hr>`'s look (an inset border with margins) comes from the browser's own stylesheet, and on mobile Safari it can go missing from the export. For a divider you control, use a `<div>` with a `border-top`:

```css
.rule {
  border: none;
  border-top: 0.5pt solid #d2d2d2;
  height: 0;
  margin: 0;
}
```

```html
<div class="rule"></div>
```

This draws the same line on every browser and every device.

---

### Links and phone numbers

Mobile browsers (iOS Safari in particular) automatically detect phone numbers, email addresses, and sometimes URLs in plain text, and wrap them in `<a>` tags with blue styling. daepdf captures whatever color is rendered, so without a reset, your PDF will have unexpected blue text.

Add this to your template CSS:

```css
.page a { color: inherit; text-decoration: none; }
```

This applies to all `<a>` elements inside the template, whether you added them or the browser did.

An `<a href="https://...">` produces a real, clickable link annotation in the PDF. An `<a href="#anchorId">` produces a real internal jump-to link – see [Bookmarks and internal links](#bookmarks-and-internal-links).

**`http://`, `https://`, `mailto:`, `tel:` and `#fragment` hrefs become real clickable link annotations.** A relative href (`/pricing`, `terms.html`) is resolved against the page's address, so it still leads somewhere from the PDF. Any other URI scheme renders as plain text, not clickable.

---

### i18n and translation strings

If you use a translation system (i18n), store raw characters in your translation strings – not HTML entities.

```ts
// wrong – the & is already escaped
{ 'label': 'Sales &amp; Marketing' }

// correct – raw character, escapeHtml() will handle it
{ 'label': 'Sales & Marketing' }
```

`escapeHtml()` encodes `&` to `&amp;` when building the HTML. If the string is already `&amp;` and then `escapeHtml()` runs on it, the result is `&amp;amp;` – which renders literally as `&amp;` in the PDF instead of `&`.

---

## Live preview

daepdf includes a built-in preview renderer. It takes the same HTML string your template produces and renders it as paginated page cards directly in the browser – exactly what the PDF will contain, without exporting first.

```ts
import pdf, { previewHTML } from 'daeepdf'

const container = document.getElementById('preview')!
const html      = buildInvoiceHTML(data)

// Render the preview into a container element
previewHTML(html, container, { size: 'A4' })

// Export the exact same HTML – no second template, no duplication
await pdf.download(html, 'A4', 'invoice.pdf')
```

`previewHTML(html, container, config)` renders each page as a white card with a subtle shadow, stacked vertically inside the container. The template function is the single source of truth – the same call drives both the preview and the export. There is no second design and no duplication.

Each card holds its own page-sized frame, so the preview resolves `@media`, `vw`/`vh` and your app's stylesheets exactly the way the export does. `previewHTML` returns a promise that resolves once the pages are on screen. You don't have to await it: calls made while a render is still running are coalesced, and only the newest one renders.

**There is no separate "preview version" and "export version" of a document to build or keep in sync.** Your template function (`buildInvoiceHTML`, or whatever you call it) is the only place the document's design lives. Both the live preview and the real export just call it and hand the resulting string to a different daepdf function – `previewHTML` for an on-screen preview, `pdf.download`/`pdf.render` for the real file. If you change the template, both update automatically, because there is only one template to change. A minimal component-style wiring:

```ts
import pdf, { previewHTML } from 'daeepdf'
import { buildInvoiceHTML } from './invoiceTemplate.js'

function renderPreview() {
  previewHTML(buildInvoiceHTML(invoiceData), previewContainer, { size: 'A4' })
}

// call once on load, and again every time invoiceData changes (see Reactive updates below)
renderPreview()

exportButton.addEventListener('click', async () => {
  await pdf.download(buildInvoiceHTML(invoiceData), 'A4', 'invoice.pdf')
})
```

`buildInvoiceHTML` is called twice here – once for the preview, once for the export – but it is the exact same function both times, with no branching inside it for "am I being previewed or exported." If you use the [download utility pattern](#the-download-utility-pattern) instead of calling `pdf.download` directly, the wiring is identical – just swap the click handler's body for a call to your `downloadInvoice()` utility.

### Scaling

A4 is 794px wide at screen resolution (96dpi). Use the `zoom` property to scale the preview down to fit your panel, and recompute with a `ResizeObserver` when the container resizes:

```ts
const applyScale = () => {
  const avail = panel.clientWidth
  container.style.zoom = avail < 794 ? String(avail / 794) : ''
}
applyScale()
const ro = new ResizeObserver(applyScale)
ro.observe(panel)
```

### Reactive updates

When data changes, call `previewHTML` again with the new HTML string – the swap is atomic and flicker-free. For input-driven previews where the user is typing into form fields, debounce with `requestAnimationFrame` so rapid changes only trigger one render per frame:

```ts
let raf: number | null = null

function updatePreview() {
  if (raf !== null) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    previewHTML(buildInvoiceHTML(data), container, { size: 'A4' })
    raf = null
  })
}
```

### Fonts just work

Declare `@font-face` once, in your template – the same declaration used for PDF embedding. `previewHTML` detects it, loads it once into each preview page, and reuses it on every re-render. Pages are measured only after the font has loaded, so page breaks in the preview match the export. There is nothing else to configure: no second `@font-face` declaration in your app's global CSS and no repeated network fetch on every re-render.

### Without a preview

If you don't need a live preview, skip `previewHTML` entirely. Call `pdf.download()` directly:

```ts
await pdf.download(buildInvoiceHTML(data), 'A4', 'invoice.pdf')
```

Same template function, same output, no preview step.

---

## Document structure and navigation

Metadata, bookmarks, and headers/footers are all passed through the same `extras` argument as `pdf.download()`/`pdf.render()`'s last parameter.

```ts
// a header is laid out on its own, so it declares its font too (see Headers and footers)
const font = `<style>@font-face { font-family: 'Inter'; src: url('/fonts/inter-var.ttf'); }</style>`

await pdf.download(html, 'A4', 'report.pdf', undefined, {
  metadata:  { title: 'Q4 Report', author: 'Acme Inc.' },
  bookmarks: [{ title: 'Summary', page: 1 }, { title: 'Details', page: 2 }],
  header:    (page, total) => `${font}<div style="font:8pt Inter;text-align:right;">Page ${page} of ${total}</div>`,
})
```

### Metadata

Standard PDF document properties, visible in any PDF viewer's document info panel:

```ts
extras: {
  metadata: {
    title:    'Q4 Sales Report',
    author:   'Acme Inc.',
    subject:  'Quarterly performance summary',
    keywords: ['sales', 'q4', '2026'],
    creator:  'Acme Internal Tools',
    language: 'en-US',
  }
}
```

Every field is optional.

### Bookmarks and internal links

Pass a `bookmarks` array to build a real PDF outline (the panel most viewers show on the left):

```ts
extras: {
  bookmarks: [
    { title: 'Introduction', page: 1 },
    { title: 'Section 1',    page: 2, level: 1 },
    { title: 'Section 1.1',  page: 3, level: 2 },
    { title: 'Section 2',    page: 5, level: 1 },
  ]
}
```

`level` (default `0`) controls nesting depth in the outline tree – a bookmark at `level: 2` becomes a child of the nearest preceding bookmark at `level: 1`.

Add `y` (in pt, measured from the page's top edge) to scroll to a specific vertical position on that page instead of jumping straight to its top:

```ts
{ title: 'Section 2', page: 5, y: 220 }
```

For a clickable in-document link (a table of contents, a "back to top" link), give the target element a real `id` and point an `<a>` at it with a `#` prefix:

```html
<h2 id="section-2">Section 2</h2>
...
<a href="#section-2">Jump to Section 2</a>
```

This produces a real internal jump-to-page link in the PDF, not just a browser-only anchor.

### Headers and footers

`header` and `footer` are functions that receive the current page number and the total page count, and return an HTML string – rendered in a fixed band at the top or bottom of every page:

```ts
const font = `<style>@font-face { font-family: 'Inter'; src: url('/fonts/inter-var.ttf'); }</style>`

extras: {
  header: (page, total) => `${font}
    <div style="font:8pt Inter;color:#888;border-bottom:0.5pt solid #ddd;padding-bottom:4pt;">
      Acme Inc. – Confidential
    </div>
  `,
  footer: (page, total) => `${font}
    <div style="font:8pt Inter;color:#888;text-align:center;">
      Page ${page} of ${total}
    </div>
  `,
}
```

The header/footer band's height is measured automatically from its own content, and the main content area shrinks to make room for it – you don't need to add manual top/bottom padding to your page template to avoid overlap.

**That height is measured once, from a single representative page, not per page.** daepdf renders your `header`/`footer` callback once (as if it were page 1 of 1) to measure how tall its content actually is, then reuses that same height for every page. Ordinary page-number digit-count differences ("Page 1 of 1" vs. "Page 250 of 250") don't change a template's wrapped line height in practice, so this is not something to worry about in the typical case. If your header or footer's content is designed to genuinely vary in height from page to page (not just digit count – conditionally showing an extra line on some pages, for example), keep in mind that only the first-page measurement is used: taller content on a later page is clipped to that original height rather than growing the band or overflowing into your main content.

**Declare the font inside each `header`/`footer` string.** Each callback's HTML is laid out on its own and inherits nothing from your template, so give it an `@font-face` in that same string and a `font-family` naming it. With no declared font at all, its text is left out (a console warning names the font). Naming a font that only the main template declares prints it, but laid out with the browser's fallback font, so words can shift or get cut off.

`position: fixed` content placed directly in your main template (not inside `header`/`footer`) repeats on every page too, anchored at its own position on the page – useful for a watermark or a background stamp that isn't tied to the page-number logic `header`/`footer` provide. This repeats correctly both in the real PDF export and in `previewHTML`'s on-screen preview.

---

## Pagination and page breaks

### Automatic pagination

Content taller than one page continues onto additional pages automatically – there's nothing to configure for the common case. daepdf reproduces standard browser print behavior for how content actually splits, rather than just cutting wherever a page boundary happens to fall.

### Never split without warning

These are never sliced across a page boundary – if one would cross, it's pushed whole onto the next page instead:

- Images, `<canvas>`, and inline `<svg>`
- Table rows (`<tr>`)
- Flex and grid containers that fit on a page (the whole container moves together, not individual items within it)
- Any element with `break-inside: avoid` or `break-inside: avoid-page`

A flex or grid container taller than one page can't move as a unit, so daepdf steps inside it instead: an image, table row, or `break-inside: avoid` item that would otherwise be cut is pushed down within its own row or line, which grows to make room – the same thing a browser does when printing a tall grid. `break-before` and `break-after` on flex and grid items are honored the same way.

### Explicit break control

`break-before` / `break-after` force a page break immediately before or after any element – useful for "always start this section on its own page":

```css
.chapter { break-before: page; }
```

Accepted values: `page`, `left`, `right`, `recto`, `verso` – daepdf treats them all the same way (a single fresh page); it does not distinguish left-hand from right-hand pages for double-sided printing. This works on any element, not just specific tags, and it forces a break even on content that's nowhere near overflowing a page on its own (a single short paragraph with `break-before: page` still starts a new page).

The older `page-break-before` / `page-break-after` / `page-break-inside` property names work identically – browsers alias them to the modern `break-*` properties automatically (`page-break-before: always` becomes `page`), and daepdf reads the resolved computed value either way.

### Widows and orphans

Standard CSS `orphans` and `widows` are honored on the nearest paragraph, list item, table cell, or similar text-bearing block – both default to `2`, matching the CSS specification's own default:

```css
p { orphans: 3; widows: 3; }
```

- `orphans` – the minimum number of lines that must stay together at the **bottom** of a page before a break. If a paragraph would otherwise be split leaving fewer than this many lines above the break, and no earlier split point can satisfy it either, the **whole paragraph** moves to the next page instead of splitting.
- `widows` – the minimum number of lines that must carry over **together** to the **top** of the next page. If a natural break would leave fewer than this many lines after it, the split point moves earlier so at least this many lines move as a group.

### Table headers repeat across pages

A `<thead>`'s rows repeat automatically at the top of every page a table's body spans, matching what browsers already do when printing – no configuration needed.

**One real styling limitation worth knowing:** the repeated header rows on pages after the first are plain `<tr>` clones, not wrapped in a second `<thead>` element (wrapping them in a real `<thead>`, or giving them `display: table-header-group`, would pull them to the very top of the table per the CSS table layout algorithm – exactly the opposite of "appear at this page break"). This means a CSS rule scoped through the `thead` ancestor, like:

```css
/* only ever styles the row on the FIRST page – repeated copies don't match */
thead th { background: #eee; }
```

will only style the original row, not the repeated copies on later pages. Style header cells directly instead, so the rule matches every copy:

```css
/* matches every copy, first page and repeated */
th { background: #eee; }
/* or, if you need to be more specific than a bare tag selector */
.table-header-cell { background: #eee; }
```

---

## Vertical writing mode and right-to-left text

### Right-to-left and bidirectional text

Set `dir="rtl"` (or CSS `direction: rtl`) on any element to lay its text out right-to-left:

```html
<p dir="rtl">שלום עולם</p>
```

Full Unicode Bidi Algorithm resolution comes from the browser's own layout, not a reimplementation – a line mixing right-to-left script (Hebrew, Arabic) with an embedded left-to-right run (an English brand name, a phone number) resolves and positions each word exactly as the browser itself lays it out, reading each word's own already-correct position directly from the DOM rather than re-deriving bidi ordering from scratch.

### Vertical writing mode

`writing-mode: vertical-rl` or `writing-mode: vertical-lr` on a block lays its text out top-to-bottom in a column instead of left-to-right in a line:

```css
.column { writing-mode: vertical-rl; }
```

- `vertical-rl` – columns progress right to left (traditional Japanese/Chinese book layout)
- `vertical-lr` – columns progress left to right

Glyphs are drawn upright within the column, not rotated 90° – the correct rendering for real vertical CJK text, and matching how real PDF viewers and print output expect a vertical-writing-mode document to look.

**Scope of what's supported:** plain colored text down a column. The following are not applied specifically to vertical text (a deliberate, documented scope cut, since combining vertical writing with any of these is rare in practice): `text-decoration` (underline/overline/line-through), `text-shadow`, `text-overflow: ellipsis`, and `::first-letter`/`::first-line`. A vertical column is also expected to fit within a single page – content that would need to continue into a second page isn't specially split the way horizontal text's page breaks are.

There is no separate flag or CSS-like text meant only for daepdf here – both of these are standard CSS properties your browser already implements; daepdf reads the same computed values the browser itself uses to lay the content out.

---

## Interactive forms

Real `<input>`, `<textarea>`, and `<select>` elements in your template become real, fillable PDF form fields (AcroForm) – no extra API, just write the elements.

```html
<style>
  @font-face { font-family: 'Inter'; src: url('/fonts/inter-var.ttf'); }
  body { font-family: Inter; }
  input, textarea, select { font-family: Inter, sans-serif; font-size: 10pt; }
</style>
<label>Name <input type="text" name="fullName" value="Jane Doe"></label>
<label>Comments <textarea name="comments">Pre-filled text</textarea></label>
<label>
  Country
  <select name="country">
    <option value="us" selected>United States</option>
    <option value="ca">Canada</option>
  </select>
</label>
<label><input type="checkbox" name="subscribe" checked> Subscribe to updates</label>
```

The element's current `value` (or `checked` state) becomes the field's initial value in the PDF, and it also prints statically in the same spot – so the field looks right even in a viewer that doesn't render form widgets.

**Supported input types:** `text`, `email`, `tel`, `url`, `number`, `password`, `search` (or no `type` attribute at all), plus `checkbox` and `radio`. Other input types (`date`, `color`, `range`, `file`, and similar) have no PDF form-field equivalent: they become no field, and only the control's empty box prints, without its value – avoid them in export templates, or show the value in a plain `<div>` instead.

**Give every field's font-family an explicit value.** Browsers apply their own default control font to form elements rather than inheriting the page's font – an input with no `font-family` declared anywhere on it (directly or inherited) won't resolve a usable font for its PDF appearance.

**Radio buttons don't have true group exclusivity in the PDF.** Each radio input becomes its own independent field rather than one shared, mutually-exclusive group – a real, documented scope limit, not a bug.

Combine with the `'fillable'` security preset (see [PDF permissions](#pdf-permissions)) to make sure a PDF viewer actually allows editing the fields you just created.

---

## Accessibility, PDF/A and PDF/UA

Three optional flags on `extras`:

```ts
await pdf.download(html, 'A4', 'report.pdf', undefined, {
  taggedPdf: true,
})
```

**`taggedPdf: true`** builds a real structure tree (`/StructTreeRoot`) from your HTML's own semantic tags – `<h1>`–`<h6>` become headings, `<p>` becomes a paragraph, `<table>`/`<tr>`/`<td>`/`<th>` become table structure (header cells get a row or column scope, from their `scope` attribute or their position), `<ul>`/`<ol>`/`<li>` become list structure (each item's marker as its label, its content as its body), `<img alt="...">` and `<svg>` become tagged figures with their alt text (from `alt`, `aria-label` or the SVG's `<title>`; `alt=""` marks an image decorative), `<a>` becomes a link (holding its clickable link annotation, described by its `aria-label`, `title`, text, an image's alt text or its target, in that order), and form controls become form elements holding their fields (named by `aria-labelledby`, `aria-label`, their `<label>`, `title` or `placeholder`, in that order). Everything drawn that isn't content – backgrounds, borders, underlines, headers and footers – is marked as an artifact, so a screen reader skips it. This is what lets a screen reader announce your document's real reading order and structure instead of a flat stream of unrelated text and images. Using semantic HTML elements in your template (rather than, say, styling every heading as a plain `<div>`) is what makes this worth turning on.

To exclude purely decorative content from the reading order entirely (a background shape, a spacer `<div>`, a repeated icon) – rather than have it show up as a meaningless untitled element between real content – mark it `role="presentation"`, `role="none"`, or `aria-hidden="true"`. The whole subtree is skipped: no structure element, no marked content, nothing for a screen reader to stumble over.

```ts
await pdf.download(html, 'A4', 'report.pdf', undefined, {
  pdfA: true,
})
```

**`pdfA: true`** targets PDF/A-2a archival conformance (embeds an ICC color profile, XMP metadata, and implies `taggedPdf` – PDF/A's accessible conformance level requires the structure tree). PDF/A disallows encryption entirely: with `pdfA` set, the default security is skipped, and passing an explicit `security` as well throws immediately rather than silently producing a non-conformant file.

Output is checked with [veraPDF](https://verapdf.org) against PDF/A-2a, 2u and 2b on representative documents – headings, lists, a multi-page table, links, form fields, images, gradients with transparency, headers and footers, right-to-left and CJK text, vertical text, emoji (bitmap and COLRv1), filters and masks, and a 30-section document. That is a check, not a certification of every document you can write. One known gap: a document using a CFF2 font doesn't pass yet.

```ts
await pdf.download(html, 'A4', 'report.pdf', undefined, {
  pdfUA: true,
  metadata: { title: 'Quarterly report', language: 'en-US' },
})
```

**`pdfUA: true`** targets PDF/UA-1 (ISO 14289-1), the accessibility standard: it implies `taggedPdf`, declares PDF/UA in the XMP metadata, and makes viewers show the document title instead of the file name. PDF/UA requires a title, so `pdfUA` without `metadata.title` throws. It combines with `pdfA` (the file then declares both) and with encryption. Every figure needs alternative text; a console warning counts any that lack it. Checked with veraPDF against PDF/UA-1, alone and with PDF/A-2a, on the same representative documents.

PDF/A and PDF/UA forbid drawing the "missing glyph" box, so with `pdfA` or `pdfUA` a character that no registered font covers is left out (its space is kept, and a console warning says how many). Copying the text still gives the real characters. Register a font that covers every script you use with `@font-face`.

---

## Images

### Supported formats

daepdf officially supports exactly 4 raster image formats: **JPEG, PNG, WebP, and AVIF** (plus SVG as vector graphics, see [SVG and vector graphics](#svg-and-vector-graphics)).

`<img>` works with JPEG and PNG natively – decoded and embedded by daepdf itself, including CMYK JPEG and PNG transparency/indexed color (a PNG that is interlaced, not 8 bits per channel, or transparent by color key goes through the browser's decoder instead, like WebP and AVIF). A wide-gamut image (Display P3, Adobe RGB) keeps its embedded color profile, so it prints with the colors the browser shows.

**WebP and AVIF also work**, decoded by the browser itself rather than by daepdf – daepdf detects the format from the file's own contents and hands it to the browser's own image decoder, re-embedding the resulting pixels directly, converted to sRGB as the browser shows them.

**No other raster format is supported.** GIF, BMP, ICO, and TIFF are detected and skipped rather than embedded, valid file or not – a `<img>`/background-image pointing at one of these is silently omitted from the export.

**File size varies significantly by format.** JPEG is the only format whose own compressed bytes are reused as-is in the output PDF (DCT passthrough – no re-encoding at all). PNG, WebP, and AVIF are all embedded as plain DEFLATE-compressed raw pixels instead – none of PNG's own row-filtering or WebP/AVIF's own (much stronger) encoding survives the round trip. For a large photographic image this adds up fast: the same photo measured ~800KB exported as JPEG versus ~3.7MB exported as PNG, WebP, or AVIF in real testing. If output file size matters and the image doesn't need transparency, JPEG is the better source format to point `<img>`/`background-image` at.

### Object-fit and background images

`object-fit` (`cover`, `contain`, `fill`, `none`, `scale-down`) and `object-position` on `<img>` work as expected, including clipping to the element's own border-radius.

`background-image` supports everything you'd expect from the browser: `background-size` (including `cover`/`contain`), `background-position`, `background-repeat` (including `repeat-x`/`repeat-y`, `round` and `space`), `background-origin`, and `background-clip` (`border-box`/`padding-box`/`content-box`). `background-attachment: fixed` is also supported, with its print-appropriate meaning: the image anchors to the *page*, repeating at the same position on every page it spans, rather than to the browser viewport.

`border-image` (source/slice/width/outset/repeat) works too – full 9-slice image borders, with `stretch`/`repeat`/`round`/`space` tiling on each edge. The source can be a `url()` image or a CSS gradient (linear, radial, or conic) – a gradient border-image has no intrinsic size of its own, so it's rendered at the border area's own size. A cross-origin `url()` source needs CORS headers; without them the border image is skipped.

---

## SVG and vector graphics

Both `<img src="logo.svg">` and inline `<svg>` elements are converted to real vector paths in the PDF automatically, whenever the SVG's contents allow it – paths, basic shapes, strokes, fills, nested transforms, linear/radial gradients, and `<use href="#id">` references (the common icon-sprite pattern) all convert cleanly, keeping the output crisp at any zoom level and small in file size.

An SVG that uses a feature with no vector equivalent here – `<filter>`, `<mask>`, `<pattern>`, `<clipPath>`, `<foreignObject>`, `<text>`, a nested raster `<image>`, a nested `<svg>`, a `<style>` block, a gradient stroke, or a gradient fill in user-space units or inherited through `href` (as Figma, Illustrator and Inkscape export) – falls back to a high-resolution raster embed automatically for that whole SVG. Nothing to configure either way; you always get the best available representation.

---

## Dynamic filenames

The filename is a plain string – interpolate whatever your app knows at export time.

```ts
// Invoice with an auto-incrementing number, zero-padded
const filename = `Invoice_${String(invoice.number).padStart(4, '0')}.pdf`
// → Invoice_0042.pdf

// Named after the user
const filename = `${pdf.name(user.fullName)}_CV.pdf`
// → John_Doe_CV.pdf

// Named after a client with a reference number
const filename = `${pdf.name(client.name)}_Invoice_${ref}.pdf`
// → Acme_Corp_Invoice_AE-2026-01.pdf

// Dated report
const filename = `Report_${new Date().toISOString().slice(0, 10)}.pdf`
// → Report_2026-06-29.pdf

// Receipt with a transaction ID
const filename = `Receipt_${transaction.id}.pdf`
// → Receipt_txn_abc123.pdf
```

Always run any value from user input through `pdf.name()` before using it in the filename. Values you control (like a formatted date or an ID from your database) are fine as-is.

---

## The download utility pattern

Calling `pdf.download()` directly from a button click works for the simplest cases, but in a real app you want:

- A **double-click guard** so the user can't trigger two simultaneous exports
- A **loading state** to disable the button and show a spinner
- **Error handling** so the user gets feedback if something goes wrong

Here is the pattern – create a utility function per document type:

```ts
import pdf from 'daeepdf'
import { buildInvoiceHTML } from './invoiceTemplate.js'
import type { InvoiceData } from './invoiceTemplate.js'

// Module-level flag – shared across all calls to this function
let _exporting = false

interface ExportCallbacks {
  onStart: () => void   // called before export begins
  onDone:  () => void   // called when export finishes (success or error)
  onError: (message: string) => void
}

export async function downloadInvoice(
  data: InvoiceData,
  callbacks: ExportCallbacks,
): Promise<void> {
  if (_exporting) return   // ignore the second click
  _exporting = true
  callbacks.onStart()

  try {
    const html     = buildInvoiceHTML(data)
    const filename = `Invoice_${pdf.name(data.from.name)}_${data.number}.pdf`
    await pdf.download(html, 'A4', filename)
  } catch (err) {
    callbacks.onError(err instanceof Error ? err.message : 'Export failed')
  } finally {
    _exporting = false
    callbacks.onDone()   // always called, even on error
  }
}
```

The `_exporting` flag lives at module scope, so it's shared across every call. The `finally` block ensures `onDone` always fires and the flag always resets – even if the export throws.

---

## Framework integration

daepdf is browser-only. In server-side rendering frameworks, you must make sure the import and any calls only happen on the client.

### SvelteKit

In SvelteKit, any code inside `<script>` tags in `.svelte` files runs on both server and client during SSR. Import daepdf dynamically inside an event handler or inside `onMount`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte'

  let exportPDF: (() => Promise<void>) | null = null

  onMount(async () => {
    // Dynamic import – only runs in the browser
    const { downloadInvoice } = await import('$lib/pdf/pdfUtils.js')
    exportPDF = () => downloadInvoice(data, {
      onStart: () => loading = true,
      onDone:  () => loading = false,
      onError: (msg) => toast(msg),
    })
  })

  let loading = false
</script>

<button on:click={exportPDF} disabled={!exportPDF || loading}>
  {loading ? 'Exporting...' : 'Download PDF'}
</button>
```

Alternatively, place your export logic in a file under `src/lib/` and only call it from client-side code (event handlers, `onMount`). Never call it from `load()` functions or server hooks.

### Next.js

In Next.js (App Router or Pages Router with SSR), use a dynamic import inside a `useEffect` or event handler, and make sure the component file has `'use client'` if you're using App Router:

```tsx
'use client'

import { useState } from 'react'

export function ExportButton({ data }: { data: InvoiceData }) {
  const [loading, setLoading] = useState(false)

  async function handleExport() {
    // Dynamic import ensures this never runs on the server
    const { downloadInvoice } = await import('@/lib/pdf/pdfUtils')
    await downloadInvoice(data, {
      onStart: () => setLoading(true),
      onDone:  () => setLoading(false),
      onError: (msg) => alert(msg),
    })
  }

  return (
    <button onClick={handleExport} disabled={loading}>
      {loading ? 'Exporting...' : 'Download PDF'}
    </button>
  )
}
```

If you're on the Pages Router, you can also use `next/dynamic` with `{ ssr: false }` to wrap a component that imports daepdf at the module level.

### Vue / Nuxt

In Nuxt 3 (or any Vue SSR setup), use `onMounted` and a dynamic import:

```vue
<script setup lang="ts">
import { ref, shallowRef, onMounted } from 'vue'

const props    = defineProps<{ data: InvoiceData }>()
const loading  = ref(false)
// a ref, so the button enables once the import lands
const exportFn = shallowRef<(() => Promise<void>) | null>(null)

onMounted(async () => {
  const { downloadInvoice } = await import('~/lib/pdf/pdfUtils')
  exportFn.value = () => downloadInvoice(props.data, {
    onStart: () => { loading.value = true },
    onDone:  () => { loading.value = false },
    onError: (msg) => alert(msg),
  })
})

async function handleClick() {
  await exportFn.value?.()
}
</script>

<template>
  <button @click="handleClick" :disabled="loading || !exportFn">
    {{ loading ? 'Exporting...' : 'Download PDF' }}
  </button>
</template>
```

Or add `client-only` around the component and import daepdf at the module level inside a `.client.vue` file.

**The rule for all frameworks:** never let daepdf code run during server-side rendering. Dynamic imports and `onMount`/`useEffect`/`onMounted` are the safe patterns.

---

## PDF permissions

Every export is encrypted by default. A random owner password is generated automatically for each export. The file opens freely – there is no user password unless you set one. Default permissions: print and copy are allowed; modifying, annotating, and filling forms are blocked.

Encryption uses AES-256 (the modern PDF 2.0 standard security handler), not the legacy 40/128-bit RC4 scheme older tools sometimes default to.

### Presets

The easiest way to set permissions. Pass a string as the fourth argument to `pdf.download()`:

```ts
// Print and copy – nothing else
await pdf.download(html, 'A4', 'file.pdf', 'read-only')

// Same as read-only
await pdf.download(html, 'A4', 'file.pdf', 'printable')

// Print, copy, and fill interactive forms
await pdf.download(html, 'A4', 'file.pdf', 'fillable')

// Completely locked – no printing, no copying, nothing
await pdf.download(html, 'A4', 'file.pdf', 'locked')

// No encryption at all – fully open PDF
await pdf.download(html, 'A4', 'file.pdf', 'open')
```

| Preset | Print | Copy | Modify | Annotate | Fill forms |
|---|---|---|---|---|---|
| `'read-only'` | Yes | Yes | No | No | No |
| `'printable'` | Yes | Yes | No | No | No |
| `'fillable'` | Yes | Yes | No | No | Yes |
| `'locked'` | No | No | No | No | No |
| `'open'` | – | – | – | – | – (no encryption) |

### Custom permissions

If you need fine-grained control:

```ts
await pdf.download(html, 'A4', 'file.pdf', {
  userPassword:  'secret',      // PDF viewer prompts for this on open; omit or use '' for no prompt
  ownerPassword: 'ownerpass',   // controls permission settings; a random one if omitted
  permissions: {
    print:     true,
    copy:      false,
    modify:    false,
    annotate:  false,
    fillForms: true,
  },
})
```

A permission you leave out of `permissions` is allowed – only the ones set to `false` are blocked. List every permission you want to restrict.

### Disable encryption entirely

If you don't want any security at all – no password, no permission restrictions, nothing – `'open'` and `null` are exactly equivalent; use whichever reads more clearly at the call site:

```ts
await pdf.download(html, 'A4', 'file.pdf', 'open')
await pdf.download(html, 'A4', 'file.pdf', null)
```

Both produce a completely unencrypted PDF – no `/Encrypt` dictionary at all, openable and editable in any viewer with no restrictions.

`pdfA: true` (see [Accessibility, PDF/A and PDF/UA](#accessibility-pdfa-and-pdfua)) always produces an unencrypted file – PDF/A does not allow encryption at all.

### Default – omit the argument

```ts
await pdf.download(html, 'A4', 'file.pdf')
// auto-encrypts with a random owner password
// print + copy allowed, everything else blocked
```

The `security` parameter works the same way on `pdf.render()`, as the third argument:

```ts
const bytes = await pdf.render(html, 'A4', 'locked')
```

---

## Security best practices

### Escape user data

Every string that comes from user input must go through `escapeHtml()` before being inserted into your template HTML. This prevents broken output and protects against HTML injection.

```ts
// always escape user strings
`<div>${escapeHtml(user.name)}</div>`
`<td>${escapeHtml(item.description)}</td>`
`<p>${escapeHtml(address.line1)}</p>`

// numbers and booleans are fine as-is
`<td>${item.qty}</td>`
`<td>${item.price.toFixed(2)}</td>`
```

### Sanitize filenames

Use `pdf.name()` on any user-provided value that becomes part of the filename. Without it, a name like `../../../etc/passwd` could be an issue depending on how the file is handled downstream.

```ts
const filename = `${pdf.name(user.name)}_Invoice.pdf`
```

### Scope your CSS

Scope template rules under a root wrapper class. Template CSS can't leak into your app, but your app's stylesheets do apply to the template, and scoped rules win over app-wide element and class rules.

---

## Mobile

daepdf works on mobile browsers – iOS Safari, Chrome for Android, Samsung Internet, and others.

**The export always runs at the full desktop page size.** On mobile, screen width is narrow, but daepdf renders at the full PDF width (595pt for A4) regardless. Media queries and `vw`/`vh` in your template and your app's CSS see that page width too, so a responsive template never switches to its phone layout in the PDF. The user gets the proper desktop-layout document, not a zoomed-out version of a mobile layout.

**Thin elements are handled correctly.** Ruled lines, borders, and dividers with sub-pixel heights are captured even when the browser reports their height as less than 1px. daepdf only skips an element if both its width and height are near-zero – so a full-width divider is always included.

**Phone numbers and emails.** iOS Safari automatically turns detected phone numbers and email addresses into blue `<a>` links. Add the link reset CSS to your template to prevent this from appearing in the PDF:

```css
.page a { color: inherit; text-decoration: none; }
```

---

## WYSIWYG

daepdf captures layout directly from the browser DOM. Text baselines, element positions, colors, and spacing are all read from computed values – not estimated or approximated.

This means:

- The preview in your browser is the PDF
- If it looks right in the browser, it will look right in the PDF
- Font rendering, line heights, and spacing are exact
- There is no "PDF mode" to test separately from your preview

The only way the output can differ from the preview is if your CSS uses features that are measured differently in the PDF engine – but for standard layouts using the properties listed in the CSS section, what you see is what you get.

---

## TypeScript types

These types are available as named imports from `'daeepdf'`:

```ts
import type {
  PageSize,
  PageConfig,
  PDFSecurity,
  PDFMetadata,
  BookmarkEntry,
  SecurityPreset,
  SecurityOption,
  RenderExtras,
  HTMLToPDFOptions,
  FontBridgeMap,
} from 'daeepdf'
```

### `PageSize`

```ts
type PageSize =
  | 'A3' | 'A4' | 'A5'
  | 'Letter' | 'Legal' | 'Tabloid'
  | { width: number; height: number }
```

### `PageConfig`

```ts
interface PageConfig {
  size:         PageSize
  orientation?: 'portrait' | 'landscape'
}
```

### `PDFSecurity`

```ts
interface PDFSecurity {
  userPassword?:  string
  ownerPassword?: string
  permissions?: {
    print?:     boolean
    copy?:      boolean
    modify?:    boolean
    annotate?:  boolean
    fillForms?: boolean
  }
}
```

### `PDFMetadata`

```ts
interface PDFMetadata {
  title?:    string
  author?:   string
  subject?:  string
  keywords?: string[]
  creator?:  string
  language?: string
}
```

### `BookmarkEntry`

```ts
interface BookmarkEntry {
  title:  string
  page:   number
  y?:     number
  level?: number
}
```

### `SecurityPreset`

```ts
type SecurityPreset = 'read-only' | 'printable' | 'fillable' | 'locked' | 'open'
```

### `SecurityOption`

```ts
type SecurityOption = SecurityPreset | PDFSecurity | null
```

### `RenderExtras`

The fourth/fifth-argument shape for `pdf.download()`/`pdf.render()`, covered throughout this README:

```ts
interface RenderExtras {
  metadata?:    PDFMetadata
  bookmarks?:   BookmarkEntry[]
  orientation?: 'portrait' | 'landscape'
  header?:      (page: number, totalPages: number) => string
  footer?:      (page: number, totalPages: number) => string
  taggedPdf?:   boolean
  pdfA?:        boolean
  pdfUA?:       boolean
}
```

### `HTMLToPDFOptions`

The options object for [`renderHTMLtoPDF()`](#renderhtmltopdfhtml-config-options-fonts):

```ts
interface HTMLToPDFOptions {
  metadata?:  PDFMetadata
  security?:  PDFSecurity | null
  bookmarks?: BookmarkEntry[]
  header?:    (page: number, totalPages: number) => string
  footer?:    (page: number, totalPages: number) => string
  taggedPdf?: boolean
  pdfA?:      boolean
  pdfUA?:     boolean
}
```

### `FontBridgeMap`

```ts
interface FontBridgeMap {
  [cssFontFamily: string]: { name: string; style: string; weight: number }
}
```

---

## Complete examples

The patterns below are filename conventions for different document types, layered on top of whatever `buildDocumentHTML`-equivalent function you end up with (see [Suggested project structure](#suggested-project-structure)).

### CV / résumé

```ts
const filename = `${pdf.name(user.fullName)}_CV.pdf`
await pdf.download(buildCvHTML(state, locale), 'A4', filename)
```

### Cover letter

```ts
const suffix   = t(locale, 'coverLetter.filenameSuffix')
const filename = `${pdf.name(firstName)}_${pdf.name(lastName)}_${suffix}.pdf`
await pdf.download(buildCoverLetterHTML(state, locale), 'A4', filename)
```

### Report with a date

```ts
const date     = new Date().toISOString().slice(0, 10)
const filename = `Report_${date}.pdf`
await pdf.download(buildReportHTML(data), 'A4', filename)
```

### Receipt with transaction ID

```ts
const filename = `Receipt_${transaction.id}.pdf`
await pdf.download(buildReceiptHTML(transaction), 'A4', filename)
```

### Quote or proposal

```ts
const filename = `${pdf.name(client.name)}_Quote_${quote.ref}.pdf`
await pdf.download(buildQuoteHTML(quote), 'A4', filename)
```

---

## Troubleshooting

### The PDF downloads but it's blank

Either your template HTML isn't reaching daepdf, or its text has no font to print in. Check:

- The string returned by your template function is not empty
- There are no uncaught exceptions before `pdf.download()` is called
- The root element has padding or visible content (a zero-height container produces a blank page)
- The text's `font-family` names a font your template declares with `@font-face`; text in an undeclared font is left out, and a console warning names the font (see [Fonts](#fonts))

### Fonts are not showing in the PDF

- The font must be declared with `@font-face` in the template itself (and in each `header`/`footer` string that uses it); a console warning names any font that isn't
- The font file URL in `@font-face` must be reachable from the browser at export time
- Check the network tab in DevTools for a failed font fetch
- The font must be in your public folder and served over HTTP/HTTPS

### Styles from my app are affecting the template

Your app's stylesheets are copied into the frame the template is laid out in, so app-wide rules reach template elements just as they reach your own pages. That's what lets templates use your app's classes. Scope the template's rules under a root wrapper class so they win where they need to. See the [CSS](#css) section.

### The PDF looks different from the browser preview

- `vw`, `vh` and `@media` resolve against the page's content area – the page minus any header/footer bands – not your browser window. For A4 portrait with no header or footer, that's 794×1123px.
- `position: fixed` is fully supported and repeats correctly on every page – if something still looks off, check that the fixed element's own size and position are what you expect at the PDF's actual page dimensions, not your current viewport size.

### Mobile: section dividers are missing in the export

Use `<div class="rule">` with `border-top` instead of `<hr>`. See [Ruled lines](#ruled-lines).

### Mobile: phone numbers appear blue in the PDF

Add `.page a { color: inherit; text-decoration: none; }` to your template CSS. See [Links and phone numbers](#links-and-phone-numbers).

### "SyntaxError: Importing binding name is not found"

You are importing a named export from `'daeepdf'` that is not exported. Check the [TypeScript types](#typescript-types) section for the full list of available named exports, and the [API reference](#api-reference) for functions (`previewHTML`, `renderHTMLtoPDF`, `escapeHtml`). Everything else is on the default export, `pdf`: `download`, `render`, `warmup` and `name`.

### daepdf causes an error during SSR / server build

You are importing daepdf at the module level in a file that runs on the server. Use a dynamic import inside `onMount`, `useEffect`, or an event handler. See [Framework integration](#framework-integration).

### A form field is missing from the exported PDF

Check that the element is one of the supported types – see [Interactive forms](#interactive-forms). Also check that its `font-family` resolves to something explicit, either directly or inherited; a form control with no resolvable font drops its printed appearance (the field itself, its name and value, still exist in the PDF – only the static preview text is affected).

## Used by

- [Beom CV](https://beomcv.com/) – A Free CV Maker
