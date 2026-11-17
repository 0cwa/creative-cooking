const {getDefaultConfig} = require('expo/metro-config');
const path = require('node:path');
const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = (context, name, platform) => {
 if (name === 'libsodium-wrappers') return {type:'sourceFile',filePath:path.join(__dirname,'native-sodium.js')};
 return context.resolveRequest(context,name,platform);
};
module.exports=config;
