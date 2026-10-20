import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ForegroundPool} from '../dist/foreground-pool.js';
import {batchInputSchema} from '@deskbeacon/protocol';

test('one device runs four commands, with FIFO local handoff',async()=>{
  const pool=new ForegroundPool(4);
  let active=0,max=0;
  const starts=[];
  const results=await Promise.all(Array.from({length:9},(_,i)=>pool.run('x'+i,async()=>{
    active++;max=Math.max(max,active);starts.push(i);
    await sleep(50);active--;return i;
  })));
  assert.deepEqual(results,[0,1,2,3,4,5,6,7,8]);
  assert.equal(max,4);
  assert.deepEqual(starts,[0,1,2,3,4,5,6,7,8]);
  assert.equal(pool.active,0);
  assert.equal(pool.queued,0);
});

test('queued commands can be cancelled and reject without execution',async()=>{
  const pool=new ForegroundPool(1,1);
  let release;
  const first=pool.run('long',()=>new Promise(r=>{release=r;}));
  const second=pool.run('batch:child',()=>{throw Error('must not run');});
  await assert.rejects(pool.run('third',async()=>{}),/QUEUE_FULL/);
  assert.equal(pool.cancelPending('batch'),1);
  await assert.rejects(second,/CANCELLED/);
  release();
  await first;
  assert.equal(pool.active,0);
  assert.equal(pool.queued,0);
});

test('queued timeout is independent of runtime command timeout',async()=>{
  const pool=new ForegroundPool(1);
  let release;
  const first=pool.run('long',()=>new Promise(r=>{release=r;}));
  await assert.rejects(pool.run('wait',async()=>{},undefined,30),/QUEUE_TIMEOUT/);
  release();
  await first;
});

test('two real local batches and a standalone command share one four-slot pool',async()=>{
  const data=mkdtempSync(join(tmpdir(),'deskbeacon-pool-'));
  // Dynamic import ensures daemon state remains isolated from the live service.
  process.env.DESKBEACON_DATA_DIR=data;
  const {ClientDaemon}=await import('../dist/daemon.js');
  const daemon=new ClientDaemon({url:'https://test.invalid',deviceId:'pool-fixture',clientId:'fixture',
    accessToken:'test',deviceName:'pool-fixture'});
  const command=(i)=>({mode:'program',program:process.execPath,args:['-e',
    `setTimeout(()=>console.log('task-${i}'),180)`],cwd:process.cwd()});
  const batch=(name)=>batchInputSchema.parse({deviceId:'pool-fixture',description:name,
    stages:[{parallel:true,calls:Array.from({length:4},(_,i)=>({
      id:name+'-'+i,tool:'exec_foreground',input:{description:'并发测试 '+i,command:command(name+'-'+i)}
    }))}]});
  let max=0;
  const interval=setInterval(()=>{max=Math.max(max,daemon.supervisor.foregroundPool.active);},5);
  try{
    const [a,b,c]=await Promise.all([
      daemon.execute('batch',batch('left'),randomUUID(),'grant'),
      daemon.execute('batch',batch('right'),randomUUID(),'grant'),
      daemon.execute('exec_foreground',{description:'独立命令',command:command('single'),timeoutMs:10000},'standalone:fixture','grant'),
    ]);
    assert.equal(a.completed,4);
    assert.equal(b.completed,4);
    assert.equal(a.failed+b.failed,0);
    assert.equal(c.exitCode,0);
    assert.ok(max>=2 && max<=4,'observed concurrency '+max);
    assert.equal(daemon.supervisor.foregroundPool.active,0);
    assert.equal(daemon.supervisor.foregroundPool.queued,0);
  }finally{
    clearInterval(interval);
    daemon.db.close();
    rmSync(data,{recursive:true,force:true});
  }
});
