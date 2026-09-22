// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpusOgg",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "COpus", targets: ["COpus"]),
        .library(name: "COgg", targets: ["COgg"]),
    ],
    targets: [
        .target(
            name: "COgg",
            path: "ogg",
            exclude: ["COPYING"],
            sources: ["src"],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("include"),
                .headerSearchPath("src"),
            ]
        ),
        .target(
            name: "COpus",
            path: "opus",
            exclude: ["COPYING"],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("."),
                .headerSearchPath("include"),
                .headerSearchPath("celt"),
                .headerSearchPath("silk"),
                .headerSearchPath("silk/float"),
                .headerSearchPath("src"),
                .define("HAVE_CONFIG_H"),
                .define("OPUS_BUILD"),
                .define("USE_ALLOCA"),
                .define("VAR_ARRAYS"),
            ]
        ),
    ]
)
