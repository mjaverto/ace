// tests/helpers/opencode-fixture.ts
//
// Seeds a temporary SQLite database with a minimal opencode schema + rows
// for snapshot tests. Each call produces a fresh tmp file; the caller is
// responsible for cleanup (fs.unlink / fs.rm).

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

export type Scenario =
  | "01-basic"
  | "02-tool-error"
  | "03-reasoning"
  | "04-archived-skipped";

export interface FixtureResult {
  dbPath: string;
  sessionId: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  share_url TEXT,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_archived INTEGER
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
`;

function seed01Basic(db: Database.Database, sessionId: string): void {
  db.prepare(`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)`)
    .run(sessionId,"proj_basic","my-project","/home/user/my-project","Basic Session","0.3.1",1746000000000,1746000060000);
  const m1 = "msg_user_01";
  db.prepare(`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`)
    .run(m1,sessionId,1746000010000,1746000010000,JSON.stringify({role:"user"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_u01",m1,sessionId,1746000010000,1746000010000,JSON.stringify({type:"text",text:"Hello, what can you do?"}));
  const m2 = "msg_asst_01";
  db.prepare(`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`)
    .run(m2,sessionId,1746000020000,1746000020000,JSON.stringify({role:"assistant"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_a01",m2,sessionId,1746000020000,1746000020000,JSON.stringify({type:"text",text:"I can help you write code, answer questions, and more."}));
}

function seed02ToolError(db: Database.Database, sessionId: string): void {
  db.prepare(`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)`)
    .run(sessionId,"proj_tool_error","tool-error-project","/home/user/tool-error-project","Tool Error Session","0.3.1",1746001000000,1746001060000);
  const m1 = "msg_user_02";
  db.prepare(`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`)
    .run(m1,sessionId,1746001010000,1746001010000,JSON.stringify({role:"user"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_u02",m1,sessionId,1746001010000,1746001010000,JSON.stringify({type:"text",text:"Run the failing command."}));
  const m2 = "msg_asst_02";
  db.prepare(`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`)
    .run(m2,sessionId,1746001020000,1746001020000,JSON.stringify({role:"assistant"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_ss02",m2,sessionId,1746001020000,1746001020000,JSON.stringify({type:"step-start"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_t02",m2,sessionId,1746001021000,1746001021000,JSON.stringify({type:"tool",tool:"Bash",state:{status:"error",input:{command:"exit 1"},error:"command failed"}}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_sf02",m2,sessionId,1746001022000,1746001022000,JSON.stringify({type:"step-finish"}));
}

function seed03Reasoning(db: Database.Database, sessionId: string): void {
  db.prepare(`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)`)
    .run(sessionId,"proj_reasoning","reasoning-project","/home/user/reasoning-project","Reasoning Session","0.3.1",1746002000000,1746002060000);
  const m1 = "msg_user_03";
  db.prepare(`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`)
    .run(m1,sessionId,1746002010000,1746002010000,JSON.stringify({role:"user"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_u03",m1,sessionId,1746002010000,1746002010000,JSON.stringify({type:"text",text:"Solve this problem step by step."}));
  const m2 = "msg_asst_03";
  db.prepare(`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`)
    .run(m2,sessionId,1746002020000,1746002020000,JSON.stringify({role:"assistant"}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_r03",m2,sessionId,1746002020000,1746002020000,JSON.stringify({type:"reasoning",text:"Let me think through this carefully."}));
  db.prepare(`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`)
    .run("part_t03",m2,sessionId,1746002021000,1746002021000,JSON.stringify({type:"text",text:"The answer is 42."}));
}

function seed04ArchivedSkipped(db: Database.Database, sessionId: string): void {
  db.prepare(`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated,time_archived) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sessionId,"proj_archived","archived-project","/home/user/archived-project","Archived Session","0.3.1",1746003000000,1746003060000,1746003120000);
}

export function seedOpencodeFixture(scenario: Scenario): FixtureResult {
  const unique = crypto.randomBytes(8).toString("hex");
  const dbPath = path.join(os.tmpdir(), `opencode-fixture-${scenario}-${unique}.db`);
  const sessionId = `ses_${scenario}_${unique}`;
  const db = new Database(dbPath);
  try {
    db.exec(DDL);
    if (scenario === "01-basic") seed01Basic(db, sessionId);
    else if (scenario === "02-tool-error") seed02ToolError(db, sessionId);
    else if (scenario === "03-reasoning") seed03Reasoning(db, sessionId);
    else seed04ArchivedSkipped(db, sessionId);
  } finally {
    db.close();
  }
  return { dbPath, sessionId };
}
