import { parseArgs } from 'node:util';
import { loadConsoleConfig } from './config.ts';
import { Operator } from './actions.ts';
import { consoleServer } from './server.ts';
export async function serve(args:string[]) {
  const { values,positionals }=parseArgs({ args,allowPositionals:true,options:{ config:{ type:'string' },port:{ type:'string',default:'8765' } } });
  if(positionals.length||!values.config||!/^\d+$/.test(values.port)||Number(values.port)<1||Number(values.port)>65535) throw new Error('Usage: inbox serve --config CONFIG [--port 8765]');
  globalThis.AI_SDK_LOG_WARNINGS=false;
  console.error=console.warn=()=>process.stderr.write('Diagnostic suppressed; inspect saved workflow status.\n');
  const operator=new Operator(await loadConsoleConfig(values.config)), server=consoleServer(operator);
  server.on('error',()=>{ process.stderr.write('Console listener failed. Check the selected port.\n');process.exitCode=1; });
  server.listen(Number(values.port),'127.0.0.1',()=>process.stdout.write(`Onionsoup inbox: http://127.0.0.1:${values.port}/\n`));
  const stop=()=>{ server.close();void operator.idle(); };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
