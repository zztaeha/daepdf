# Security Policy

## Supported Versions

Security fixes land on the latest published version on npm. Older majors, 2.x
included, do not receive them.

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/zztaeha/daepdf/security/advisories/new)
(Security tab → "Report a vulnerability") rather than opening a public issue.

This is a solo-maintained project. I'll acknowledge reports as quickly as I can,
generally within a few days, and aim to have a fix out within a reasonable window
depending on severity. There's no bug bounty, but real, responsibly-disclosed
reports are genuinely appreciated.

## How daepdf runs

Worth knowing before reading the scope, because it shapes what a vulnerability
here can actually reach:

- **Everything runs in the browser**, in the calling page's own origin. There is
  no server component and no headless browser.
- **The only network requests are the ones your template asks for** – fonts named
  in `@font-face`, images referenced by `<img>`/`background-image` – plus the
  engine's own `.wasm`. No telemetry, no analytics, no other outbound calls.
- **The rendering engine is built from this repository.**
  `src/daegun/wasm/daegun.wasm` is compiled from `engine/`, a small Rust wrapper
  around [daegun](https://github.com/zztaeha/daegun) 1.2.0 from crates.io,
  pinned by `engine/Cargo.lock` (with its checksum) and `engine/rust-toolchain.toml`.
  `engine/build.sh` rebuilds it, with binaryen's `wasm-opt` 132; the build is
  reproducible (the same bytes from any checkout path), so the shipped binary can
  be checked against its source. daegun has no dependencies and forbids unsafe
  code outside its C API, which the wrapper does not use.

## Scope

Things that count as a security issue here:

- **Sanitization bypass.** daepdf parses your HTML with the browser's own
  `DOMParser` and never assigns to `innerHTML`. Before rendering it removes `<script>`,
  `<link>`, `<object>`, `<embed>`, `<iframe>`, `<video>` and `<audio>` elements,
  every `on*` event handler attribute, and `javascript:`/`data:`/`vbscript:` URLs
  in `href` and in SVG's `xlink:href`. A way to get script execution past that,
  in either the live preview or the exported PDF, is a real vulnerability rather
  than just a bug. The live preview matters as much as the export here: it
  injects into the calling page's live DOM.
- **Parser crashes or memory-safety issues in the WASM engine** – font
  (TTF/OTF/TTC) parsing that crashes, hangs, or exhibits undefined behavior on
  malformed or adversarial input.
- **Parser crashes in the TypeScript renderer** – image (JPEG/PNG) or SVG parsing
  that crashes or hangs on malformed or adversarial input. These run outside
  WASM, so the concern is a thrown exception, an unbounded allocation or a hang,
  not memory corruption. WebP and AVIF are handed to the browser's own decoder
  rather than parsed here.
- **Encryption flaws.** The AES-256 revision-6 standard security handler is a
  hand-rolled implementation (SHA-256/384/512, AES-CBC), not the browser's native
  WebCrypto. The primitives are checked against published FIPS vectors and the
  full handler round-trips against OpenSSL in the test suite, but a flaw that
  weakens or bypasses PDF encryption is in scope.
- **Supply chain** – anything suggesting the published npm package does not match
  this repository's source, or that the shipped `.wasm` does not match what its
  crate builds.

## Out of scope

- Issues that only reproduce with a template author's own unescaped interpolation
  of user input (see the README's
  [Escaping HTML](https://github.com/zztaeha/daepdf#escaping-html) section) –
  that's the caller's responsibility, not daepdf's.
- **PDF permission flags being ignored by a viewer.** Permissions (print, copy,
  modify) are bound into the encryption, but nothing forces a reader to honor
  them, and any tool holding the owner password can lift them. They express
  intent; they are not a hard security boundary, and the PDF specification does
  not make them one.
- The owner password appearing in memory or in a debugger. Everything runs
  client-side by design, so anything the page can compute, the user can inspect.
- Missing security headers or hardening on unrelated infrastructure (npm's own
  registry, GitHub itself, and so on) – report those upstream instead.
