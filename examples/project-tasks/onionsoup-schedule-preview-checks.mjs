import assert from 'node:assert/strict';
import * as schedule from '/work/src/delivery/schedule.ts';
const config={schemaVersion:1,jobId:'preview',repository:'example/widget',provider:'copilot',days:7,maxSuggestions:0,schedule:{timeZone:'America/New_York',time:'08:00',weekdays:[0,1,2,3,4,5,6],catchUpHours:2},from:'onionsoup@example.invalid',to:'maintainer@example.invalid',smtp:{host:'127.0.0.1',port:2525,security:'loopback'}};
const occurrence=(key,dueAt)=>({key,dueAt});
export function checkExistingSchedule() {
 assert.deepEqual(schedule.latestOccurrence(config,new Date('2026-09-19T12:05:00Z')),occurrence('2026-09-19T08:00','2026-09-19T12:00:00.000Z'));
 assert.deepEqual(schedule.nextOccurrence(config,new Date('2026-09-19T12:00:00Z')),occurrence('2026-09-20T08:00','2026-09-20T12:00:00.000Z'));
}
export function checkPreviewBasic() {
 assert.equal(typeof schedule.nextOccurrences,'function');
 const frozen=JSON.stringify(config),now=new Date('2026-09-19T12:00:00Z');
 assert.deepEqual(schedule.nextOccurrences(config,3,now),[20,21,22].map(d=>occurrence(`2026-09-${d}T08:00`,`2026-09-${d}T12:00:00.000Z`)));
 assert.deepEqual(schedule.nextOccurrences({...config,schedule:{...config.schedule,weekdays:[1,2,3,4,5]}},2,new Date('2026-09-18T12:00:00Z')),[occurrence('2026-09-21T08:00','2026-09-21T12:00:00.000Z'),occurrence('2026-09-22T08:00','2026-09-22T12:00:00.000Z')]);
 const weekly={...config,schedule:{...config.schedule,weekdays:[1]}};
 const many=schedule.nextOccurrences(weekly,14,now);assert.equal(many.length,14);assert.equal(many.at(-1).key,'2026-12-21T08:00');
 assert.equal(new Set(many.map(o=>o.key)).size,14);assert.ok(many.every((o,i)=>Date.parse(o.dueAt)>(i?Date.parse(many[i-1].dueAt):now.getTime())));
 assert.equal(JSON.stringify(config),frozen);assert.equal(now.toISOString(),'2026-09-19T12:00:00.000Z');
}
export function checkPreviewDST() {
 assert.equal(typeof schedule.nextOccurrences,'function');
 const spring={...config,schedule:{...config.schedule,time:'02:30',weekdays:[0]}};
 assert.deepEqual(schedule.nextOccurrences(spring,2,new Date('2026-03-07T00:00:00Z')),[occurrence('2026-03-15T02:30','2026-03-15T06:30:00.000Z'),occurrence('2026-03-22T02:30','2026-03-22T06:30:00.000Z')]);
 const fall={...config,schedule:{...config.schedule,time:'01:30'}};
 assert.deepEqual(schedule.nextOccurrences(fall,2,new Date('2026-11-01T05:00:00Z')),[occurrence('2026-11-01T01:30','2026-11-01T05:30:00.000Z'),occurrence('2026-11-02T01:30','2026-11-02T06:30:00.000Z')]);
 assert.deepEqual(schedule.nextOccurrences(fall,1,new Date('2026-11-01T06:00:00Z')),[occurrence('2026-11-02T01:30','2026-11-02T06:30:00.000Z')]);
}
export function checkPreviewValidation() {
 assert.equal(typeof schedule.nextOccurrences,'function');
 for(const count of [0,-1,15,1.5,NaN,Infinity,'2'])assert.throws(()=>schedule.nextOccurrences(config,count,new Date('2026-09-19T12:00:00Z')));
 assert.throws(()=>schedule.nextOccurrences(config,1,new Date('invalid')));
 assert.throws(()=>schedule.nextOccurrences({...config,schedule:{...config.schedule,weekdays:[]}},1,new Date('2026-09-19T12:00:00Z')));
}
