// سيرفر الموقع + الوكيل (Agent) + جسر البلجن
// التشغيل: ANTHROPIC_API_KEY=sk-ant-... node server.js   (Node 18+، بدون أي مكتبات)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_STEPS = 20; // أقصى عدد خطوات لكل رسالة
const TOOL_RESULT_LIMIT = 15000; // أقصى طول لنتيجة أداة تُرسل للنموذج

/* ------------------------------ المزوّدون ------------------------------ */
// يظهر في الواجهة فقط المزوّد الذي ضبطت له مفتاح API في متغيرات البيئة.
// يمكنك تغيير اسم أي نموذج من متغيرات البيئة (راجع لوحة كل مزوّد للأسماء الحالية).
const PROVIDERS = {
  claude: {
    label: "Claude",
    kind: "anthropic",
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || process.env.MODEL || "claude-sonnet-5-5",
  },
  gemini: {
    label: "Gemini",
    kind: "openai",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
  groq: {
    label: "Groq",
    kind: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    url: "https://api.deepseek.com/chat/completions",
    key: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  },
};

const availableProviders = () =>
  Object.entries(PROVIDERS)
    .filter(([, p]) => p.key)
    .map(([id, p]) => ({ id, label: p.label, model: p.model }));

if (!availableProviders().length)
  console.warn("⚠️  لا يوجد أي مفتاح API: ضبط واحداً على الأقل من ANTHROPIC_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / DEEPSEEK_API_KEY");
else console.log("Providers:", availableProviders().map((p) => `${p.id} (${p.model})`).join(", "));

/* ----------------------------- الجلسات ----------------------------- */
// كل جلسة = كود اتصال يربط صفحة الويب ببلجن واحد في Studio
const sessions = new Map();

function createSession(wantedCode) {
  if (wantedCode && sessions.has(wantedCode)) return sessions.get(wantedCode);
  const code = crypto.randomBytes(4).toString("hex").toUpperCase(); // مثل 9F3A12BC
  const s = {
    code,
    messages: [],
    clients: new Set(), // اتصالات SSE من المتصفح
    queue: [], // أوامر بانتظار البلجن
    pending: new Map(), // id -> resolve
    waiter: null, // طلب poll معلّق من البلجن
    lastSeen: 0,
    busy: false,
  };
  sessions.set(code, s);
  return s;
}

const studioConnected = (s) => Date.now() - s.lastSeen < 25000;

function emit(s, ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const r of s.clients) r.write(data);
}

/* ------------------------- جسر البلجن (long-poll) ------------------------- */
function flush(s) {
  if (s.waiter && s.queue.length) {
    const w = s.waiter;
    s.waiter = null;
    clearTimeout(w.timer);
    w.res.end(JSON.stringify({ commands: s.queue.splice(0) }));
  }
}

function callStudio(s, tool, args) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      s.pending.delete(id);
      resolve({ ok: false, error: "Timeout: Studio did not respond in 30s" });
    }, 30000);
    s.pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    s.queue.push({ id, tool, args });
    flush(s);
  });
}

/* ------------------------------ أدوات Claude ------------------------------ */
const str = (d) => ({ type: "string", description: d });
const TOOLS = [
  {
    name: "get_explorer",
    description:
      "Return the instance tree (name, class) under a path. Use this first to understand the game structure. Path like 'Workspace' or 'ServerScriptService'.",
    input_schema: {
      type: "object",
      properties: {
        path: str("Dot path, e.g. Workspace.Map"),
        depth: { type: "integer", description: "How many levels to expand (default 2, max 6)" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_selection",
    description: "Return the instances the developer currently has selected in Studio.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_script",
    description: "Read the source code of a Script/LocalScript/ModuleScript.",
    input_schema: { type: "object", properties: { path: str("Dot path to the script") }, required: ["path"] },
  },
  {
    name: "get_properties",
    description: "Read property values of an instance.",
    input_schema: {
      type: "object",
      properties: {
        path: str("Dot path"),
        properties: { type: "array", items: { type: "string" }, description: "Property names, e.g. ['Position','Size','Color']" },
      },
      required: ["path", "properties"],
    },
  },
  {
    name: "create_instance",
    description:
      "Create an instance. Vector3 = [x,y,z]; Color3 = [r,g,b] 0-255; Vector2 = [x,y]; UDim2 = [xScale,xOffset,yScale,yOffset]; enums by name string (e.g. Material:'Grass'); Instance refs by dot path. For scripts pass 'source'.",
    input_schema: {
      type: "object",
      properties: {
        className: str("e.g. Part, Model, Folder, Script, LocalScript, ModuleScript, ScreenGui, TextButton"),
        name: str("Instance name"),
        parent: str("Dot path of the parent, e.g. Workspace"),
        properties: { type: "object", description: "Property name -> value" },
        source: str("Luau source if the class is a script"),
      },
      required: ["className", "parent"],
    },
  },
  {
    name: "set_properties",
    description: "Set properties on an existing instance (same value format as create_instance).",
    input_schema: {
      type: "object",
      properties: { path: str("Dot path"), properties: { type: "object" } },
      required: ["path", "properties"],
    },
  },
  {
    name: "set_script_source",
    description: "Replace the entire source of an existing script. Read it first and keep what should stay.",
    input_schema: {
      type: "object",
      properties: { path: str("Dot path to the script"), source: str("Full new Luau source") },
      required: ["path", "source"],
    },
  },
  {
    name: "delete_instance",
    description: "Delete an instance. Only when the developer asked for it.",
    input_schema: { type: "object", properties: { path: str("Dot path") }, required: ["path"] },
  },
];

const SYSTEM = `You are an expert Roblox game-development agent connected live to the developer's Roblox Studio session through tools.
Work like a careful engineer:
- Explore first (get_explorer / get_selection / read_script) before changing anything. Never guess paths.
- Make changes with the tools, in small verified steps. After creating or editing, re-check if something could have gone wrong.
- Scripts go in the right place: server logic in ServerScriptService, client logic in StarterPlayer.StarterPlayerScripts or StarterGui, shared modules in ReplicatedStorage.
- Write clean, modern Luau (task.wait, no deprecated APIs, typed where helpful) and keep Parts Anchored unless physics is needed.
- Paths are dot-separated starting from a service name. Instance names containing dots are not supported.
- Reply in the same language the developer writes in. Keep replies short: say what you did and what to test.`;

/* ---------------------- محوّلات المزوّدين ----------------------
   نخزّن المحادثة دائماً بصيغة Anthropic (blocks: text / tool_use / tool_result)
   ونحوّلها لصيغة OpenAI عند الحاجة، فيمكن تبديل المزوّد في منتصف المحادثة. */

// --- Claude (Anthropic) ---
async function callAnthropic(p, messages) {
  const clean = messages.map((m) =>
    typeof m.content === "string"
      ? m
      : { role: m.role, content: m.content.map(({ extra, ...b }) => b) } // نحذف الحقول الخاصة بمزوّدين آخرين
  );
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: p.model, max_tokens: 8000, system: SYSTEM, tools: TOOLS, messages: clean }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Gemini / Groq / DeepSeek (واجهة متوافقة مع OpenAI) ---
function toOpenAIMessages(messages) {
  const out = [{ role: "system", content: SYSTEM }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          ...(b.extra ? { extra_content: b.extra } : {}), // Gemini 3: thought signatures
        }));
      const msg = { role: "assistant", content: text };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

// Gemini لا يقبل كائنات (object) بدون properties، فنحوّلها لنص JSON ونفكّه عند الاستقبال
function geminiSafe(schema) {
  const s = JSON.parse(JSON.stringify(schema));
  const walk = (node) => {
    if (!node || typeof node !== "object" || !node.properties) return;
    for (const [k, v] of Object.entries(node.properties)) {
      if (v.type === "object" && !v.properties) {
        node.properties[k] = { type: "string", description: (v.description || "") + " (JSON-encoded object, as a string)" };
      } else walk(v);
    }
  };
  walk(s);
  return s;
}

function toOpenAITool(t, isGemini) {
  const hasProps = t.input_schema.properties && Object.keys(t.input_schema.properties).length;
  const fn = { name: t.name, description: t.description };
  if (hasProps) fn.parameters = isGemini ? geminiSafe(t.input_schema) : t.input_schema;
  else if (!isGemini) fn.parameters = { type: "object", properties: {} };
  return { type: "function", function: fn };
}

// بعض النماذج ترسل الكائنات كنص JSON؛ نفكّها حسب مخطط الأداة
function fixArgs(toolName, args) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool || !args || typeof args !== "object") return args || {};
  for (const [k, spec] of Object.entries(tool.input_schema.properties || {})) {
    if (spec.type === "object" && typeof args[k] === "string") {
      try {
        args[k] = JSON.parse(args[k]);
      } catch {}
    }
  }
  return args;
}

async function callOpenAICompat(id, p, messages) {
  const body = {
    model: p.model,
    messages: toOpenAIMessages(messages),
    tools: TOOLS.map((t) => toOpenAITool(t, id === "gemini")),
    tool_choice: "auto",
    max_tokens: 8000,
  };
  const res = await fetch(p.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${p.label} API ${res.status}: ${(await res.text()).slice(0, 800)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error(`${p.label}: empty response`);

  // نحوّل الرد إلى صيغة Anthropic ليبقى باقي الكود موحّداً
  const content = [];
  if (msg.content && String(msg.content).trim()) content.push({ type: "text", text: String(msg.content) });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {}
    const block = {
      type: "tool_use",
      id: tc.id || "call_" + crypto.randomBytes(6).toString("hex"),
      name: tc.function?.name,
      input: fixArgs(tc.function?.name, input),
    };
    if (tc.extra_content) block.extra = tc.extra_content;
    content.push(block);
  }
  return { content };
}

async function callModel(providerId, messages) {
  const p = PROVIDERS[providerId];
  if (!p || !p.key) throw new Error(`Provider "${providerId}" is not configured on the server`);
  return p.kind === "anthropic" ? callAnthropic(p, messages) : callOpenAICompat(providerId, p, messages);
}

/* ------------------------------ حلقة الوكيل ------------------------------ */
async function runAgent(s, userText, providerId) {
  s.busy = true;
  s.messages.push({ role: "user", content: userText });
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callModel(providerId, s.messages);
      if (!data.content || !data.content.length) {
        emit(s, { type: "error", text: `${PROVIDERS[providerId].label} رجّع رداً فارغاً، جرّب إعادة الطلب أو غيّر النموذج.` });
        break;
      }
      s.messages.push({ role: "assistant", content: data.content });

      for (const b of data.content) if (b.type === "text" && b.text.trim()) emit(s, { type: "text", text: b.text });

      const uses = data.content.filter((b) => b.type === "tool_use");
      if (!uses.length) break;

      const results = [];
      for (const u of uses) {
        emit(s, { type: "tool", name: u.name, input: u.input });
        const r = studioConnected(s)
          ? await callStudio(s, u.name, u.input)
          : { ok: false, error: "Studio plugin is not connected. Ask the developer to connect the plugin." };
        emit(s, { type: "tool_result", name: u.name, ok: !!r.ok, error: r.error });
        results.push({
          type: "tool_result",
          tool_use_id: u.id,
          content: JSON.stringify(r).slice(0, TOOL_RESULT_LIMIT),
          is_error: !r.ok,
        });
      }
      s.messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error(e);
    // نحذف آخر رسالة إن كانت بلا رد حتى لا تفسد المحادثة
    emit(s, { type: "error", text: String(e.message || e) });
  } finally {
    s.busy = false;
    emit(s, { type: "done" });
  }
}

/* --------------------------------- HTTP --------------------------------- */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 5_000_000) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      // صفحة الويب
      if (req.method === "GET" && url.pathname === "/") {
        const candidates = [
          path.join(__dirname, "public", "index.html"),
          path.join(__dirname, "index.html"),
        ];
        const file = candidates.find((f) => fs.existsSync(f));
        if (!file) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          return res.end("index.html not found. Put it in public/index.html next to server.js.");
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(fs.readFileSync(file));
      }

      // إنشاء/استعادة جلسة
      if (req.method === "POST" && url.pathname === "/api/session") {
        const { code } = await readJson(req);
        return json(res, 200, { code: createSession(code).code });
      }

      // بث الأحداث للمتصفح (SSE)
      if (req.method === "GET" && url.pathname === "/api/events") {
        const s = sessions.get(url.searchParams.get("code"));
        if (!s) return json(res, 404, { error: "unknown session" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        s.clients.add(res);
        const tick = () => res.write(`data: ${JSON.stringify({ type: "status", connected: studioConnected(s) })}\n\n`);
        tick();
        const iv = setInterval(tick, 3000);
        req.on("close", () => {
          clearInterval(iv);
          s.clients.delete(res);
        });
        return;
      }

      // رسالة من المستخدم
      if (req.method === "GET" && url.pathname === "/api/providers") {
        const list = availableProviders();
        return json(res, 200, { providers: list, default: list[0]?.id || null });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const { code, message, provider } = await readJson(req);
        const s = sessions.get(code);
        if (!s) return json(res, 404, { error: "unknown session" });
        if (s.busy) return json(res, 409, { error: "agent is busy" });
        if (!message || !String(message).trim()) return json(res, 400, { error: "empty" });
        const list = availableProviders();
        const chosen = list.find((p) => p.id === provider) ? provider : list[0]?.id;
        if (!chosen) return json(res, 400, { error: "no AI provider configured on the server" });
        runAgent(s, String(message), chosen);
        return json(res, 200, { ok: true });
      }

      // البلجن: ينتظر أوامر (long-poll)
      if (req.method === "POST" && url.pathname === "/plugin/poll") {
        const { code } = await readJson(req);
        const s = sessions.get(code);
        if (!s) return json(res, 404, { error: "unknown code" });
        s.lastSeen = Date.now();
        if (s.waiter) {
          clearTimeout(s.waiter.timer);
          s.waiter.res.end('{"commands":[]}');
          s.waiter = null;
        }
        res.setHeader("content-type", "application/json");
        if (s.queue.length) return res.end(JSON.stringify({ commands: s.queue.splice(0) }));
        const timer = setTimeout(() => {
          s.waiter = null;
          s.lastSeen = Date.now();
          res.end('{"commands":[]}');
        }, 12000);
        s.waiter = { res, timer };
        req.on("close", () => {
          if (s.waiter && s.waiter.res === res) {
            clearTimeout(timer);
            s.waiter = null;
          }
        });
        return;
      }

      // البلجن: يرجّع نتيجة أمر
      if (req.method === "POST" && url.pathname === "/plugin/result") {
        const { code, id, result } = await readJson(req);
        const s = sessions.get(code);
        if (!s) return json(res, 404, { error: "unknown code" });
        s.lastSeen = Date.now();
        const resolve = s.pending.get(id);
        if (resolve) {
          s.pending.delete(id);
          resolve(result || { ok: false, error: "empty result" });
        }
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      json(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
