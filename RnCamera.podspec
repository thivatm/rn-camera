require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnCamera"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/thivatm/rn-camera.git", :tag => "v#{s.version}" }

  s.swift_version = "5.9"
  s.source_files = "ios/**/*.{h,m,mm,swift,cpp}"
  s.exclude_files = "ios/Tests/**/*"
  s.private_header_files = "ios/**/*.h"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)

  s.test_spec "Tests" do |t|
    t.source_files = "ios/Tests/**/*.swift"
  end
end
