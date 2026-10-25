import {describe,it,expect} from 'vitest';
import {createPreview,previewFromEdges} from '../src/output-preview.js';

const bytes=(text:string)=>new TextEncoder().encode(text).length;
describe('unified output previews',()=>{
 it('keeps short content byte-exact including trailing lines',()=>{
  const value='开头\n中间\n结束\n';
  const result=createPreview(value,4096);
  expect(result).toMatchObject({text:value,truncated:false,strategy:'full',
    reason:'none',originalBytes:bytes(value),omittedBytes:0,hasFullOutput:true});
 });
 it('uses 50/50 head/tail for medium content and 25/75 for long content',()=>{
  const medium='HEAD-'+('A'.repeat(3500))+'\n'+('Z'.repeat(3500))+'-TAIL';
  const m=createPreview(medium,4096);
  expect(m.strategy).toBe('balanced');
  expect(m.truncated).toBe(true);
  expect(m.text.startsWith('HEAD-')).toBe(true);
  expect(m.text.endsWith('-TAIL')).toBe(true);
  const long='PREFIX\n'+('A'.repeat(20000))+'\n'+('B'.repeat(30000))+'\nSUFFIX';
  const l=createPreview(long,4096);
  expect(l.strategy).toBe('result_priority');
  expect(l.text.startsWith('PREFIX')).toBe(true);
  expect(l.text.endsWith('SUFFIX')).toBe(true);
  expect(bytes(l.text)).toBeLessThanOrEqual(4096);
  expect(l.omittedBytes+l.displayedBytes).toBe(l.originalBytes);
  expect(l.omittedBytes).toBeGreaterThan(40000);
 });
 it('never splits emoji, UTF8 scalars, or misreports count',()=>{
  const content='首行🪐\n'+('测试🚀\n'.repeat(2500))+'收尾😃\n';
  for(const budget of [128,512,4096,16384]){
   const out=createPreview(content,budget);
   expect(out.text).not.toContain('�');
   expect(bytes(out.text)).toBeLessThanOrEqual(budget);
   expect(out.omittedBytes+out.displayedBytes).toBe(out.originalBytes);
   expect(out.text.startsWith('首行')).toBe(true);
   expect(out.text.endsWith('收尾😃\n')).toBe(true);
  }
 });
 it('supports paged first and last edges with known full stream size',()=>{
  const content='BEGIN\n'+('line-data\\n'.repeat(10000))+'END\n';
  const result=createPreview(content,4096);
  const edges=previewFromEdges(content.slice(0,4096),content.slice(-4096),bytes(content),4096,{totalLines:result.totalLines});
  expect(edges).toEqual(result);
 });
 it('indicates original output unavailable independently of display clipping',()=>{
  const v=createPreview('out\\n'.repeat(1000),1024,{hasFullOutput:false});
  expect(v).toMatchObject({truncated:true,reason:'preview_budget',hasFullOutput:false});
 });
 it('rejects budgets smaller than an explicit useful marker',()=>{
  expect(()=>createPreview('data',32)).toThrow('INVALID_PREVIEW_BUDGET');
 });
});
