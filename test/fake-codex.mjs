#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
let loggedIn = false;
const send = v => process.stdout.write(JSON.stringify(v) + '\n');
createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line); if(msg.id===undefined)return;
  let result={};
  if(msg.method==='account/login/start') {
    result={type:'chatgptDeviceCode',loginId:'test-login',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH'};
    setTimeout(()=>{loggedIn=true;send({method:'account/login/completed',params:{success:true,loginId:'test-login'}})},150);
  }
  if(msg.method==='account/read') result={account:loggedIn?{type:'chatgpt',email:basename(process.env.CODEX_HOME)+'@example.com',planType:'plus'}:null,requiresOpenaiAuth:true};
  if(msg.method==='account/logout') loggedIn=false;
  if(msg.method==='account/rateLimits/read') {
    const primary={usedPercent:25,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600},secondary={usedPercent:40,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400};
    result={rateLimits:{primary,secondary},rateLimitsByLimitId:{codex:{limitName:'Codex',primary,secondary},fast:{limitName:'Fast model',primary:{...primary,usedPercent:50},secondary}}};
  }
  send({id:msg.id,result});
});
