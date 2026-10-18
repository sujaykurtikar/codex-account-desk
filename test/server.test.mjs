import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import http from 'node:http';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
test('local API: CRUD, isolated login, usage normalization, private storage, origin protection', async t => {
  const data=await mkdtemp(join(tmpdir(),'account-desk-test-'));
  const fake=join(root,'test/fake-codex.mjs'); await chmod(fake,0o755);
  const child=spawn(process.execPath,[join(root,'server.mjs')],{env:{...process.env,PORT:'0',ACCOUNT_DESK_DATA:data,CODEX_BIN:fake},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM');await once(child,'exit');await rm(data,{recursive:true,force:true})});
  let output='';
  const url=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Server start timed out')),10000);child.stdout.on('data',chunk=>{output+=chunk;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timeout);resolve(m[0])}});child.once('error',reject)});
  async function api(path,method='GET',body){const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
  let result=await api('/api/state');assert.equal(result.data.accounts.length,0);
  result=await api('/api/accounts','POST',{});assert.equal(result.data.accounts.length,1);let id=result.data.accounts[0].id;
  result=await api('/api/accounts/'+id,'PATCH',{label:'Primary',limits:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:null},secondary:{usedPercent:40,windowDurationMins:10080,resetsAt:null}}});assert.equal(result.data.accounts[0].label,'Primary');
  assert.equal((await api('/api/settings','PATCH',{reserve:-1})).status,400);
  assert.equal((await fetch(url+'/api/state',{headers:{Origin:'https://example.com'}})).status,403);
  const badHost = await new Promise((resolve,reject) => { const req=http.get(url+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject); });
  assert.equal(badHost,403);
  assert.equal((await fetch(url+'/server.mjs')).status,404);
  result=await api('/api/accounts/'+id+'/connect','POST',{});assert.equal(result.data.verificationUrl,'https://auth.openai.com/codex/device');assert.equal(result.data.userCode,'ABCD-EFGH');
  await new Promise(r=>setTimeout(r,400));result=await api('/api/state');const live=result.data.accounts[0];assert.equal(live.connected,true);assert.equal(live.email,`${id}@example.com`);assert.equal(live.label,live.email);assert.equal(live.limits.primary.usedPercent,25);assert.equal(live.buckets.length,2);assert.ok(live.command.includes(data));assert.ok(!JSON.stringify(result.data).includes('accessToken'));
  assert.equal((await api('/api/accounts/'+id,'PATCH',{label:'',email:live.email,plan:'Plus'})).status,200,'Email identity remains primary while optional notes are blank');
  assert.equal((await api('/api/accounts/'+id,'PATCH',{email:'other@example.com'})).status,400,'Connected email cannot be edited');
  assert.equal((await readFile(join(data,'profiles',id,'config.toml'),'utf8')).trim(),'cli_auth_credentials_store = "file"');
  assert.equal((await api('/api/accounts/'+id,'PATCH',{limits:live.limits})).status,400);
  result=await api('/api/accounts/'+id+'/disconnect','POST',{});assert.equal(result.data.accounts[0].connected,false);assert.equal(result.data.accounts[0].limits.primary,null);
  result=await api('/api/accounts','POST',{label:'Second'});assert.equal(result.data.accounts.length,2);
  result=await api('/api/accounts/'+id,'DELETE');assert.equal(result.data.accounts.length,1);
  const saved=JSON.parse(await readFile(join(data,'state.json'),'utf8'));assert.equal(saved.accounts.length,1);
});

test('shared password gives separate browser sessions access to one account list', async t => {
  const data=await mkdtemp(join(tmpdir(),'account-desk-shared-'));
  const child=spawn(process.execPath,[join(root,'server.mjs')],{env:{...process.env,PORT:'0',ACCOUNT_DESK_DATA:data,DASHBOARD_PASSWORD:'group-secret'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM');await once(child,'exit');await rm(data,{recursive:true,force:true})});
  let output='';
  const url=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Server start timed out')),10000);child.stdout.on('data',chunk=>{output+=chunk;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timeout);resolve(m[0])}});child.once('error',reject)});
  async function call(path,method='GET',body,cookie){const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
  assert.equal((await call('/api/state')).status,401);
  assert.equal((await call('/api/session/login','POST',{password:'wrong'})).status,401);
  const alice=await call('/api/session/login','POST',{password:'group-secret'});assert.equal(alice.status,200);
  const bob=await call('/api/session/login','POST',{password:'group-secret'});assert.equal(bob.status,200);
  assert.notEqual(alice.cookie,bob.cookie);
  const created=await call('/api/accounts','POST',{},alice.cookie);assert.equal(created.data.accounts.length,1);
  const shared=await call('/api/state','GET',undefined,bob.cookie);assert.equal(shared.status,200);assert.equal(shared.data.accounts.length,1);
  assert.equal((await call('/api/state')).status,401);
});
