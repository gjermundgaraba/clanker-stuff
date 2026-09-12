#!/usr/bin/env swift  // Run on macOS: swift scripts/check-coretext.swift [font.ttf [shapes.json]]
// Checks real painted pixels, not just the bounding boxes reported by CoreText.
import CoreGraphics
import CoreText
import Foundation

struct Manifest: Decodable {
  struct Animation: Decodable {
    let frames: [UInt32]
    let still: UInt32
  }
  let animations: [String: [String: [String: Animation]]]
  let rubik: Animation
  var frames: [UInt32] {
    animations.values.flatMap { $0.values.flatMap { $0.values.flatMap { $0.frames + [$0.still] } } } + rubik.frames + [rubik.still]
  }
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("check-coretext: \(message)\n".utf8))
  exit(1)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count <= 2 else {
  fail("usage: swift check-coretext.swift [font.ttf [shapes.json]]")
}
let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .deletingLastPathComponent().appendingPathComponent("assets")
let fontURL =
  arguments.isEmpty
  ? assets.appendingPathComponent("ShapeSpinner.ttf")
  : URL(fileURLWithPath: arguments[0])
let metadataURL =
  arguments.count == 2
  ? URL(fileURLWithPath: arguments[1])
  : fontURL.deletingLastPathComponent().appendingPathComponent("shapes.json")

do {
  let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: metadataURL))
  guard !manifest.frames.isEmpty else {
    fail("expected nonempty frames in \(metadataURL.path)")
  }
  let codepoints = Set(manifest.frames).sorted()
  guard let provider = CGDataProvider(url: fontURL as CFURL), let graphicsFont = CGFont(provider)
  else {
    fail("cannot load \(fontURL.path)")
  }
  let baseFont = CTFontCreateWithGraphicsFont(graphicsFont, 12, nil, nil)
  guard CTFontGetSymbolicTraits(baseFont).contains(.traitColorGlyphs),
    CTFontCopyTable(baseFont, CTFontTableTag(0x7362_6978), []) != nil
  else {
    fail("expected a CoreText color font with an sbix table: \(fontURL.path)")
  }

  let width = 128
  let height = 128
  let origin = CGPoint(x: 32, y: 48)
  guard
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        | CGBitmapInfo.byteOrder32Big.rawValue
    ), let data = context.data
  else {
    fail("cannot allocate the oversized RGBA drawing context")
  }
  let bytes = data.assumingMemoryBound(to: UInt8.self)
  let canvas = CGRect(x: 0, y: 0, width: width, height: height)
  context.setAllowsAntialiasing(true)
  context.setShouldAntialias(true)
  context.setAllowsFontSubpixelPositioning(true)
  context.setShouldSubpixelPositionFonts(true)
  context.setAllowsFontSubpixelQuantization(false)
  context.setShouldSubpixelQuantizeFonts(false)
  context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))

  // CoreGraphics bitmap row zero is the top, while drawing coordinates start at the bottom.
  context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
  guard bytes[((height - 1) * width) * 4 + 3] == 255, bytes[3] == 0 else {
    fail("unexpected bitmap row orientation; update the pixel-coordinate conversion")
  }

  let sizes = Array(12...20) + (12...20).map { $0 * 2 }
  var failures = 0
  for size in sizes {
    let font = CTFontCreateWithGraphicsFont(graphicsFont, CGFloat(size), nil, nil)
    for codepoint in codepoints {
      guard let scalar = UnicodeScalar(codepoint) else {
        fail("invalid Unicode scalar \(codepoint) in \(metadataURL.path)")
      }
      let units = Array(String(scalar).utf16)
      var glyphs = [CGGlyph](repeating: 0, count: units.count)
      CTFontGetGlyphsForCharacters(font, units, &glyphs, units.count)
      var glyph = glyphs[0]
      guard glyph != 0 else {
        fail("missing glyph U+\(String(codepoint, radix: 16, uppercase: true))")
      }
      let declared = CTFontGetBoundingRectsForGlyphs(font, .horizontal, &glyph, nil, 1)
      let allowed = declared.offsetBy(dx: origin.x, dy: origin.y).integral
      guard !allowed.isEmpty, canvas.contains(allowed) else {
        fail("declared bounds exceed the oversized canvas at \(size)px: \(declared)")
      }
      context.clear(canvas)
      var position = origin
      CTFontDrawGlyphs(font, &glyph, &position, 1, context)

      var minX = width
      var minY = height
      var maxX = -1
      var maxY = -1
      for row in 0..<height {
        for x in 0..<width where bytes[(row * width + x) * 4 + 3] >= 16 {
          let y = height - 1 - row
          minX = min(minX, x)
          minY = min(minY, y)
          maxX = max(maxX, x)
          maxY = max(maxY, y)
        }
      }
      let painted = CGRect(
        x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1
      )
      if maxX < 0 || !allowed.contains(painted) {
        failures += 1
        if failures <= 12 {
          let cp = String(codepoint, radix: 16, uppercase: true)
          let ink = painted.offsetBy(dx: -origin.x, dy: -origin.y)
          print("FAIL U+\(cp) \(size)px: declared=\(declared), painted(alpha>=16)=\(ink)")
        }
      }
    }
  }
  let total = codepoints.count * sizes.count
  if failures > 0 {
    fail(
      "\(failures)/\(total) glyph/size checks failed (first 12 shown). Check sbix offsets relative to glyf bounds; font: \(fontURL.path)"
    )
  }
  print(
    "PASS: \(codepoints.count) glyphs × \(sizes.count) sizes = \(total) actual CoreText paint checks; alpha>=16 stays inside floor/ceil declared bounds."
  )
  print(fontURL.path)
} catch {
  fail(error.localizedDescription)
}
