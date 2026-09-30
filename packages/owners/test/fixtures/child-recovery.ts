import { DatabaseSync } from 'node:sqlite';
export function childStore(database: string, childID = 'ses_child', parentID = 'ses_parent', directory = '/chats') {
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);`);
  db.prepare('insert into session values (?,?,?,?)').run(childID, parentID, directory, 1);
  db.prepare('insert into message values (?,?,?,?)').run('msg_user', childID, 1, JSON.stringify({role:'user',format:{type:'json_schema',schema:{type:'object'},retryCount:2},time:{created:1}}));
  db.prepare('insert into message values (?,?,?,?)').run('msg_answer', childID, 2, JSON.stringify({role:'assistant',parentID:'msg_user',time:{created:2}}));
  db.prepare('insert into part values (?,?,?,?,?)').run('prt_text','msg_user',childID,1,JSON.stringify({type:'text',text:'Preserved original watcher prompt'}));
  return db;
}
