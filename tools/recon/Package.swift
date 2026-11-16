// swift-tools-version:5.9
// Command-line wrapper around Apple's photogrammetry engine (RealityKit
// PhotogrammetrySession). Runs fully offline on Apple Silicon Macs.
import PackageDescription

let package = Package(
    name: "recon",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "recon", path: "Sources/recon"),
    ]
)
