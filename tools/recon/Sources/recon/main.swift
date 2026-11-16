// recon: photos -> textured mesh with Apple's PhotogrammetrySession.
//
// Usage:
//   swift run -c release recon <photos-folder> <output> [options]
//
//   <output> ending in .usdz  -> a single USDZ file
//   <output> ending in .obj   -> an OBJ file next to its textures and .mtl
//                                (loads directly into the web app)
//
// Options:
//   --detail preview|reduced|medium|full|raw|custom   (default custom)
//   --polys N        max triangle count for custom detail (default 150000)
//   --texture 2k|4k|8k   texture size for custom detail (default 4k)
//   --no-mask        do not isolate the subject from the background
//   --sequential     photos are in walking order (e.g. frames from a video)
//   --sensitive      high feature sensitivity (helps low-texture skin)
//
// Nothing is uploaded. On macOS 26 the engine may fetch an improved model
// from Apple once; the photos themselves never leave the Mac.
//
// This file was written without access to a Mac and has not been compiled
// here. It follows Apple's "Creating a photogrammetry command-line app"
// sample. If it fails to build, the error message plus Xcode's suggestion
// is usually a one-line fix.

import Foundation
import RealityKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
    fail("usage: recon <photos-folder> <output.usdz|output.obj> [--detail d] [--polys N] [--texture 2k|4k|8k] [--no-mask] [--sequential] [--sensitive]")
}
let inputURL = URL(fileURLWithPath: args.removeFirst(), isDirectory: true)
let outputURL = URL(fileURLWithPath: args.removeFirst())

var detailName = "custom"
var maxPolys = 150_000
var textureName = "4k"
var masking = true
var sequential = false
var sensitive = false
var i = 0
while i < args.count {
    switch args[i] {
    case "--detail": i += 1; detailName = args[i]
    case "--polys": i += 1; maxPolys = Int(args[i]) ?? maxPolys
    case "--texture": i += 1; textureName = args[i]
    case "--no-mask": masking = false
    case "--sequential": sequential = true
    case "--sensitive": sensitive = true
    default: fail("unknown option \(args[i])")
    }
    i += 1
}

guard PhotogrammetrySession.isSupported else {
    fail("This Mac does not support PhotogrammetrySession (needs a GPU with 4 GB and ray tracing; Apple Silicon qualifies).")
}

var configuration = PhotogrammetrySession.Configuration()
configuration.isObjectMaskingEnabled = masking
configuration.sampleOrdering = sequential ? .sequential : .unordered
configuration.featureSensitivity = sensitive ? .high : .normal
// OBJ output is written as a folder; the API wants the folder URL for OBJ.
let wantsOBJ = outputURL.pathExtension.lowercased() == "obj"
let requestURL: URL = wantsOBJ ? outputURL.deletingLastPathComponent() : outputURL
if wantsOBJ {
    try? FileManager.default.createDirectory(at: requestURL, withIntermediateDirectories: true)
}

let detail: PhotogrammetrySession.Request.Detail
switch detailName {
case "preview": detail = .preview
case "reduced": detail = .reduced
case "medium": detail = .medium
case "full": detail = .full
case "raw": detail = .raw
case "custom":
    var custom = PhotogrammetrySession.Request.Detail.CustomDetailSpecification()
    custom.maximumPolygonCount = UInt(maxPolys)
    switch textureName {
    case "2k": custom.maximumTextureDimension = .twoK
    case "8k": custom.maximumTextureDimension = .eightK
    default: custom.maximumTextureDimension = .fourK
    }
    custom.outputTextureMaps = [.diffuseColor, .normal]
    custom.textureFormat = .png
    detail = .custom(custom)
default: fail("unknown detail \(detailName)")
}

let session: PhotogrammetrySession
do {
    session = try PhotogrammetrySession(input: inputURL, configuration: configuration)
} catch {
    fail("Could not start session: \(error)")
}

print("recon: \(inputURL.path) -> \(outputURL.path) detail=\(detailName) masking=\(masking)")
if #available(macOS 14.0, *) {
    let limits = PhotogrammetrySession.limits
    print("recon: this Mac accepts up to \(limits.maximumNumberOfInputImages) images of \(limits.maximumInputImageDimension) px")
}

let waiter = Task {
    do {
        for try await output in session.outputs {
            switch output {
            case .inputComplete:
                print("recon: photos read")
            case .requestProgress(_, let fraction):
                print(String(format: "recon: %.0f%%", fraction * 100))
            case .requestProgressInfo(_, let info):
                if let stage = info.processingStage { print("recon: stage \(stage)") }
            case .requestComplete(_, let result):
                if case .modelFile(let url) = result { print("recon: wrote \(url.path)") }
            case .requestError(_, let error):
                fail("recon: request failed: \(error)")
            case .processingComplete:
                print("recon: done")
                exit(0)
            case .processingCancelled:
                fail("recon: cancelled")
            case .invalidSample(let id, let reason):
                print("recon: skipped photo \(id): \(reason)")
            case .skippedSample(let id):
                print("recon: skipped photo \(id)")
            case .automaticDownsampling:
                print("recon: photos were downsampled to fit memory")
            case .stitchingIncomplete:
                print("recon: warning, some photos could not be aligned (holes likely)")
            @unknown default:
                break
            }
        }
    } catch {
        fail("recon: \(error)")
    }
}

do {
    try session.process(requests: [.modelFile(url: requestURL, detail: detail)])
} catch {
    fail("recon: could not start processing: \(error)")
}
RunLoop.main.run()
_ = waiter
