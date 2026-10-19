import assert from 'node:assert/strict';
import {terminalWindowTitle,writeTerminalTitle} from '../dist/terminal-title.js';
assert.equal(terminalWindowTitle('BenchPilot','connected',2),'BenchPilot · CONNECTED · 2 RUNNING');
assert.equal(terminalWindowTitle(' My\x1bTitle\x07 ', 'offline'), 'MyTitle · OFFLINE');
let output='';
writeTerminalTitle('Custom\x1b title',{isTTY:true,write:text=>{output+=text;return true}});
assert.equal(output,'\x1b]0;Custom title\x07');
console.log('PASS custom and status-aware terminal OSC title escapes control characters');
