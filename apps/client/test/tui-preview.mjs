// Render the actual Ink tree to a deterministic terminal-size preview, offline.
import React from 'react';
import {renderToString} from 'ink';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {App} from '../dist/tui.js';
const root=fileURLToPath(new URL('../../../.test-data/tui-previews/',import.meta.url));
mkdirSync(root,{recursive:true});
for(const [w,h] of [[160,40],[100,28],[48,64],[32,16]]){
 process.stdout.columns=w;process.stdout.rows=h;
 const text=renderToString(React.createElement(App,{demoScenario:'busy'}),{columns:w});
 writeFileSync(`${root}/${w}x${h}.txt`,text);
 console.log(`${w}x${h}: ${text.split('\n').length} lines`);
}
