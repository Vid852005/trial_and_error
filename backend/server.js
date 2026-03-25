const express   = require("express");
const cors      = require("cors");
const { spawn } = require("child_process");
const path      = require("path");
const { v4: uuidv4 } = require("uuid");
const http      = require("http");
const WebSocket = require("ws");

const app    = express();
const server = http.createServer(app);

const PORT         = process.env.PORT || 4000;
const DOCKER_IMAGE = "lex-sandbox";

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastActive > 20 * 60 * 1000) {
      spawn("docker", ["rm", "-f", s.containerName]);
      sessions.delete(sid);
    }
  }
}, 60_000);
function execPromise(args) {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    let out = "", err = "";
    const cp = spawn(cmd, rest);
    cp.stdout.on("data", d => (out += d));
    cp.stderr.on("data", d => (err += d));
    cp.on("error", reject);
    cp.on("close", code =>
      code === 0 ? resolve(out) : reject(new Error(err || `Exit ${code}`))
    );
  });
}

function safeName(raw) {
  return String(raw).replace(/[^a-zA-Z0-9._\-]/g, "").replace(/\.\./g, "");
}

function touch(sid) {
  if (sessions.has(sid)) sessions.get(sid).lastActive = Date.now();
}
app.post("/api/session", async (req, res) => {
  const sid           = uuidv4();
  const containerName = `lex-sandbox-${sid}`;

  try {
    await execPromise([
      "docker", "run", "-d", "--rm",
      "--name", containerName,
      "--network=none",
      "--memory=128m", "--cpus=0.5",
      DOCKER_IMAGE, "sleep", "infinity"
    ]);

    sessions.set(sid, { containerName, lastActive: Date.now() });

    const starter = [
      "%{",
      "#include <stdio.h>",
      "%}",
      "%%",
      "[a-zA-Z]+   { printf(\"WORD: %s\\n\", yytext); }",
      "[0-9]+      { printf(\"NUM:  %s\\n\", yytext); }",
      "[ \\t\\n]   { /* skip whitespace */ }",
      ".           { printf(\"OTHER: %s\\n\", yytext); }",
      "%%",
      "int yywrap(){ return 1; }",
      "int main(){",
      "  printf(\"Enter text (Ctrl-D to finish):\\n\");",
      "  yylex();",
      "  return 0;",
      "}",
    ].join("\n");

    await new Promise((ok, fail) => {
      const cp = spawn("docker", ["exec", "-i", containerName, "sh", "-c", "cat > /sandbox/scanner.l"]);
      cp.stdin.end(starter);
      cp.on("close", c => c === 0 ? ok() : fail(new Error("seed failed")));
    });

    res.json({ success: true, sid });
  } catch (e) {
    console.error("[session]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.get("/api/fs/list", async (req, res) => {
  const { sid } = req.query;
  if (!sid || !sessions.has(sid)) return res.status(400).json({ success: false, error: "Bad sid" });
  touch(sid);
  const { containerName } = sessions.get(sid);
  try {
    const out = await execPromise(["docker", "exec", containerName, "sh", "-c",
      "find /sandbox -maxdepth 1 -type f ! -name 'lex.yy.c' ! -name 'out_bin' ! -name 'a.out' ! -name '.*' | sed 's|/sandbox/||' | sort"]);
    res.json({ success: true, files: out.trim().split("\n").filter(Boolean) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.get("/api/fs/read", async (req, res) => {
  const { sid, file } = req.query;
  if (!sid || !file || !sessions.has(sid)) return res.status(400).json({ success: false, error: "Bad request" });
  touch(sid);
  const { containerName } = sessions.get(sid);
  try {
    const content = await execPromise(["docker", "exec", containerName, "cat", `/sandbox/${safeName(file)}`]);
    res.json({ success: true, content });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/fs/write", (req, res) => {
  const { sid, file, content } = req.body;
  if (!sid || !file || !sessions.has(sid)) return res.status(400).json({ success: false, error: "Bad request" });
  touch(sid);
  const { containerName } = sessions.get(sid);
  const cp = spawn("docker", ["exec", "-i", containerName, "sh", "-c", `cat > '/sandbox/${safeName(file)}'`]);
  cp.stdin.end(content ?? "");
  cp.on("close", c => c === 0
    ? res.json({ success: true })
    : res.status(500).json({ success: false, error: "write failed" }));
});
app.post("/api/fs/rename", async (req, res) => {
  const { sid, oldName, newName } = req.body;
  if (!sid || !oldName || !newName || !sessions.has(sid))
    return res.status(400).json({ success: false, error: "Bad request" });
  touch(sid);
  const { containerName } = sessions.get(sid);
  try {
    await execPromise([
      "docker", "exec", containerName,
      "mv",
      `/sandbox/${safeName(oldName)}`,
      `/sandbox/${safeName(newName)}`
    ]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/fs/delete", async (req, res) => {
  const { sid, file } = req.body;
  if (!sid || !file || !sessions.has(sid))
    return res.status(400).json({ success: false, error: "Bad request" });
  touch(sid);
  const { containerName } = sessions.get(sid);
  try {
    await execPromise([
      "docker", "exec", containerName,
      "rm", "-f", `/sandbox/${safeName(file)}`
    ]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.get("/api/fs/download", (req, res) => {
  const { sid, file } = req.query;
  if (!sid || !file || !sessions.has(sid)) return res.status(400).send("bad");
  touch(sid);
  const { containerName } = sessions.get(sid);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName(file)}"`);
  spawn("docker", ["exec", containerName, "cat", `/sandbox/${safeName(file)}`]).stdout.pipe(res);
});
app.get("/api/fs/download-all", (req, res) => {
  const { sid } = req.query;
  if (!sid || !sessions.has(sid)) return res.status(400).send("bad");
  touch(sid);
  const { containerName } = sessions.get(sid);
  res.setHeader("Content-Disposition", 'attachment; filename="project.zip"');
  res.setHeader("Content-Type", "application/zip");
  spawn("docker", ["exec", containerName, "sh", "-c",
    "cd /sandbox && zip -qr - . -x 'lex.yy.c' -x 'out_bin' -x 'a.out'"
  ]).stdout.pipe(res);
});
app.post("/api/compile", async (req, res) => {
  const { sid, file } = req.body;
  if (!sid || !file || !sessions.has(sid)) return res.status(400).json({ success: false, error: "Bad request" });
  touch(sid);
  const { containerName } = sessions.get(sid);
  const f = safeName(file);

  let compileCmd;
  if (f.endsWith(".l")) {
    compileCmd = `cd /sandbox && flex '${f}' 2>&1 && gcc lex.yy.c -lfl -o out_bin 2>&1`;
  } else if (f.endsWith(".c")) {
    compileCmd = `cd /sandbox && gcc '${f}' -o out_bin 2>&1`;
  } else {
    return res.status(400).json({ success: false, error: "Only .l and .c files supported" });
  }

  try {
    const output = await execPromise(["docker", "exec", containerName, "sh", "-c", compileCmd]);
    res.json({ success: true, output: output.trim() });
  } catch (e) {
    res.json({ success: false, output: e.message.trim() });
  }
});
const wssRun = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const idx      = req.url.indexOf("?");
  const pathname = idx !== -1 ? req.url.slice(0, idx) : req.url;
  if (pathname === "/run") {
    wssRun.handleUpgrade(req, socket, head, ws => {
      wssRun.emit("connection", ws, req);
    });
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

wssRun.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const sid = url.searchParams.get("sid");

  if (!sid || !sessions.has(sid)) {
    ws.close(1008, "bad sid");
    return;
  }

  touch(sid);
  const { containerName } = sessions.get(sid);
  console.log("[/run] connected:", containerName);

  const proc = spawn("docker", [
    "exec", "-i", containerName,
    "script", "-q", "-c", "/sandbox/out_bin", "/dev/null"
  ]);

  proc.stdout.on("data", d => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d.toString());
  });
  proc.stderr.on("data", d => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d.toString());
  });

  ws.on("message", msg => {
    touch(sid);
    try { proc.stdin.write(typeof msg === "string" ? msg : msg.toString()); } catch {}
  });

  proc.on("close", code => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n[Program finished — exit code ${code}]\r\n`);
      setTimeout(() => { try { ws.close(); } catch {} }, 200);
    }
  });

  proc.on("error", err => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n[Error: ${err.message}]\r\n`);
      ws.close();
    }
  });

  ws.on("close", () => {
    try { proc.stdin.end(); proc.kill("SIGTERM"); } catch {}
  });
});
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../frontend", "index.html")));

server.listen(PORT, () => console.log(`[server] Trial and Error running on :${PORT}`));