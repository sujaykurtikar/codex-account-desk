import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs');
const root=dirname(dirname(fileURLToPath(import.meta.url))),data=await mkdtemp(join(tmpdir(),'desk-browser-'));
await chmod(join(root,'test/fake-codex.mjs'),0o755);
const child=spawn(process.execPath,[join(root,'server.mjs')],{env:{...process.env,PORT:'0',ACCOUNT_DESK_DATA:data,CODEX_BIN:join(root,'test/fake-codex.mjs')},stdio:['ignore','pipe','pipe']});
let browser;
try {
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout')),10000);child.stdout.on('data',chunk=>{const m=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0])}})});
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Kolkata'});
  await context.route('https://auth.openai.com/**',route=>route.fulfill({body:'Test sign-in only'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#modeLabel').textContent==='Local server');
  assert.equal(await page.locator('.account-row').count(),0,'New shared list starts empty');
  await page.locator('#addButton').click();
  await page.locator('#deviceDialog[open]').waitFor();
  assert.match(await page.locator('#deviceCode').textContent(),/ABCD-EFGH/);
  await page.locator('#devicePending').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('.account-row .account-name')?.textContent.includes('@example.com'),null,{timeout:10000});
  assert.equal(await page.locator('.account-row').count(),1,'Add creates one account');
  assert.equal(await page.locator('.account-name').first().textContent().then(x=>x.includes('@example.com')),true,'Verified email is primary identity');
  assert.equal(await page.locator('[data-action=copy]').count(),1,'Local server exposes its isolated profile command');
  await page.screenshot({path:'/tmp/account-desk-desktop.png'});
  const overflow=()=>document.documentElement.scrollWidth>window.innerWidth;
  assert.equal(await page.evaluate(overflow),false,'No desktop overflow');
  for(const width of [390,320,640,768,990,1024]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const overflowNodes=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>1&&(r.right>innerWidth+1||r.left<-1)}).slice(0,10).map(el=>`${el.tagName}.${el.className}:${Math.round(el.getBoundingClientRect().right)}`));
    const dimensions=await page.evaluate(()=>`${document.documentElement.scrollWidth}/${innerWidth}, body ${document.body.scrollWidth}/${document.body.clientWidth}; ${[...document.querySelectorAll('body *')].filter(el=>el.scrollWidth>el.clientWidth+1).slice(0,10).map(el=>`${el.tagName}.${el.className}=${el.scrollWidth}/${el.clientWidth}`).join(', ')}`);
    assert.equal(await page.evaluate(overflow),false,`No overflow at ${width}px: ${dimensions} ${overflowNodes.join(', ')}`);
    const overlap=await page.evaluate(()=>[...document.querySelectorAll('.account-row')].some(row=>{const actions=row.querySelector('.row-actions').getBoundingClientRect();return ['.account-identity','.quota-pair','.status-cell'].some(sel=>{const r=row.querySelector(sel).getBoundingClientRect();return Math.min(actions.right,r.right)>Math.max(actions.left,r.left)&&Math.min(actions.bottom,r.bottom)>Math.max(actions.top,r.top)})}));
    assert.equal(overlap,false,`Account controls do not overlap at ${width}px`);
  }
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/account-desk-mobile.png'});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#accountCount').textContent==='1');
  assert.deepEqual(errors,[]);
  const filePage=await context.newPage();await filePage.goto('file://'+join(root,'index.html'));await filePage.waitForFunction(()=>document.querySelector('#modeLabel').textContent==='Manual mode');assert.equal(await filePage.locator('.account-row').count(),0);
  console.log('Browser checks passed: empty start, add and device sign-in, email identity, shared server persistence, manual empty mode, responsive layout.');
} finally {await browser?.close();child.kill('SIGTERM');await once(child,'exit');await rm(data,{recursive:true,force:true})}
