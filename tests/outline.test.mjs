import { readPdf } from './pdfread.mjs'

export default async function ({ test, eq, ok, load }) {
  const { PdfDoc } = await load('tests/_entry.ts')

  const withBookmarks = list => {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10)
    d.set_page(2); d.rect(0, 0, 10, 10)
    for (const [title, page, level] of list) d.add_bookmark(title, page, 0, level)
    return d.output()
  }
  const outlineOf = bytes => readPdf(bytes).outline

  const shape = nodes => (nodes ?? []).map(n => n.title + (n.items?.length ? `(${shape(n.items).join(' ')})` : ''))

  test('named destinations form a sorted name tree', () => {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10)
    for (const id of ['zeta', 'alpha', 'mid', 'Beta']) d.add_named_dest(id, 1, 0)
    const out = Buffer.from(d.output()).toString('latin1')
    const keys = [...(out.match(/\/Names \[([^\n]*)\]/)?.[1] ?? '').matchAll(/\(([^)]*)\) \[/g)].map(m => m[1])
    eq(keys.join(','), 'Beta,alpha,mid,zeta')
  })

  {
    const o = await outlineOf(withBookmarks([['A', 1, 0], ['B', 2, 0]]))
    test('a flat outline comes back flat', () => eq(shape(o).join(' '), 'A B'))
  }

  {
    const o = await outlineOf(withBookmarks([['A', 1, 0], ['A1', 1, 1], ['A2', 1, 1], ['B', 2, 0]]))
    test('nesting is preserved', () => eq(shape(o).join(' '), 'A(A1 A2) B'))
  }

  {
    // level jumps 0 -> 2 with no level-1 parent in between
    const o = await outlineOf(withBookmarks([['A', 1, 0], ['deep', 1, 2], ['B', 1, 0]]))
    const flat = JSON.stringify(o)
    test('a skipped level does not lose the entry', () =>
      ok(flat.includes('deep'), `entry vanished from the outline: ${flat}`))
  }

  {
    const o = await outlineOf(withBookmarks([['past end', 99, 0]]))
    test('a bookmark pointing past the last page is clamped', () => ok((o ?? []).length === 1, JSON.stringify(o)))
  }

  {
    const d = new PdfDoc(200, 200); d.rect(0, 0, 10, 10)
    const o = await outlineOf(d.output())
    test('a document with no bookmarks has no outline', () => ok(o === null || o.length === 0, JSON.stringify(o)))
  }

  {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10)
    d.set_page(2); d.rect(0, 0, 10, 10)
    d.set_page(1)
    d.add_link_annotation(0, 0, 50, 20, 'https://example.com/')
    d.add_goto_annotation(0, 30, 50, 20, 2, 0)
    const anns = readPdf(d.output()).getPage(1).annotations()
    test('two annotations on page 1', () => eq(anns.length, 2, JSON.stringify(anns.map(a => a.subtype))))
    test('the link keeps its url', () => ok(anns.some(a => a.url === 'https://example.com/'),
      JSON.stringify(anns.map(a => a.url))))
    test('links are flagged to print, as PDF/A requires', () => eq(anns.map(a => a.flags).join(), '4,4'))
  }
}
