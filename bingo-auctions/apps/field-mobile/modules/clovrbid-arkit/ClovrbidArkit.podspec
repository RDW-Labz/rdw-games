require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ClovrbidArkit'
  s.version        = '0.1.0'
  s.summary        = 'Minimal ARKit position tracking for ClovrBid Staff walk-and-scan'
  s.description    = 'Exposes ARWorldTrackingConfiguration camera-pose translation to JS so the walk-and-scan flow can stamp absolute (x_m, y_m) on bins as the operator physically walks the warehouse.'
  s.author         = 'ClovrBid'
  s.homepage       = 'https://clovrbid.com'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => 'https://github.com/clovrbid/clovrbid-arkit' }
  s.swift_version  = '5.9'

  s.frameworks = 'ARKit'

  s.dependency 'ExpoModulesCore'

  # Swift compiler flags
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "ios/**/*.{h,m,mm,swift,hpp,cpp}"
end
