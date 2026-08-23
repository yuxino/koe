// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "KoeHelper",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "koe-helper", targets: ["KoeHelper"]),
        .executable(name: "koe-helper-core-checks", targets: ["KoeHelperCoreChecks"])
    ],
    dependencies: [
        // 1.x currently references Core ML symbols that only exist in the macOS 26 SDK.
        // 0.9.4 exposes the same transcription API we use and still builds for macOS 15.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift", exact: "0.9.4")
    ],
    targets: [
        .target(name: "KoeHelperCore"),
        .executableTarget(
            name: "KoeHelper",
            dependencies: [
                "KoeHelperCore",
                .product(name: "WhisperKit", package: "argmax-oss-swift")
            ]
        ),
        .executableTarget(
            name: "KoeHelperCoreChecks",
            dependencies: ["KoeHelperCore"]
        )
    ]
)
