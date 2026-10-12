require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name         = 'CcSubductionModule'
  s.version      = package['version']
  s.summary      = 'Research-only Subduction native bridge'
  s.description  = 'Isolated pinned Rust research adapter; no production use.'
  s.license      = { :type => 'MIT' }
  s.homepage     = 'https://github.com/0cwa/creative-cooking'
  s.author       = { 'Creative Cooking' => 'research@example.invalid' }
  s.source       = { :git => 'https://github.com/0cwa/creative-cooking.git' }
  s.platforms    = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = 'ios/**/*.{swift,h}'
  s.vendored_libraries = 'ios/libcc_subduction_native.a'
  s.dependency 'ExpoModulesCore'
end
