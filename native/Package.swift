// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Tandem",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Tandem", targets: ["TandemApp"])],
    targets: [
        .target(name: "TandemCore"),
        .executableTarget(name: "TandemApp", dependencies: ["TandemCore"]),
        .testTarget(name: "TandemCoreTests", dependencies: ["TandemCore"])
    ],
    swiftLanguageModes: [.v5]
)
