// Expo config plugin; the application config must explicitly include this plugin.
const {withMainApplication,withDangerousMod} = require('@expo/config-plugins');
const fs=require('node:fs/promises');const path=require('node:path');
module.exports=function withLoroMaster(config){
 config=withMainApplication(config,config=>{const contents=config.modResults.contents;const importLine='import expo.modules.creativecookingloro.LoroMasterPackage';const anchor='PackageList(this).packages.apply {';if(!contents.includes(anchor))throw Error('Unsupported MainApplication layout');if(!contents.includes(importLine))config.modResults.contents=contents.replace(/(package [^\n]+\n)/,`$1\n${importLine}\n`).replace(anchor,`${anchor}\n          add(LoroMasterPackage())`);return config});
 return withDangerousMod(config,['android',async config=>{const dest=path.join(config.modRequest.platformProjectRoot,'app/src/main/java/expo/modules/creativecookingloro');await fs.mkdir(dest,{recursive:true});await fs.copyFile(path.join(__dirname,'android/LoroMasterPackage.kt'),path.join(dest,'LoroMasterPackage.kt'));return config}]);
};
