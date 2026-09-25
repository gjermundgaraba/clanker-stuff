// macOS: swift check-font.swift SOURCE.ttf manifest.json [proof.png]
// Uses CoreText directly; does not install fonts or claim Ghostty validation.
import CoreGraphics
import CoreText
import Foundation
import ImageIO

struct Manifest: Decodable {
    let file: String
    let family: String
    let unitsPerEm: Int
    let advance: Int
    let ascent: Int
    let descent: Int
    let steps: Int
    let transitions: [String: [UInt32]]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("check-font: \(message)\n".utf8))
    exit(1)
}

func load(_ path: URL, _ size: CGFloat) -> CTFont {
    guard let provider = CGDataProvider(url: path as CFURL), let font = CGFont(provider) else {
        fail("cannot load \(path.path)")
    }
    return CTFontCreateWithGraphicsFont(font, size, nil, nil)
}

func glyph(_ font: CTFont, _ cp: UInt32) -> CGGlyph {
    guard let scalar = UnicodeScalar(cp) else { fail("invalid codepoint \(cp)") }
    let units = Array(String(scalar).utf16)
    var glyphs = [CGGlyph](repeating: 0, count: units.count)
    CTFontGetGlyphsForCharacters(font, units, &glyphs, units.count)
    guard glyphs[0] != 0 else { fail("missing U+\(String(cp, radix: 16))") }
    return glyphs[0]
}

func canvas(_ width: Int, _ height: Int) -> CGContext {
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                             bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                                | CGBitmapInfo.byteOrder32Big.rawValue) else { fail("no bitmap context") }
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.setAllowsFontSubpixelPositioning(true)
    ctx.setShouldSubpixelPositionFonts(true)
    ctx.setAllowsFontSubpixelQuantization(false)
    ctx.setShouldSubpixelQuantizeFonts(false)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    return ctx
}

func paint(_ ctx: CGContext, _ font: CTFont, _ cp: UInt32, _ origin: CGPoint) {
    // CTLineDraw labels leave a text position behind; glyph positions below are
    // absolute in the bitmap, not relative to the last label's text matrix.
    ctx.textMatrix = .identity
    ctx.textPosition = .zero
    var g = glyph(font, cp)
    var position = origin
    CTFontDrawGlyphs(font, &g, &position, 1, ctx)
}

let args = Array(CommandLine.arguments.dropFirst())
guard (2...3).contains(args.count) else { fail("expected SOURCE.ttf manifest.json [proof.png]") }
let source = URL(fileURLWithPath: args[0])
let manifestURL = URL(fileURLWithPath: args[1])
do {
    let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
    let companion = manifestURL.deletingLastPathComponent().appendingPathComponent(manifest.file)
    let width = 128, height = 128
    let ctx = canvas(width, height)
    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    let origin = CGPoint(x: 24, y: 48)
    let all = Set(manifest.transitions.values.flatMap { $0 })
    let endpoints = manifest.transitions.flatMap { pair, frames in
        let digits = Array(pair.unicodeScalars)
        return [(digits[0], frames[0]), (digits[1], frames[manifest.steps])]
    }
    var outlineChecks = 0
    var checked = 0
    var pixelMatches = 0
    var differingSizes = Set<Int>()
    for size in [12, 14, 15, 16, 18, 20, 24, 28, 30, 32, 36, 40] {
        let font = load(companion, CGFloat(size))
        let native = load(source, CGFloat(size))
        guard CTFontCopyFamilyName(font) as String == manifest.family else { fail("family mismatch") }
        guard abs(CTFontGetAscent(font) - CTFontGetAscent(native)) < 0.001,
              abs(CTFontGetDescent(font) - CTFontGetDescent(native)) < 0.001,
              abs(CTFontGetLeading(font) - CTFontGetLeading(native)) < 0.001 else {
            fail("source and companion vertical metrics differ at \(size)px")
        }
        for (digit, cp) in endpoints {
            let nativeGlyph = glyph(native, digit.value)
            let companionGlyph = glyph(font, cp)
            guard CTFontCreatePathForGlyph(native, nativeGlyph, nil)
                    == CTFontCreatePathForGlyph(font, companionGlyph, nil) else {
                fail("source/companion outline differs for digit \(digit) at \(size)px")
            }
            outlineChecks += 1
            ctx.clear(rect)
            paint(ctx, native, digit.value, origin)
            let nativePixels = Data(bytes: ctx.data!, count: height * ctx.bytesPerRow)
            ctx.clear(rect)
            paint(ctx, font, cp, origin)
            let companionPixels = Data(bytes: ctx.data!, count: height * ctx.bytesPerRow)
            if nativePixels == companionPixels { pixelMatches += 1 }
            else { differingSizes.insert(size) }
        }
        let scale = CGFloat(size) / CGFloat(manifest.unitsPerEm)
        let cell = CGRect(x: origin.x, y: origin.y + CGFloat(manifest.descent) * scale,
                          width: CGFloat(manifest.advance) * scale,
                          height: CGFloat(manifest.ascent - manifest.descent) * scale)
        // One pixel accommodates antialiasing along the cell clip boundary.
        let allowed = cell.insetBy(dx: -1, dy: -1)
        for cp in all {
            var g = glyph(font, cp)
            var advance = CGSize.zero
            CTFontGetAdvancesForGlyphs(font, .horizontal, &g, &advance, 1)
            guard abs(advance.width - cell.width) < 0.001 else { fail("advance mismatch") }
            ctx.clear(rect)
            paint(ctx, font, cp, origin)
            let pixels = ctx.data!.assumingMemoryBound(to: UInt8.self)
            var ink = 0
            for row in 0..<height {
                for x in 0..<width where pixels[row * ctx.bytesPerRow + x * 4 + 3] >= 16 {
                    ink += 1
                    guard allowed.contains(CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(height - 1 - row) + 0.5)) else {
                        fail("U+\(String(cp, radix: 16)) paints outside its cell at \(size)px")
                    }
                }
            }
            guard ink > 0 else { fail("empty frame at \(size)px") }
            checked += 1
        }
    }
    print("PASS: \(outlineChecks) native/companion outline comparisons; \(checked) glyph/size clipping and advance checks.")
    print("Raster diagnostic: \(pixelMatches)/\(outlineChecks) resting digit pairs are pixel-identical.")
    if !differingSizes.isEmpty {
        print("CoreText rasterization differs despite matching outlines at these pixel sizes: \(differingSizes.sorted()). Verify native terminal playback; this is not visual approval.")
    }

    if args.count == 3 {
        let sheet = canvas(760, 610)
        sheet.setFillColor(CGColor(gray: 1, alpha: 1))
        sheet.fill(CGRect(x: 0, y: 0, width: 760, height: 610))
        sheet.setFillColor(CGColor(gray: 0, alpha: 1))
        let native = load(source, 30), font = load(companion, 30)
        func label(_ text: String, _ x: CGFloat, _ y: CGFloat) {
            let value = NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): load(source, 12)
            ])
            sheet.textPosition = CGPoint(x: x, y: y)
            CTLineDraw(CTLineCreateWithAttributedString(value), sheet)
        }
        label("CoreText proof at 30px (15pt @2x); verify final sizing in Ghostty", 15, 585)
        for (i, title) in ["Native", "0%", "25%", "50%", "75%", "100%", "Native"].enumerated() {
            label(title, CGFloat(95 + i * 90), 555)
        }
        for (row, pair) in manifest.transitions.keys.sorted().enumerated() {
            let y = CGFloat(505 - row * 46)
            label(pair, 20, y)
            let digits = Array(pair.unicodeScalars)
            paint(sheet, native, digits[0].value, CGPoint(x: 100, y: y))
            let frames = manifest.transitions[pair]!
            for (col, fraction) in [0.0, 0.25, 0.5, 0.75, 1.0].enumerated() {
                paint(sheet, font, frames[Int((fraction * Double(manifest.steps)).rounded())],
                      CGPoint(x: 190 + col * 90, y: Int(y)))
            }
            paint(sheet, native, digits[1].value, CGPoint(x: 640, y: y))
        }
        let output = URL(fileURLWithPath: args[2])
        guard let image = sheet.makeImage(),
              let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil)
        else { fail("cannot create proof PNG") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { fail("cannot write proof PNG") }
        print(output.path)
    }
} catch { fail(error.localizedDescription) }
