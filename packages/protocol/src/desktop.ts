import {z} from 'zod';

const id=z.string().trim().min(1).max(128);
const ref=z.string().regex(/^@s[a-zA-Z0-9]+:e\d+$/);
const app=z.string().trim().min(1).max(256);
const common={deviceId:id,sessionId:id.optional(),timeoutMs:z.number().int().min(100).max(120000).optional()};
const mode=z.enum(['headless','headed']).default('headless');
const target={
 app:app.optional(), windowId:z.string().min(1).max(128).optional(),
};
const screenshotSurface=z.enum(['window','focused','menu','menubar','sheet','popover','alert','desktop',
 'taskbar','system-tray','quick-settings','notification-center','toolbar','dock','spotlight',
 'menu-bar-extras','system-tray-overflow','start-menu','action-center']);

export const desktopToolInputSchemas={
 desktop_status:z.object({...common}).strict(),
 desktop_list:z.object({...common,kind:z.enum(['apps','windows','displays','surfaces']),app:app.optional()}).strict(),
 desktop_snapshot:z.object({...common,...target,rootRef:ref.optional(),surface:screenshotSurface.optional(),
  interactiveOnly:z.boolean().default(true),compact:z.boolean().default(true),
  skeleton:z.boolean().default(false),maxDepth:z.number().int().min(1).max(40).default(10),
  includeBounds:z.boolean().default(false)}).strict().refine(i=>!(i.rootRef&&i.surface),{message:'rootRef and surface are mutually exclusive'}),
 desktop_find:z.object({...common,...target,rootRef:ref.optional(),surface:screenshotSurface.optional(),
  role:z.string().min(1).max(100).optional(),name:z.string().max(512).optional(),
  text:z.string().max(512).optional(),value:z.string().max(512).optional(),
  exact:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(10)}).strict().refine(
   i=>!(i.rootRef&&i.surface),{message:'rootRef and surface are mutually exclusive'}),
 desktop_get:z.object({...common,refId:ref,property:z.enum(['text','value','title','bounds','role','states',
 'visible','enabled','checked','focused','expanded','selected']).default('text')}).strict(),
 desktop_click:z.object({...common,refId:ref,kind:z.enum(['single','double','triple','right']).default('single'),
  interactionMode:mode,idempotencyKey:id.optional()}).strict(),
 desktop_input:z.object({...common,refId:ref,action:z.enum(['set_value','type','clear']),text:z.string().max(65536).optional(),
  intervalMs:z.number().int().min(1).max(2000).optional(),interactionMode:mode,idempotencyKey:id.optional()}).strict()
  .superRefine((i,ctx)=>{
   if(i.action!=='clear'&&i.text===undefined)ctx.addIssue({code:'custom',path:['text'],message:'text is required'});
   if(i.action==='clear'&&i.text!==undefined)ctx.addIssue({code:'custom',path:['text'],message:'text is not used'});
   if(i.action!=='type'&&i.intervalMs!==undefined)ctx.addIssue({code:'custom',path:['intervalMs'],message:'only type accepts intervalMs'});
  }),
 desktop_wait:z.discriminatedUnion('condition',[
  z.object({...common,condition:z.literal('element'),refId:ref,predicate:z.enum(['exists','visible','enabled','actionable','value']).default('exists'),value:z.string().max(1024).optional()}).strict(),
  z.object({...common,condition:z.literal('window'),windowTitle:z.string().min(1).max(256),app:app.optional()}).strict(),
  z.object({...common,condition:z.literal('text'),text:z.string().min(1).max(512),app:app.optional()}).strict(),
  z.object({...common,condition:z.literal('menu_open'),app:app.optional()}).strict(),
  z.object({...common,condition:z.literal('menu_closed'),app:app.optional()}).strict(),
  z.object({...common,condition:z.literal('event'),event:z.enum(['window-opened','window-closed','app-launched','app-terminated','focus-changed','surface-appeared','surface-dismissed']),app:app.optional()}).strict(),
  z.object({...common,condition:z.literal('notification'),app:app.optional()}).strict()
 ]),
 desktop_control:z.object({...common,refId:ref,action:z.enum(['select','check','uncheck','toggle','expand','collapse','focus','scroll','scroll_to']),
  value:z.string().max(2048).optional(),direction:z.enum(['up','down','left','right']).optional(),
  amount:z.number().int().min(1).max(100).optional(),interactionMode:mode,idempotencyKey:id.optional()}).strict()
  .superRefine((i,ctx)=>{if(i.action==='select'&&i.value===undefined)ctx.addIssue({code:'custom',path:['value'],message:'select requires value'});
   if(i.action!=='select'&&i.value!==undefined)ctx.addIssue({code:'custom',path:['value'],message:'only select supports value'});
   if(i.action!=='scroll'&&(i.amount!==undefined||i.direction!==undefined))ctx.addIssue({code:'custom',path:['amount'],message:'only scroll supports direction/amount'});}),
 desktop_press:z.object({...common,...target,key:z.string().min(1).max(80),interactionMode:z.literal('headed'),idempotencyKey:id.optional()}).strict(),
 desktop_pointer:z.object({...common,action:z.enum(['hover','move','click','drag','wheel']),
  refId:ref.optional(),fromRef:ref.optional(),toRef:ref.optional(),x:z.number().int().min(-32768).max(32768).optional(),
  y:z.number().int().min(-32768).max(32768).optional(),toX:z.number().int().min(-32768).max(32768).optional(),
  toY:z.number().int().min(-32768).max(32768).optional(),button:z.enum(['left','right','middle']).optional(),
  count:z.number().int().min(1).max(3).optional(),deltaX:z.number().int().min(-100).max(100).optional(),
  deltaY:z.number().int().min(-100).max(100).optional(),durationMs:z.number().int().min(0).max(5000).optional(),
  interactionMode:z.literal('headed'),idempotencyKey:id.optional()}).strict().superRefine((i,ctx)=>{
   const required=(key:'x'|'y'|'toX'|'toY')=>{if(i[key]===undefined)ctx.addIssue({code:'custom',path:[key],message:key+' is required'});};
   if(['move','click','wheel'].includes(i.action)){required('x');required('y');}
   if(i.action==='drag'){
    if(!i.fromRef){required('x');required('y');}
    if(!i.toRef){required('toX');required('toY');}
   }
   if(i.action==='hover'&&!i.refId){required('x');required('y');}
  }),
 desktop_app:z.object({...common,action:z.enum(['launch','close']),app,interactionMode:mode,
  activate:z.boolean().default(false),force:z.boolean().default(false),idempotencyKey:id.optional()}).strict()
  .superRefine((i,ctx)=>{if(i.activate&&i.interactionMode!=='headed')
    ctx.addIssue({code:'custom',path:['interactionMode'],message:'activate requires headed mode'});}),
 desktop_window:z.object({...common,...target,action:z.enum(['focus','move','resize','minimize','maximize','restore']),interactionMode:mode,
  x:z.number().int().min(-32768).max(32768).optional(),y:z.number().int().min(-32768).max(32768).optional(),
  width:z.number().int().min(64).max(16384).optional(),height:z.number().int().min(64).max(16384).optional(),
  idempotencyKey:id.optional()}).strict().superRefine((i,ctx)=>{
   if(!i.app&&!i.windowId)ctx.addIssue({code:'custom',path:['windowId'],message:'app or windowId required'});
   if(i.action==='focus'&&i.interactionMode!=='headed')ctx.addIssue({code:'custom',path:['interactionMode'],message:'focus requires headed mode'});
   if(i.action==='move'&&(i.x===undefined||i.y===undefined))ctx.addIssue({code:'custom',path:['x'],message:'move requires x and y'});
   if(i.action==='resize'&&(i.width===undefined||i.height===undefined))ctx.addIssue({code:'custom',path:['width'],message:'resize requires width and height'});
  }),
 desktop_session:z.object({...common,action:z.enum(['start','list','info','end']),
  sessionId:z.string().min(1).max(128).optional(),name:z.string().min(1).max(100).optional(),
  idempotencyKey:id.optional()}).strict()
  .superRefine((i,ctx)=>{
   if(['info','end'].includes(i.action)&&!i.sessionId)ctx.addIssue({code:'custom',path:['sessionId'],message:'sessionId required'});
  }),
} as const;
