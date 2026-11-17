const {getDefaultConfig}=require('expo/metro-config');
const path=require('node:path');
const config=getDefaultConfig(__dirname);
config.resolver.resolveRequest=(context,name,platform)=>{
 if(platform!=='web'&&name==='libsodium-wrappers')return {type:'sourceFile',filePath:path.join(__dirname,'compat-root/native/sodium.js')};
 if(platform!=='web'&&name==='loro-crdt')return {type:'sourceFile',filePath:path.join(__dirname,'compat-root/native/loro.js')};
 return context.resolveRequest(context,name,platform);
};
module.exports=config;
