import { systemTool } from '../dist/system.js';
try{
 const shot=await systemTool('screen_capture',{format:'jpeg',maxWidth:160,maxHeight:90,quality:0.2});
 console.log('SCREEN_CAPTURE',JSON.stringify({mimeType:shot.mimeType,width:shot.width,height:shot.height,sizeBytes:shot.sizeBytes}));
}catch(e){console.log('SCREEN_UNAVAILABLE',e instanceof Error?e.message:String(e));process.exitCode=2;}
