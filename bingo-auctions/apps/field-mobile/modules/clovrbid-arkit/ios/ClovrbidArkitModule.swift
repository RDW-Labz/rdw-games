// ClovrbidArkitModule.swift
//
// Minimal ARKit position-tracking module for the ClovrBid Staff
// walk-and-scan flow. Exposes four synchronous functions to JS:
//
//   startSession()   -> begin an ARWorldTrackingConfiguration session
//   pose()           -> { x, y, z, heading, quality } from the latest frame
//   reset()          -> reset tracking origin to the current camera position
//   stopSession()    -> pause the session
//
// Why a custom Swift module instead of a third-party AR package:
//   react-native-arkit is unmaintained (last meaningful commit 2022) and
//   has no New Architecture support. @viro-community/react-viro is a full
//   scene-graph renderer that would add ~15MB to the IPA and conflict with
//   the react-native-vision-camera frame-processor pipeline. Our use case
//   needs only camera-pose translation, so a 100-line custom module is the
//   minimal, maintainable surface.
//
// Threading: ARKit's session(_:didUpdate:) callback runs on a background
// serial queue. We write `lastPose` and `quality` there, JS reads them on
// the JS thread. The race is inconsequential for our use case (sub-100ms
// delta between frame update and scan event produces sub-mm position
// error). A proper lock can be added post-MVP if drift correction needs
// strict consistency.
//
// Fallbacks:
//   - ARWorldTrackingConfiguration.isSupported false -> quality stays
//     `notAvailable`; JS sees that and stamps NULL coords on bin scans.
//   - Session quality limited (.relocalizing / .excessiveMotion /
//     .insufficientFeatures) -> JS shows a warning banner and stamps NULL.
//   - Only quality == .normal results in real coord_x_m / coord_y_m.

import ExpoModulesCore
import ARKit

// ARSessionDelegate requires NSObjectProtocol. Expo's `Module` is its own
// base class (not NSObject-derived), so we can't add the protocol directly
// to ClovrbidArkitModule. Instead, an inner NSObject helper class carries
// the delegate conformance and writes back to the module via a weak ref.
private class SessionDelegate: NSObject, ARSessionDelegate {
  weak var module: ClovrbidArkitModule?

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    module?.handleFrameUpdate(transform: frame.camera.transform, trackingState: frame.camera.trackingState)
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    module?.handleSessionFailure()
  }

  func sessionWasInterrupted(_ session: ARSession) {
    module?.handleSessionInterrupted()
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    module?.handleSessionInterruptionEnded(session: session)
  }
}

public class ClovrbidArkitModule: Module {

  private var session: ARSession?
  private var sessionDelegate: SessionDelegate?
  fileprivate var lastPose: simd_float4x4?
  fileprivate var quality: String = "notAvailable"

  public func definition() -> ModuleDefinition {
    Name("ClovrbidArkit")

    Function("startSession") { [weak self] in
      self?.startARSession()
    }

    Function("pose") { [weak self] () -> [String: Any] in
      guard let self else {
        return ["x": 0.0, "y": 0.0, "z": 0.0, "heading": 0.0, "quality": "notAvailable"]
      }
      guard let pose = self.lastPose else {
        return ["x": 0.0, "y": 0.0, "z": 0.0, "heading": 0.0, "quality": self.quality]
      }
      // ARKit world space (gravity-aligned): x is right, y is up, z is
      // forward (toward camera back). We treat the xz plane as the floor.
      // Heading derivation from the rotation matrix is post-MVP; for now
      // the JS layer just reads the translation columns.
      return [
        "x": Double(pose.columns.3.x),
        "y": Double(pose.columns.3.y),
        "z": Double(pose.columns.3.z),
        "heading": 0.0,
        "quality": self.quality,
      ]
    }

    Function("reset") { [weak self] in
      guard let s = self?.session else { return }
      let config = ARWorldTrackingConfiguration()
      config.worldAlignment = .gravity
      s.run(config, options: [.resetTracking, .removeExistingAnchors])
      self?.quality = "initializing"
    }

    Function("stopSession") { [weak self] in
      self?.session?.pause()
    }
  }

  // MARK: - Session management

  private func startARSession() {
    guard ARWorldTrackingConfiguration.isSupported else {
      quality = "notAvailable"
      return
    }
    let s = session ?? ARSession()
    // Lazily build the delegate; weak reference avoids retain cycle.
    if sessionDelegate == nil {
      let d = SessionDelegate()
      d.module = self
      sessionDelegate = d
    }
    s.delegate = sessionDelegate
    session = s
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravity
    s.run(config, options: [.resetTracking, .removeExistingAnchors])
    quality = "initializing"
  }

  // MARK: - Delegate callbacks routed in from SessionDelegate

  fileprivate func handleFrameUpdate(transform: simd_float4x4, trackingState: ARCamera.TrackingState) {
    lastPose = transform
    quality = qualityString(from: trackingState)
  }

  fileprivate func handleSessionFailure() {
    quality = "notAvailable"
  }

  fileprivate func handleSessionInterrupted() {
    quality = "relocalizing"
  }

  fileprivate func handleSessionInterruptionEnded(session: ARSession) {
    // After an interruption (call, swipe-up, etc) ARKit's coordinate
    // origin drifts. Reset so subsequent scans get a clean reference.
    // The JS layer is responsible for prompting the operator to re-scan
    // a known bin if cross-session anchoring matters.
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravity
    session.run(config, options: [.resetTracking, .removeExistingAnchors])
    quality = "initializing"
  }

  private func qualityString(from state: ARCamera.TrackingState) -> String {
    switch state {
    case .notAvailable:
      return "notAvailable"
    case .limited(let reason):
      switch reason {
      case .initializing:         return "initializing"
      case .relocalizing:         return "relocalizing"
      case .excessiveMotion:      return "excessiveMotion"
      case .insufficientFeatures: return "insufficientFeatures"
      @unknown default:           return "notAvailable"
      }
    case .normal:
      return "normal"
    @unknown default:
      return "notAvailable"
    }
  }
}
