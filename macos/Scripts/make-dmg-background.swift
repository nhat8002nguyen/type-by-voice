#!/usr/bin/env swift
//
//  make-dmg-background.swift
//  Type by Voice
//
//  Draws the backdrop for the drag-to-install DMG window: a transparent
//  540x400 canvas carrying a single grey arrow, emitted at 1x and 2x.
//
//  The canvas is transparent on purpose. Finder draws this picture behind the
//  icons over the window's own background, so a transparent arrow reads
//  correctly in both Light and Dark Mode, where a fixed light or dark panel
//  would clash with one of them.
//
//  The arrow sits at the centre of the icon row. The icons' vertical centres
//  land on the same y (see `icon size` and the item positions in
//  dmg-layout.applescript: position + iconSize / 2 = 212), so the arrow lines
//  up with them without any per-icon tuning.
//
//  `panelAlpha` exists as the escape hatch for the one thing a transparent
//  backdrop cannot control: Finder picks the icon-label colour from the
//  background picture, and a mostly-transparent picture can make it choose
//  labels that are unreadable on a light window. Raising it above zero bakes a
//  translucent panel behind everything, which forces the other choice.
//
//  Output is committed, so this only needs re-running when the art changes.
//
//  Usage:
//      swift macos/Scripts/make-dmg-background.swift
//

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Configuration

/// Point size of the 1x canvas; the @2x file is double this in both axes.
private let canvasSize = CGSize(width: 540, height: 400)

/// Centre of the arrow in 1x coordinates, and its overall size.
private let arrowCentre = CGPoint(x: 270, y: 212)
private let arrowSize = CGSize(width: 72, height: 52)

/// Neutral grey, deliberately neither black nor white so it stays visible
/// against a light window and against a dark one. Below full opacity so it
/// reads as a hint rather than as content.
private let arrowFill = CGColor(srgbRed: 0.55, green: 0.55, blue: 0.58, alpha: 0.65)

/// Soft shadow under the arrow, matching the subtle depth of the icons' own art.
private let shadowAlpha: CGFloat = 0.18

/// Zero draws the arrow on a fully transparent canvas. Raise it (about 0.08) to
/// bake a translucent rounded panel behind the arrow as well.
private let panelAlpha: CGFloat = 0

/// Where the generated PNGs live, relative to this script's directory.
private let outputDirectoryRelativePath = "../Installer"

/// Base file name of the generated images. A `@2x` suffix is added per scale.
private let baseName = "dmg-background"

/// Scales to emit, as multipliers of the canvas size.
private let scales = [1, 2]

/// The arrow inside its own `arrowSize` box, y measured downward: a shaft with
/// a head whose apex is on the box's right edge and vertical centre.
private let shaftRect = CGRect(x: 0, y: 14, width: 44, height: 24)
private let headRect = CGRect(x: 44, y: 0, width: 28, height: 52)

// MARK: - Paths

private let scriptDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
private let outputDirectory = scriptDirectory
    .appendingPathComponent(outputDirectoryRelativePath)
    .standardizedFileURL

// MARK: - Drawing

/// Builds the arrow outline in its own coordinate box, without placement.
private func makeArrowPath() -> CGPath {
    let path = CGMutablePath()
    path.addRect(shaftRect)

    // Head: a right-pointing triangle spanning the full box height.
    path.move(to: CGPoint(x: headRect.minX, y: headRect.minY))
    path.addLine(to: CGPoint(x: headRect.maxX, y: headRect.midY))
    path.addLine(to: CGPoint(x: headRect.minX, y: headRect.maxY))
    path.closeSubpath()

    return path
}

/// Renders one scale of the backdrop.
private func makeImage(scale: Int) -> CGImage {
    let pixelWidth = Int(canvasSize.width) * scale
    let pixelHeight = Int(canvasSize.height) * scale

    guard let context = CGContext(
        data: nil,
        width: pixelWidth,
        height: pixelHeight,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fatalError("could not create a \(pixelWidth)x\(pixelHeight) bitmap context")
    }

    // A fresh bitmap context starts fully transparent, so nothing is cleared.
    // Scaling here keeps every coordinate below in 1x points.
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))

    if panelAlpha > 0 {
        let panel = CGRect(origin: .zero, size: canvasSize)
        context.setFillColor(CGColor(srgbRed: 0.5, green: 0.5, blue: 0.52, alpha: panelAlpha))
        context.addPath(CGPath(roundedRect: panel, cornerWidth: 10, cornerHeight: 10, transform: nil))
        context.fillPath()
    }

    context.setShadow(
        offset: CGSize(width: 0, height: -1),
        blur: 4,
        color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: shadowAlpha)
    )
    context.setFillColor(arrowFill)

    // The path is 72x52 like arrowSize, so its centre sits at half its size.
    let dx = arrowCentre.x - arrowSize.width / 2
    let dy = arrowCentre.y - arrowSize.height / 2
    var placement = CGAffineTransform(translationX: dx, y: dy)
    context.addPath(makeArrowPath().copy(using: &placement)!)
    context.fillPath()

    guard let image = context.makeImage() else {
        fatalError("could not render the \(pixelWidth)x\(pixelHeight) image")
    }
    return image
}

/// Writes one image as a PNG, failing loudly rather than leaving a stale file.
private func write(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        fatalError("could not open \(url.path) for writing")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("could not write \(url.path)")
    }
}

// MARK: - Main

try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

for scale in scales {
    let suffix = scale == 1 ? "" : "@\(scale)x"
    let url = outputDirectory.appendingPathComponent("\(baseName)\(suffix).png")
    write(makeImage(scale: scale), to: url)

    let width = Int(canvasSize.width) * scale
    let height = Int(canvasSize.height) * scale
    print("wrote \(url.path) (\(width)x\(height))")
}
