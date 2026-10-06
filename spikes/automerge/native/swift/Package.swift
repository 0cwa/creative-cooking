// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CreativeCookingAutomergeSwiftSpike",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(name: "AutomergeBridgeProbe", targets: ["AutomergeBridgeProbe"]),
        .executable(name: "AutomergeSwiftInterop", targets: ["AutomergeSwiftInterop"])
    ],
    dependencies: [
        .package(url: "https://github.com/automerge/automerge-swift.git", exact: "0.7.2")
    ],
    targets: [
        .target(
            name: "AutomergeBridgeProbe",
            dependencies: [
                .product(name: "Automerge", package: "automerge-swift")
            ]
        ),
        .executableTarget(
            name: "AutomergeSwiftInterop",
            dependencies: [
                "AutomergeBridgeProbe",
                .product(name: "Automerge", package: "automerge-swift")
            ]
        ),
        .testTarget(
            name: "AutomergeBridgeProbeTests",
            dependencies: ["AutomergeBridgeProbe"]
        )
    ]
)
