// Build-time helper: dump every frame of a video clip as numbered PNGs.
// No ffmpeg on the build Mac and no new Python dependency, so this uses AVFoundation.
// Usage: swift avatars/tools/extract_frames.swift CLIP.mp4 OUT_DIR [FPS]
// FPS (default 24) is the sampling rate; frames land as OUT_DIR/0000.png, 0001.png, ...
// Then: uv run python avatars/tools/clips_to_pack.py FRAMES_ROOT SPRITE_BASE OUT_DIR --name ...
//
// Some Command Line Tools installs ship both usr/include/swift/module.modulemap and
// bridging.modulemap, and `swift` then fails with "redefinition of module 'SwiftBridging'"
// before this script runs. Without touching the system files, hide one of them with a VFS
// overlay (EMPTY is any empty file):
//   echo '{"version":0,"roots":[{"type":"file","name":"/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap","external-contents":"EMPTY"}]}' > overlay.yaml
//   swift -vfsoverlay overlay.yaml avatars/tools/extract_frames.swift CLIP.mp4 OUT_DIR 24
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: extract_frames.swift CLIP OUT_DIR [FPS]\n".data(using: .utf8)!)
    exit(2)
}
let clip = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
let fps = args.count > 3 ? (Double(args[3]) ?? 24) : 24
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: clip)
let generator = AVAssetImageGenerator(asset: asset)
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
generator.appliesPreferredTrackTransform = true

let semaphore = DispatchSemaphore(value: 0)
var seconds = 0.0
Task {
    seconds = (try? await asset.load(.duration).seconds) ?? 0
    semaphore.signal()
}
semaphore.wait()
guard seconds > 0 else {
    FileHandle.standardError.write("no duration: \(clip.path)\n".data(using: .utf8)!)
    exit(1)
}

let count = max(1, Int((seconds * fps).rounded(.down)))
var written = 0
for i in 0..<count {
    let time = CMTime(seconds: Double(i) / fps, preferredTimescale: 600)
    guard let image = try? generator.copyCGImage(at: time, actualTime: nil) else { continue }
    let url = outDir.appendingPathComponent(String(format: "%04d.png", written))
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        continue
    }
    CGImageDestinationAddImage(dest, image, nil)
    if CGImageDestinationFinalize(dest) { written += 1 }
}
print("{\"clip\": \"\(clip.lastPathComponent)\", \"seconds\": \(seconds), \"frames\": \(written)}")
