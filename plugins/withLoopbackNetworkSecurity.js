const fs = require('node:fs/promises');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">::1</domain>
  </domain-config>
</network-security-config>
`;

module.exports = function withLoopbackNetworkSecurity(config) {
  config = withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application manifest is missing.');
    application.$ = {
      ...application.$,
      'android:networkSecurityConfig': '@xml/network_security_config'
    };
    return modConfig;
  });

  return withDangerousMod(config, ['android', async (modConfig) => {
    const resourceDirectory = path.join(
      modConfig.modRequest.platformProjectRoot,
      'app/src/main/res/xml'
    );
    await fs.mkdir(resourceDirectory, { recursive: true });
    await fs.writeFile(
      path.join(resourceDirectory, 'network_security_config.xml'),
      networkSecurityConfig,
      'utf8'
    );
    return modConfig;
  }]);
};
