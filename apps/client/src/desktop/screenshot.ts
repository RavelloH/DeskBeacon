import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile,unlink} from 'node:fs/promises';
import {runNative,namespace} from './adapter.js';

type CaptureInput={app?:string;windowId?:string;format?:'png'|'jpeg';maxWidth?:number;maxHeight?:number;quality?:number};

/** Screenshot files exist only within one call; images are not part of any native Trace. */
export async function captureDesktopWindow(i:CaptureInput,grantId:string,signal?:AbortSignal){
  const file=join(tmpdir(),'deskbeacon-capture-'+randomUUID()+'.png');
  try{
    const args=[file,'--session',namespace(grantId)];
    if(i.windowId)args.push('--window-id',i.windowId);
    else if(i.app)args.push('--app',i.app);
    else throw Error('DESKTOP_INVALID_TARGET: app/window target is required');
    await runNative('screenshot',args,15000,160*1024,signal);
    const png=await readFile(file);
    const {default:sharp}=await import('sharp');
    const format=i.format??'jpeg';
    const targetWidth=i.maxWidth??1920,targetHeight=i.maxHeight??1080;
    const budget=138*1024; // Control frames remain below DeskBeacon's transport limit after Base64.
    let width=targetWidth,height=targetHeight,quality=Math.round((i.quality??0.8)*100);
    let output:Buffer=Buffer.alloc(0);
    for(let iteration=0;iteration<8;iteration++){
      let image=sharp(png).resize({width,height,fit:'inside',withoutEnlargement:true});
      output=format==='png'?await image.png({compressionLevel:9}).toBuffer():
        await image.jpeg({quality:Math.max(30,quality),mozjpeg:true}).toBuffer();
      if(output.length<=budget)break;
      width=Math.max(240,Math.floor(width*0.76));height=Math.max(160,Math.floor(height*0.76));
      quality=Math.max(30,quality-12);
    }
    if(output.length>budget)throw Error('SCREEN_OUTPUT_LIMIT: image cannot fit remote transport');
    const metadata=await sharp(output).metadata();
    return {base64:output.toString('base64'),
      mimeType:format==='png'?'image/png':'image/jpeg',width:metadata.width,height:metadata.height,
      sizeBytes:output.length,timestamp:new Date().toISOString(),target:i.windowId?'window':'app'};
  }finally{
    await unlink(file).catch(()=>{});
  }
}
