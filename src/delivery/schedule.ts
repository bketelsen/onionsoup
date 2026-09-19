import { DeliveryConfig } from './contracts.ts';
// Latest due local minute only. Enumerating UTC minutes handles IANA transitions
// without guessing an offset; a repeated local minute has one stable identity.
export function latestOccurrence(raw:DeliveryConfig, now=new Date()) {
  const c=DeliveryConfig.parse(raw), timestamp=now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Invalid clock');
  const format=new Intl.DateTimeFormat('en-CA',{ timeZone:c.schedule.timeZone, year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short' });
  const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let chosen: { key:string; dueAt:string }|undefined;
  // Extra day locates the first occurrence of a folded minute even if that first
  // occurrence has just fallen outside the catch-up window.
  const oldest=timestamp-c.schedule.catchUpHours*3600000;
  for (let t=Math.floor(timestamp/60000)*60000;t>=oldest-86400000;t-=60000) {
    const p=Object.fromEntries(format.formatToParts(t).map(p=>[p.type,p.value]));
    if (`${p.hour}:${p.minute}`!==c.schedule.time || !c.schedule.weekdays.includes(weekdays.indexOf(p.weekday))) continue;
    const key=`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    if (chosen && chosen.key!==key) break;
    chosen={ key,dueAt:new Date(t).toISOString() };
  }
  return chosen && Date.parse(chosen.dueAt)>=oldest ? chosen:undefined;
}

// First configured occurrence strictly after now; skip duplicate DST fold minutes.
export function nextOccurrence(raw:DeliveryConfig,now=new Date()) {
  const c=DeliveryConfig.parse(raw), format=new Intl.DateTimeFormat('en-CA',{ timeZone:c.schedule.timeZone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short' });
  const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for(let t=Math.floor(now.getTime()/60000)*60000+60000;t<=now.getTime()+8*86400000;t+=60000) {
    const p=Object.fromEntries(format.formatToParts(t).map(p=>[p.type,p.value]));
    if (`${p.hour}:${p.minute}`!==c.schedule.time || !c.schedule.weekdays.includes(weekdays.indexOf(p.weekday))) continue;
    const occurrence=latestOccurrence({ ...c,schedule:{ ...c.schedule,catchUpHours:24 } },new Date(t));
    if (occurrence && Date.parse(occurrence.dueAt)===t) return occurrence;
  }
  return undefined;
}
