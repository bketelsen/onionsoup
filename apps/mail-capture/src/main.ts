import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { captureServer } from '@onionsoup/brief-delivery/capture';
if (process.argv.includes('--help')) process.stdout.write('Usage: npm run mail-capture -- DIRECTORY [--port 2525]\n');
else try {
  const { values,positionals }=parseArgs({ allowPositionals:true,options:{ port:{ type:'string',default:'2525' } } });
  if(positionals.length!==1 || !/^\d+$/.test(values.port) || Number(values.port)<1 || Number(values.port)>65535) throw new Error('Invalid args');
  const server=await captureServer(resolve(positionals[0]));
  server.on('error',()=>{ process.stderr.write('Local capture listener failed.\n'); process.exitCode=1; server.close(); });
  server.listen(Number(values.port),'127.0.0.1',()=>process.stdout.write('Local capture relay listening on loopback; mail is saved only, never forwarded.\n'));
  const stop=()=>server.close(); process.once('SIGINT',stop); process.once('SIGTERM',stop);
} catch { process.stderr.write('Usage: npm run mail-capture -- DIRECTORY [--port 2525]\n'); process.exitCode=1; }
