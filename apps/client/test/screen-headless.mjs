import assert from 'node:assert/strict';
import {systemTool} from '../dist/system.js';
if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY){
 await assert.rejects(()=>systemTool('screen_capture',{format:'jpeg',maxWidth:80,maxHeight:80}),
  /SCREEN_UNAVAILABLE: no graphical desktop session/);
 console.log('PASS headless Linux screenshots explain missing graphical session');
}else console.log('SKIP screenshot headless-only regression: graphical platform/session available');
