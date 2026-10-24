const { cpSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');
if (!existsSync(path.join(__dirname, 'avatar-runtime', 'xingyun-renderer.js'))) throw new Error('先执行 pnpm desktop:avatar:build，确保星云 SDK 已离线打包');
module.exports = {
  packagerConfig:{asar:{unpack:['**/*.ps1','**/voice/NAudio.dll']},executableName:'nuanban',name:'NuanbanDemo',prune:false,icon:path.join(__dirname,'assets','brand','icon.ico'),ignore:[/^\/node_modules(?:\/|$)/,/^\/native-lab(?:\/|$)/],electronZipDir:process.env.NUANBAN_ELECTRON_ZIP_DIR||undefined},
  hooks:{generateAssets:async()=>{const source=path.join(__dirname,'../web/dist');if(!existsSync(source))throw new Error('先执行 pnpm build');const destination=path.resolve(__dirname,'ui');if(path.dirname(destination)!==path.resolve(__dirname))throw new Error('UI staging must stay inside the desktop app');rmSync(destination,{recursive:true,force:true});cpSync(source,destination,{recursive:true});}},
  makers:[{name:'@electron-forge/maker-squirrel',config:{name:'nuanban_demo',setupIcon:path.join(__dirname,'assets','brand','icon.ico')}}],
};
