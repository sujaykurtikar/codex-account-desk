import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../logic.js';
const { analyze, formatDuration } = globalThis.QuotaLogic;
const now = Date.now();
const w = (used, minutes, hours) => ({ usedPercent: used, windowDurationMins: minutes, resetsAt: Math.floor(now / 1000 + hours * 3600) });
const account = (extra = {}) => ({ id: 'a', label: 'A', source: 'manual', updatedAt: new Date(now).toISOString(), limits: { primary: w(20, 300, 2), secondary: w(30, 10080, 48) }, ...extra });
const state = (accounts, settings = {}) => ({ accounts, settings: { reserve: 10, strategy: 'balanced', bucket: 'auto', ...settings } });
test('unknown usage and null percentages are never treated as full', () => {
  for (const limits of [{ primary: null, secondary: null }, { primary: w(null,300,1), secondary: w(20,10080,48) }]) assert.equal(analyze(state([account({limits})]), now).recommended, null);
});
test('both windows must exceed reserve; zero stays exhausted even with no reserve', () => {
  assert.equal(analyze(state([account({ limits: { primary: w(1,300,1), secondary: w(95,10080,48) } })]), now).readyCount, 0);
  assert.equal(analyze(state([account({ limits: { primary: w(100,300,1), secondary: w(0,10080,48) } })], {reserve:0}), now).readyCount, 0);
});
test('past reset does not fabricate a refill', () => {
  const a = account({limits:{primary:w(30,300,-1),secondary:w(10,10080,48)}});
  const r = analyze(state([a]), now); assert.equal(r.recommended, null); assert.equal(r.ranked[0].shortRemaining, 70); assert.equal(r.ranked[0].shortResetDue, true);
});
test('stale connected readings and duplicate identities are excluded', () => {
  const live = account({source:'codex',connected:true,email:'a@example.com'});
  const r = analyze(state([live,{...live,id:'b'},account({id:'c',source:'codex',connected:true,updatedAt:new Date(now-16*60000).toISOString()})]),now);
  assert.equal(r.readyCount,1); assert.equal(r.recommended.account.id,'a');
});
test('selected model pool never borrows another pool', () => {
  assert.equal(analyze(state([account()],{bucket:'missing'}),now).recommended,null);
});
test('a fresh duplicate takes precedence over an old snapshot of the same identity', () => {
  const old=account({source:'codex',connected:true,email:'a@example.com',updatedAt:new Date(now-3600000).toISOString()});
  const fresh={...old,id:'fresh',updatedAt:new Date(now).toISOString()};
  assert.equal(analyze(state([old,fresh]),now).recommended.account.id,'fresh');
});
test('capacity prefers more room, reset prefers sooner refresh', () => {
  const a=account(),b=account({id:'b',label:'B',limits:{primary:w(50,300,0.1),secondary:w(30,10080,48)}});
  assert.equal(analyze(state([a,b],{strategy:'capacity'}),now).recommended.account.id,'a');
  assert.equal(analyze(state([a,b],{strategy:'reset'}),now).recommended.account.id,'b');
});
test('manual unknown reset is not invented; events retain exact independent timestamps', () => {
  const a=account(); a.limits.primary.resetsAt=null;
  const r=analyze(state([a]),now); assert.equal(r.events.length,1); assert.equal(r.events[0].kind,'weekly');
  assert.equal(formatDuration(0),'Due now'); assert.equal(formatDuration(3601),'1h 1m');
});
