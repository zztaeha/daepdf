# daepdf

A browser-based HTML-to-PDF engine powered by Rust and WebAssembly. You design your document as HTML and CSS, daepdf captures the exact layout your browser renders, and rebuilds it as a real PDF that matches pixel for pixel – not a screenshot of the page. Text stays selectable, searchable and copyable in subsetted embedded fonts, SVGs become vector paths, and JPEGs are embedded without re-encoding.

No server. No headless browser. No layout approximation. What the browser shows is what the PDF contains.

Text is only rasterized inside an element that uses CSS `filter` or `mask-image`, and an SVG becomes an image only when it uses a feature with no vector equivalent. See [Filters and masks](https://zztaeha.dev/daepdf/#filters-and-masks) and [SVG and vector graphics](https://zztaeha.dev/daepdf/#svg-and-vector-graphics).

**The documentation is at [zztaeha.dev/daepdf](https://zztaeha.dev/daepdf/).**

## Installation

```
npm i daeepdf
```

The package is published as `daeepdf` – the extra `e` is there because `daepdf` was already taken on npm. The project, the repository and the import's default export are all still daepdf.

That's it. The build output is published, so nothing is compiled on your machine and no build tooling is added to your project. No copying source files, no editing `tsconfig.json`, no path aliases.

```ts
import pdf from 'daeepdf'
```

Vite, webpack 5+ and the frameworks built on Vite ship the engine file with your build on their own. esbuild needs one file copied: see [Installation](https://zztaeha.dev/daepdf/#installation).

## Quick start

Here is the minimum working example – a one-page PDF with a heading and a paragraph. Text prints only in a font the template declares with `@font-face`, so point `src` at a TTF or OTF your app serves (see [Fonts](https://zztaeha.dev/daepdf/#fonts)):

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

## What it does

- **The CSS you already write.** Flexbox, grid, gradients, 2D transforms, multi-column layouts, counters and more. See [CSS](https://zztaeha.dev/daepdf/#css).
- **Fonts.** TTF, OTF and TTC, variable fonts included, subset to the characters a document uses. Color emoji print in color and copy as text. See [Fonts](https://zztaeha.dev/daepdf/#fonts).
- **Images and SVG.** JPEG, PNG, WebP and AVIF, with SVG as real vector paths. See [Images](https://zztaeha.dev/daepdf/#images) and [SVG and vector graphics](https://zztaeha.dev/daepdf/#svg-and-vector-graphics).
- **Pagination.** Automatic page breaks, `break-before` and `break-after`, widows and orphans, and table headers that repeat. See [Pagination and page breaks](https://zztaeha.dev/daepdf/#pagination-and-page-breaks).
- **A live preview** from the same template as the export. See [Live preview](https://zztaeha.dev/daepdf/#live-preview).
- **Metadata, bookmarks, internal links, headers and footers.** See [Document structure and navigation](https://zztaeha.dev/daepdf/#document-structure-and-navigation).
- **Right-to-left and vertical text.** See [Vertical writing mode and right-to-left text](https://zztaeha.dev/daepdf/#vertical-writing-mode-and-right-to-left-text).
- **Fillable forms** from `<input>`, `<textarea>` and `<select>`. See [Interactive forms](https://zztaeha.dev/daepdf/#interactive-forms).
- **Tagged PDF, PDF/A-2a and PDF/UA-1**, checked with veraPDF. See [Accessibility, PDF/A and PDF/UA](https://zztaeha.dev/daepdf/#accessibility-pdfa-and-pdfua).
- **AES-256 encryption and permissions**, on by default. See [PDF permissions](https://zztaeha.dev/daepdf/#pdf-permissions).

## Limits

daepdf runs in the browser only: not in Node.js or Bun, and not during server-side rendering. It ships as ES modules, with no CommonJS build. See [Limitations](https://zztaeha.dev/daepdf/#limitations), and [Framework integration](https://zztaeha.dev/daepdf/#framework-integration) for SvelteKit, Next.js and Nuxt.

## Documentation

| | |
|---|---|
| [Getting started](https://zztaeha.dev/daepdf/#installation) | Installation, a quick start, the limits, framework integration, mobile |
| [Templates](https://zztaeha.dev/daepdf/#templates) | Structure, escaping, CSS, fonts, images, links |
| [Documents](https://zztaeha.dev/daepdf/#page-sizes-and-orientation) | Page sizes, live preview, navigation, pagination, forms, accessibility, permissions |
| [Patterns](https://zztaeha.dev/daepdf/#dynamic-filenames) | Filenames, a download utility, complete examples, security |
| [Reference](https://zztaeha.dev/daepdf/#api-reference) | [API reference](https://zztaeha.dev/daepdf/#api-reference), [TypeScript types](https://zztaeha.dev/daepdf/#typescript-types), [Troubleshooting](https://zztaeha.dev/daepdf/#troubleshooting) |

Release notes are on the [releases page](https://github.com/zztaeha/daepdf/releases). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Used by

- [Beom CV](https://beomcv.com/) – A Free CV Maker

## License

MIT. See [LICENSE](LICENSE).
