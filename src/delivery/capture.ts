import { SMTPServer } from 'smtp-server';
import { mkdir, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// Development sink only. It has no forwarding path and never contacts an MX host.
export async function captureServer(directory:string) {
  await mkdir(directory,{ recursive:true,mode:0o700 });
  let slots=0;
  const server=new SMTPServer({ name:'onionsoup.invalid',banner:'Local capture only; no forwarding',
    authOptional:true,disabledCommands:['AUTH','STARTTLS'],disableReverseLookup:true,logger:false,
    size:10*1024*1024,maxClients:5,socketTimeout:30000,closeTimeout:1000,
    onData(stream,_session,callback) {
      void (async()=>{
        const chunks:Buffer[]=[]; let size=0;
        for await(const chunk of stream) { size+=chunk.length; if(size<=10*1024*1024) chunks.push(Buffer.from(chunk)); }
        if(stream.sizeExceeded || size>10*1024*1024) throw new Error('Capture size limit');
        slots++;
        try {
          const names=await readdir(directory);
          if(names.filter(n=>n.endsWith('.eml')).length+slots>100) throw new Error('Capture retention limit');
          const name=join(directory,`${randomUUID()}.eml`), temp=name+'.tmp';
          try { await writeFile(temp,Buffer.concat(chunks),{ flag:'wx',mode:0o600 }); await rename(temp,name); }
          finally { await rm(temp,{ force:true }); }
        } finally { slots--; }
      })().then(()=>callback(),()=>callback(Object.assign(new Error('Local capture failed'),{ responseCode:451 })));
    } });
  return server;
}
