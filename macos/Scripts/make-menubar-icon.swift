#!/usr/bin/env swift
//
//  make-menubar-icon.swift
//  Type by Voice
//
//  Regenerates the menu bar status-item asset (MenuBarIcon.imageset) from the
//  app icon. The app icon is an opaque rounded-square tile, so it cannot be
//  dropped into the menu bar directly: the mark has to be keyed out of the
//  tile, cleaned up, and resampled to status-item size.
//
//  The mark is the only saturated element in the tile — the tile behind it is
//  neutral grey — so a saturation threshold separates the two without needing
//  a separate transparent source.
//
//  Output is a *template* image: black ink plus coverage in the alpha channel,
//  declared as `template-rendering-intent` in the imageset's Contents.json so
//  macOS inverts it for a dark menu bar.
//
//  Usage:
//      swift macos/Scripts/make-menubar-icon.swift
//
//  Run it after changing the app icon art. Its output is committed, so this
//  only needs re-running when the mark itself changes.
//

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Configuration

/// The app icon to derive the mark from, relative to this script's directory.
private let sourceRelativePath =
    "../TypeByVoice/Assets.xcassets/AppIcon.appiconset/icon_512x512.png"

/// Where the generated imageset lives, relative to this script's directory.
private let outputDirectoryRelativePath = "../TypeByVoice/Assets.xcassets/MenuBarIcon.imageset"

/// Base file name of the generated images. A `@2x` suffix is added per scale.
private let assetName = "MenuBarIcon"

/// Point size of the status item image, and the scales to emit.
private let pointSize = 18
private let scales = [1, 2]

/// Fraction of the canvas left as padding around the mark, per side.
private let paddingFraction = 0.06

/// Saturation window that keys the mark out of the tile. Below `lo` is
/// background, above `hi` is mark; in between is a soft edge.
///
/// The window sits high on purpose. The tile is not a flat colour behind the
/// mark — it carries a wide cyan glow reaching saturation 0.20-0.35 across
/// most of the canvas. A lower floor admits that glow at partial alpha, which
/// renders as a grey haze box around the mark in the menu bar. The mark's own
/// body is above 0.75, so 0.45-0.65 separates them with the glow at zero.
private let saturationFloor: Float = 0.45
private let saturationCeiling: Float = 0.65

/// A bright, unmistakably-mark pixel stays solid even if it lands mid-window.
/// The saturation bar is high so the dim glow cannot qualify.
private let brightCutoff: Float = 120
private let brightSaturation: Float = 0.70

/// Radii, in source pixels, of the morphological close applied to the mask.
/// This is what fuses the mark's hairline wave strokes into shapes that
/// survive an 18 pt render instead of dissolving into grey.
private let closeRadius = 3

/// Extra dilation, in source pixels, applied before the erode half of the
/// close. A symmetric close fills gaps without adding weight, and the mark
/// needs weight: its strokes run 10-20 px in a 425 px-wide mark, so at 18 pt
/// they would land around 0.7 pt and render as faint grey. This widens every
/// stroke by roughly this many source pixels without closing the gaps between
/// the wave ribbons.
private let strokeWeight = 4

/// Ink colour. Irrelevant once the asset renders as a template — the alpha
/// channel is all macOS uses — but black is the conventional value.
private let ink: (r: UInt8, g: UInt8, b: UInt8) = (0, 0, 0)

// MARK: - Helpers

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
    exit(1)
}

private func smoothstep(_ x: Float, _ lo: Float, _ hi: Float) -> Float {
    if x <= lo { return 0 }
    if x >= hi { return 1 }
    let t = (x - lo) / (hi - lo)
    return t * t * (3 - 2 * t)
}

private func rgbaContext(
    _ pixels: UnsafeMutableRawPointer, width: Int, height: Int
) -> CGContext {
    guard let context = CGContext(
        data: pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("could not create a \(width)x\(height) RGBA bitmap context")
    }
    return context
}

/// Decodes a PNG into non-premultiplied-by-us RGBA bytes, top row first.
private func decodePNG(at url: URL) -> (pixels: [UInt8], width: Int, height: Int) {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("could not read an image at \(url.path)")
    }
    let width = image.width
    let height = image.height
    let count = width * height * 4
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
    defer { buffer.deallocate() }
    rgbaContext(buffer, width: width, height: height)
        .draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (Array(UnsafeBufferPointer(start: buffer, count: count)), width, height)
}

private func writePNG(_ pixels: [UInt8], width: Int, height: Int, to url: URL) {
    var mutable = pixels
    let image: CGImage? = mutable.withUnsafeMutableBytes { raw in
        rgbaContext(raw.baseAddress!, width: width, height: height).makeImage()
    }
    guard let image else { fail("could not build a \(width)x\(height) image") }
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil
    ) else {
        fail("could not open \(url.path) for writing")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("could not write \(url.path)")
    }
}

// MARK: - Mask construction

/// Coverage of the mark, 0...1, for every pixel of the source icon.
private func markCoverage(pixels: [UInt8], width: Int, height: Int) -> [Float] {
    var coverage = [Float](repeating: 0, count: width * height)
    for index in 0..<(width * height) {
        let r = Float(pixels[index * 4])
        let g = Float(pixels[index * 4 + 1])
        let b = Float(pixels[index * 4 + 2])
        let maximum = max(r, max(g, b))
        let minimum = min(r, min(g, b))
        let saturation = maximum == 0 ? 0 : (maximum - minimum) / maximum
        var value = smoothstep(saturation, saturationFloor, saturationCeiling)
        if maximum > brightCutoff && saturation > brightSaturation { value = 1 }
        coverage[index] = value
    }
    return coverage
}

private func median3(_ source: [Float], width: Int, height: Int) -> [Float] {
    var result = [Float](repeating: 0, count: source.count)
    var window = [Float](repeating: 0, count: 9)
    for y in 0..<height {
        for x in 0..<width {
            var n = 0
            for dy in -1...1 {
                let sy = min(max(y + dy, 0), height - 1)
                for dx in -1...1 {
                    let sx = min(max(x + dx, 0), width - 1)
                    window[n] = source[sy * width + sx]
                    n += 1
                }
            }
            window.sort()
            result[y * width + x] = window[4]
        }
    }
    return result
}

private func morph(_ source: [Float], width: Int, height: Int, radius: Int, dilate: Bool) -> [Float] {
    var result = [Float](repeating: dilate ? 0 : 1, count: source.count)
    for y in 0..<height {
        for x in 0..<width {
            var best: Float = dilate ? 0 : 1
            for dy in -radius...radius {
                let sy = min(max(y + dy, 0), height - 1)
                for dx in -radius...radius {
                    let sx = min(max(x + dx, 0), width - 1)
                    let value = source[sy * width + sx]
                    best = dilate ? max(best, value) : min(best, value)
                }
            }
            result[y * width + x] = best
        }
    }
    return result
}

// MARK: - Rendering

/// Draws the mark into a square canvas of `size` pixels, cropping to the
/// mark's bounding box first so the artwork fills the status item.
private func render(
    coverage: [Float],
    pixels: [UInt8],
    width: Int,
    height: Int,
    bounds: (x0: Int, y0: Int, x1: Int, y1: Int),
    size: Int
) -> [UInt8] {
    let markWidth = bounds.x1 - bounds.x0 + 1
    let markHeight = bounds.y1 - bounds.y0 + 1
    let padding = max(1, Int((Double(size) * paddingFraction).rounded()))
    let art = size - 2 * padding
    let scale = Double(art) / Double(max(markWidth, markHeight))
    let drawWidth = Double(markWidth) * scale
    let drawHeight = Double(markHeight) * scale
    let originX = (Double(size) - drawWidth) / 2
    let originY = (Double(size) - drawHeight) / 2

    var output = [UInt8](repeating: 0, count: size * size * 4)
    for y in 0..<size {
        for x in 0..<size {
            let u0 = (Double(x) - originX) / drawWidth
            let u1 = (Double(x) + 1 - originX) / drawWidth
            let v0 = (Double(y) - originY) / drawHeight
            let v1 = (Double(y) + 1 - originY) / drawHeight

            let sx0 = max(bounds.x0, bounds.x0 + Int(u0 * Double(markWidth)))
            let sx1 = min(bounds.x1 + 1, bounds.x0 + Int(u1 * Double(markWidth)) + 1)
            let sy0 = max(bounds.y0, bounds.y0 + Int(v0 * Double(markHeight)))
            let sy1 = min(bounds.y1 + 1, bounds.y0 + Int(v1 * Double(markHeight)) + 1)
            guard sx1 > sx0, sy1 > sy0 else { continue }

            var total: Float = 0
            for sy in sy0..<sy1 {
                for sx in sx0..<sx1 {
                    total += coverage[sy * width + sx]
                }
            }
            guard total > 0 else { continue }

            let samples = Float((sx1 - sx0) * (sy1 - sy0))
            let offset = (y * size + x) * 4
            output[offset] = ink.r
            output[offset + 1] = ink.g
            output[offset + 2] = ink.b
            output[offset + 3] = UInt8((min(1, total / samples) * 255).rounded())
        }
    }
    return output
}

// MARK: - Main

let scriptDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let sourceURL = URL(fileURLWithPath: sourceRelativePath, relativeTo: scriptDirectory)
let outputDirectory = URL(fileURLWithPath: outputDirectoryRelativePath, relativeTo: scriptDirectory)

let source = decodePNG(at: sourceURL)
print("read \(sourceURL.lastPathComponent) (\(source.width)x\(source.height))")

var coverage = markCoverage(pixels: source.pixels, width: source.width, height: source.height)
coverage = median3(coverage, width: source.width, height: source.height)
coverage = morph(coverage, width: source.width, height: source.height, radius: closeRadius + strokeWeight, dilate: true)
coverage = morph(coverage, width: source.width, height: source.height, radius: closeRadius, dilate: false)

var x0 = source.width, y0 = source.height, x1 = -1, y1 = -1
for y in 0..<source.height {
    for x in 0..<source.width where coverage[y * source.width + x] > 0.5 {
        x0 = min(x0, x); x1 = max(x1, x)
        y0 = min(y0, y); y1 = max(y1, y)
    }
}
guard x1 >= x0, y1 >= y0 else { fail("no mark found in \(sourceURL.lastPathComponent) — is the app icon art unchanged?") }
print("mark bounds (\(x0), \(y0))-\(x1), \(y1) — \(x1 - x0 + 1)x\(y1 - y0 + 1) px")

try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

var images: [String] = []
for scale in scales {
    let size = pointSize * scale
    let pixels = render(
        coverage: coverage,
        pixels: source.pixels,
        width: source.width,
        height: source.height,
        bounds: (x0, y0, x1, y1),
        size: size
    )
    let name = scale == 1 ? "\(assetName).png" : "\(assetName)@\(scale)x.png"
    writePNG(pixels, width: size, height: size, to: outputDirectory.appendingPathComponent(name))
    print("wrote \(name) (\(size)x\(size))")
    images.append("""
        {
          "filename" : "\(name)",
          "idiom" : "mac",
          "scale" : "\(scale)x"
        }
    """)
}

let contents = """
{
  "images" : [
\(images.joined(separator: ",\n"))
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "template-rendering-intent" : "template"
  }
}

"""
try contents.write(
    to: outputDirectory.appendingPathComponent("Contents.json"),
    atomically: true,
    encoding: .utf8
)
print("wrote Contents.json (template rendering)")
