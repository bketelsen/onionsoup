import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { DeliveryConfig } from './contracts.ts';
import { validateRepositoryBrief } from '../repository-brief/record.ts';
import { repositoryBriefHtml, repositoryBriefMarkdown } from '../repository-brief/render.ts';
export const bytesHash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
export async function composeMail(raw:unknown, config:DeliveryConfig, messageId:string, date:Date):Promise<Buffer> {
  const b=validateRepositoryBrief(raw);
  if (!['completed','partial'].includes(b.status) || !b.snapshot || b.request.repository!==config.repository)
    throw new Error('Only terminal usable briefs for the configured repository can be sent');
  const markdown=repositoryBriefMarkdown(b).replace('[Saved evidence and agent records](repository-brief.json) · [Common trace](events.json)',
    'Full evidence and trace are retained by the operator.').replace('No target code was executed and no GitHub or email writes were performed.',
    'The analysis performed no target code execution or GitHub writes. This copy was prepared by the email adapter.');
  const html=repositoryBriefHtml(b).replace('<p><a href="repository-brief.md">Markdown</a> · <a href="repository-brief.json">Saved evidence</a> · <a href="events.json">Trace</a></p>',
    '<p>Full evidence and trace are retained by the operator.</p>').replace('No target code execution or GitHub/email writes.',
    'The analysis performed no target code execution or GitHub writes. This copy was prepared by the email adapter.');
  const composer=nodemailer.createTransport({ streamTransport:true,buffer:true,newline:'windows' });
  const result=await composer.sendMail({ from:config.from,to:config.to,messageId,date,
    subject:`[Onionsoup] ${config.repository} — ${b.status} brief`,text:markdown,html,
    disableFileAccess:true,disableUrlAccess:true });
  if (!Buffer.isBuffer(result.message)) throw new Error('MIME buffering failed');
  return result.message;
}
export type SendOutcome='accepted'|'rejected'|'unknown';
export type MailSender=(message:Buffer)=>Promise<SendOutcome>;
export function smtpSender(raw:DeliveryConfig, env:NodeJS.ProcessEnv=process.env):MailSender {
  const c=DeliveryConfig.parse(raw), s=c.smtp;
  const user=s.auth ? env[s.auth.userEnv]:undefined, pass=s.auth ? env[s.auth.passwordEnv]:undefined;
  if (s.auth && (!user || !pass)) throw new Error('Missing SMTP environment credentials');
  const transport=nodemailer.createTransport({ host:s.host,port:s.port,secure:s.security==='tls',requireTLS:s.security==='starttls',
    ignoreTLS:s.security==='loopback',auth:s.auth ? { user:user!,pass:pass! }:undefined,
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:30000,dnsTimeout:10000,
    logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true });
  return async message=>{
    // One recipient avoids partial-recipient acceptance. Never log SMTP errors.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeout=new Promise<SendOutcome>(resolve=>{ timer=setTimeout(()=>{ transport.close(); resolve('unknown'); },60000); });
      const sending=transport.sendMail({ envelope:{ from:c.from,to:[c.to] },raw:message }).then(info=>
        info.accepted.length===1 && String(info.accepted[0]).toLowerCase()===c.to.toLowerCase() ? 'accepted' as const:'unknown' as const,
      (error:unknown)=>{
        const code=(error as { responseCode?:unknown })?.responseCode;
        return typeof code==='number' && code>=400 && code<=599 ? 'rejected' as const:'unknown' as const;
      });
      return await Promise.race([sending,timeout]);
    } finally { if(timer) clearTimeout(timer); transport.close(); }
  };
}
