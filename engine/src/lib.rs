// daepdf's engine: daegun behind the byte protocol of `src/daegun/wasm/daegun.ts` (little-endian, a u32
// length before every variable part, in through `arg_buffer`, out through `out_ptr`), fonts called by handle.

use daegun::{BitmapImage, Font};
use std::cell::RefCell;

const OK: u32 = 0;
const FAILED: u32 = 1;
const NONE: u32 = 2;

// A buffer past this is dropped after use rather than kept: a font registration can be 200 MB.
const KEEP_BYTES: usize = 1 << 20;

#[derive(Default)]
struct State {
    arg: Vec<u8>,
    out: Vec<u8>,
    err: Vec<u8>,
    fonts: Vec<Option<Font>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

struct Args<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Args<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.bytes.len()).ok_or("daegun: truncated arguments")?;
        let part = &self.bytes[self.at..end];
        self.at = end;
        Ok(part)
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "daegun: truncated arguments")?))
    }

    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().map_err(|_| "daegun: truncated arguments")?))
    }

    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let n = self.u32()? as usize;
        self.take(n)
    }

    fn string(&mut self) -> Result<&'a str, String> {
        std::str::from_utf8(self.bytes()?).map_err(|_| "daegun: text is not UTF-8".into())
    }

    fn u16s(&mut self) -> Result<Vec<u16>, String> {
        let n = self.u32()? as usize;
        let raw = self.take(n.checked_mul(2).ok_or("daegun: truncated arguments")?)?;
        Ok(raw.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect())
    }
}

struct Out<'a>(&'a mut Vec<u8>);

impl Out<'_> {
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }

    fn f64(&mut self, v: f64) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }

    fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.u32(v.len() as u32);
        self.0.extend_from_slice(v);
        self
    }

    fn string(&mut self, v: &str) -> &mut Self {
        self.bytes(v.as_bytes())
    }

    fn u16s(&mut self, v: &[u16]) -> &mut Self {
        self.u32(v.len() as u32);
        for x in v {
            self.0.extend_from_slice(&x.to_le_bytes());
        }
        self
    }

    fn u32s(&mut self, v: &[u32]) -> &mut Self {
        self.u32(v.len() as u32);
        for x in v {
            self.u32(*x);
        }
        self
    }

    fn f64s(&mut self, v: &[f64]) -> &mut Self {
        self.u32(v.len() as u32);
        for x in v {
            self.f64(*x);
        }
        self
    }
}

// Ok(true) answers, Ok(false) has nothing to say, Err fails with its message.
fn run(call: impl FnOnce(&mut Args, &mut Vec<Option<Font>>, &mut Out) -> Result<bool, String>) -> u32 {
    STATE.with_borrow_mut(|s| {
        let State { arg, out, err, fonts } = s;
        if out.capacity() > KEEP_BYTES {
            *out = Vec::new();
        }
        out.clear();
        let result = call(&mut Args { bytes: arg, at: 0 }, fonts, &mut Out(out));
        if arg.capacity() > KEEP_BYTES {
            *arg = Vec::new();
        }
        match result {
            Ok(true) => OK,
            Ok(false) => NONE,
            Err(e) => {
                *err = e.into_bytes();
                FAILED
            }
        }
    })
}

fn font<'a>(fonts: &'a [Option<Font>], args: &mut Args) -> Result<&'a Font, String> {
    let handle = args.u32()? as usize;
    fonts.get(handle).and_then(Option::as_ref).ok_or_else(|| "daegun: font handle is not open".into())
}

// daepdf's weight and optical size as daegun axes; an optical size of 0 means none was asked for.
fn axes(args: &mut Args) -> Result<Vec<(&'static str, f64)>, String> {
    let weight = f64::from(args.u32()?);
    let opsz = args.f64()?;
    let mut axes = vec![("wght", weight)];
    if opsz > 0.0 {
        axes.push(("opsz", opsz));
    }
    Ok(axes)
}

fn weight_class(font: &Font) -> u32 {
    match font.table("OS/2").and_then(|t| t.get(4..6)) {
        Some(&[hi, lo]) if u16::from_be_bytes([hi, lo]) != 0 => u32::from(u16::from_be_bytes([hi, lo])),
        _ => 400,
    }
}

fn png_height(png: &[u8]) -> Option<i64> {
    let h = png.get(20..24)?;
    Some(i64::from(u32::from_be_bytes([h[0], h[1], h[2], h[3]])))
}

#[unsafe(no_mangle)]
pub extern "C" fn arg_buffer(len: usize) -> *mut u8 {
    STATE.with_borrow_mut(|s| {
        s.arg.clear();
        s.arg.resize(len, 0);
        s.arg.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    STATE.with_borrow(|s| s.out.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> usize {
    STATE.with_borrow(|s| s.out.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn err_ptr() -> *const u8 {
    STATE.with_borrow(|s| s.err.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn err_len() -> usize {
    STATE.with_borrow(|s| s.err.len())
}

// bytes, collection index (u32::MAX for a single font) -> handle, style, weight class, wght range
#[unsafe(no_mangle)]
pub extern "C" fn open() -> u32 {
    run(|args, fonts, out| {
        let bytes = args.bytes()?;
        let index = args.u32()?;
        let font = if index == u32::MAX { Font::from_bytes(bytes) } else { Font::from_ttc(bytes, index as usize) }
            .map_err(|e| e.to_string())?;
        let range = font.axes().into_iter().find(|a| a.tag == "wght").map(|a| (a.min, a.max));
        out.u32(fonts.len() as u32).string(font.style()).u32(weight_class(&font));
        match range {
            Some((min, max)) => out.u32(1).f64(min).f64(max),
            None => out.u32(0).f64(0.0).f64(0.0),
        };
        fonts.push(Some(font));
        Ok(true)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn close() -> u32 {
    run(|args, fonts, _| {
        let handle = args.u32()? as usize;
        if let Some(slot) = fonts.get_mut(handle) {
            *slot = None;
        }
        Ok(true)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn has_glyph() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        out.u32(u32::from(font.has_glyph(args.u32()?)));
        Ok(true)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn glyph_ids() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let ids: Vec<u16> = font.glyph_ids(args.string()?).into_iter().map(|g| g.unwrap_or(0)).collect();
        out.u16s(&ids);
        Ok(true)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn shape() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let text = args.string()?;
        let axes = axes(args)?;
        let vertical = args.u32()? != 0;
        let Some(run) = font.shape(text, &axes, vertical) else { return Ok(false) };
        out.u16s(&run.glyphs).f64s(&run.advances).u32s(&run.clusters);
        Ok(true)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn advance_widths() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let axes = axes(args)?;
        out.f64s(&font.advance_widths(&args.u16s()?, &axes));
        Ok(true)
    })
}

// 0 for a font without vertical metrics, which the renderer reads as "use the default advance";
// daegun's own answer there is a fallback height.
#[unsafe(no_mangle)]
pub extern "C" fn vertical_advance() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let axes = axes(args)?;
        let gid = u16::try_from(args.u32()?).map_err(|_| "daegun: glyph id out of range")?;
        let stated = font.has_table("vmtx") && font.has_table("vhea");
        out.f64(if stated { f64::from(font.vertical_advance(gid, &axes)) } else { 0.0 });
        Ok(true)
    })
}

// Six values a layer: glyph, red, green, blue, alpha, and 1 where it takes the text color.
#[unsafe(no_mangle)]
pub extern "C" fn colr_layers() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let gid = u16::try_from(args.u32()?).map_err(|_| "daegun: glyph id out of range")?;
        let Some(layers) = font.colr_layers(gid) else { return Ok(false) };
        out.u32(layers.len() as u32);
        for (layer, r, g, b, a, foreground) in layers {
            out.u32(u32::from(layer)).u32(u32::from(r)).u32(u32::from(g)).u32(u32::from(b)).u32(u32::from(a)).u32(u32::from(foreground));
        }
        Ok(true)
    })
}

// The PNG and where its bottom-left corner sits, in pixels at its ppem from the glyph origin, y up.
// A coverage strike (EBDT) has no PNG to hand over and answers nothing.
#[unsafe(no_mangle)]
pub extern "C" fn glyph_bitmap() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let gid = u16::try_from(args.u32()?).map_err(|_| "daegun: glyph id out of range")?;
        let ppem = u16::try_from(args.u32()?).unwrap_or(u16::MAX);
        let Some(bitmap) = font.glyph_bitmap(gid, ppem) else { return Ok(false) };
        let BitmapImage::Png(png) = &bitmap.image else { return Ok(false) };
        let Some(height) = png_height(png) else { return Ok(false) };
        out.u32(u32::from(bitmap.ppem)).f64(f64::from(bitmap.left)).f64((i64::from(bitmap.top) - height) as f64).bytes(png);
        Ok(true)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn measure_width() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let text = args.string()?;
        let axes = axes(args)?;
        out.f64(font.measure_width(text, &axes, args.f64()?));
        Ok(true)
    })
}

// The subset at the instance, with the metrics and PostScript name of that instance: read back
// from the subset itself, so a bold instance reports its own cap height and box.
#[unsafe(no_mangle)]
pub extern "C" fn subset() -> u32 {
    run(|args, fonts, out| {
        let font = font(fonts, args)?;
        let axes = axes(args)?;
        let subset = font.subset(&args.u16s()?, &axes).map_err(|e| e.to_string())?;
        let reread = Font::from_bytes(&subset.ttf).ok();
        let metrics = reread.as_ref().unwrap_or(font);
        let name = reread.as_ref().and_then(|f| f.name_string(6))
            .or_else(|| font.name_string(6))
            .or_else(|| font.family_name())
            .unwrap_or_default();
        let bbox = match metrics.bbox()[..] {
            [x0, y0, x1, y1] => [x0, y0, x1, y1].map(f64::from),
            _ => [0.0; 4],
        };
        out.bytes(&subset.ttf).u16s(&subset.gid_map).u32(u32::from(subset.ttf.starts_with(b"OTTO")))
            .f64(f64::from(metrics.ascender())).f64(f64::from(metrics.descender())).f64(f64::from(metrics.cap_height()))
            .f64(bbox[0]).f64(bbox[1]).f64(bbox[2]).f64(bbox[3])
            .u32(metrics.flags()).f64(metrics.italic_angle()).string(&name);
        Ok(true)
    })
}
