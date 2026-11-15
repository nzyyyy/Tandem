// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Tandem",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "Tandem", targets: ["TandemApp"])],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.5.0")
    ],
    targets: [
        .target(name: "TandemCore"),
        .executableTarget(name: "TandemApp", dependencies: ["TandemCore", .product(name: "Textual", package: "textual")]),
        .testTarget(name: "TandemCoreTests", dependencies: ["TandemCore"]),
        .testTarget(name: "TandemAppTests", dependencies: ["TandemApp"])
    ],
    swiftLanguageModes: [.v5]
)
