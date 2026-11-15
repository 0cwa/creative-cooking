import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './contracts.mjs';
const base = () => ({action:'restorePrivate',policy:'p1',accepted:true,conflict:false,proof:'valid',admitted:false,recipient:'owner',destination:'device',content:'catalog',purpose:'recover',rules:[],consents:[],requiredPeople:[],quorums:[],local:false,retention:null});
const check = (r, result, reason) => assert.deepEqual(decide(r), {result,reasons:[reason]});
test('independent private recovery and admission are separate', () => {
 const r=base(); check(r,'Allow','OK'); r.action='releaseSharedKey'; check(r,'Pending','ADMISSION_REQUIRED');
});
test('assisted package and guardian shared key', () => {
 const r=base(); r.action='releasePrivatePackage'; r.quorums=[{electorate:['a','b','c'],threshold:2,approvals:['a','b']}]; r.requiredPeople=['owner']; r.consents=[{person:'owner',policy:'p1',recipient:'owner',content:'catalog',purpose:'recover',scope:r.action}]; check(r,'Allow','OK');
 r.action='releaseSharedKey'; r.admitted=true; r.recipient='guardian'; r.rules=[{actions:['releaseSharedKey'],recipients:['adult'],destinations:['device'],contents:['catalog'],purposes:['recover']}]; check(r,'Deny','PROHIBITED');
});
test('shared AI restriction and explicit local alternative', () => {
 const r=base(); Object.assign(r,{action:'disclose',recipient:'provider',destination:'external',content:'selected-recipe',purpose:'meal-advice',rules:[{actions:['disclose'],recipients:['provider'],destinations:['external'],contents:['selected-recipe'],purposes:['meal-advice']}]});
 check(r,'Allow','OK');
 const forbiddenContent={...r,content:'household-allergies'}; check(forbiddenContent,'Deny','PROHIBITED');
 const forbiddenPurpose={...r,purpose:'advertising'}; check(forbiddenPurpose,'Deny','PROHIBITED');
 const missingConsent={...forbiddenContent,requiredPeople:['affected']}; check(missingConsent,'Deny','PROHIBITED');
 const approvedButForbidden={...forbiddenPurpose,requiredPeople:['owner'],consents:[{person:'owner',policy:'p1',recipient:'provider',content:'selected-recipe',purpose:'advertising',scope:'disclose'}]}; check(approvedButForbidden,'Deny','PROHIBITED');
 forbiddenContent.local=true; check(forbiddenContent,'LocalOnly','LOCAL_ALTERNATIVE');
});
test('consent binds recipient content purpose and policy', () => {
 const r=base(); r.action='disclose'; r.requiredPeople=['a']; r.consents=[{person:'a',policy:'p1',recipient:'owner',content:'catalog',purpose:'recover',scope:'disclose'}]; check(r,'Allow','OK');
 for (const [key,value] of [['recipient','other'],['content','other'],['purpose','other'],['policy','p2']]) { const changed={...r,[key]:value}; check(changed,'RequireConsent','CONSENT_REQUIRED'); }
});
test('recipient rules require explicit typed content and purpose limits', () => {
 const r=base(); r.rules=[{actions:['restorePrivate'],recipients:['owner'],destinations:['device'],contents:['catalog'],purposes:['recover']}]; check(r,'Allow','OK');
 for (const field of ['contents','purposes']) {
  const missing={...r,rules:[{...r.rules[0]}]}; delete missing.rules[0][field]; check(missing,'Deny','INVALID_INPUT');
  const invalid={...r,rules:[{...r.rules[0],[field]:[false]}]}; check(invalid,'Deny','INVALID_INPUT');
 }
});
test('distinct adults and weak recovered identity', () => {
 const r=base(); Object.assign(r,{action:'approve',quorums:[{electorate:['a','b'],threshold:2,approvals:['a','a']}]}); check(r,'Pending','ADMISSION_REQUIRED'); r.admitted=true; check(r,'Pending','QUORUM_REQUIRED'); r.quorums[0].approvals.push('b'); check(r,'Allow','OK');
});
test('historical consent remains necessary while new content can branch', () => {
 const r=base(); r.action='disclose'; r.requiredPeople=['affected']; r.consents=[{person:'affected',policy:'p1',recipient:'old',content:'catalog',purpose:'recover',scope:'disclose'}]; check(r,'RequireConsent','CONSENT_REQUIRED'); r.consents=[]; r.requiredPeople=[]; r.content='new'; check(r,'Allow','OK');
});
test('offline policy conflict and incompatible retention fail closed', () => {
 const r=base(); r.conflict=true; check(r,'Pending','POLICY_UNRESOLVED'); r.conflict=false; r.action='enrollHost'; r.retention=[{min:0,max:7},{min:30,max:90}]; check(r,'Deny','INCOMPATIBLE'); r.retention=[{min:0,max:30},{min:7,max:90}]; check(r,'Allow','OK'); r.extra=true; check(r,'Deny','INVALID_INPUT');
});
