// سيرفر الموقع + الوكيل (Agent) + جسر البلجن
// التشغيل: ANTHROPIC_API_KEY=sk-ant-... node server.js   (Node 18+، بدون أي مكتبات)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "50", 10); // رسائل لكل مستخدم باليوم
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/* ------------------------------- Firebase ------------------------------- */
// بدون FIREBASE_SERVICE_ACCOUNT يشتغل السيرفر بوضع التطوير: بدون تسجيل دخول ولا تخزين دائم
let admin = null;
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  db = admin.firestore();
  console.log("Firebase: Auth + Firestore enabled");
} else {
  console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT غير مضبوط: وضع التطوير (بدون تسجيل دخول ولا تخزين دائم). لا تنشر بهذا الوضع!");
}
// إعدادات الويب العامة (آمنة للنشر): تُرسل للمتصفح ليسجّل الدخول
const WEB_CONFIG = process.env.FIREBASE_WEB_CONFIG ? JSON.parse(process.env.FIREBASE_WEB_CONFIG) : null;
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
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
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

const newCode = () => crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 خانات مثل 9F3A12BC77

function newSession(code, uid) {
  const s = {
    code,
    uid,
    chatId: null, // المحادثة النشطة حالياً
    title: "",
    roadmap: null, // خريطة الإنجازات للمحادثة النشطة
    devChats: new Map(), // وضع التطوير بدون Firestore
    chatInitP: null,
    messages: [], // المحادثة بصيغة Anthropic (تُحوَّل للمزوّدين الآخرين عند الحاجة)
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

const userCode = new Map(); // uid -> code
const missingCodes = new Map(); // كاش سلبي لأكواد غير موجودة (يمنع قراءات متكررة من Firestore)

/* --------------------------- المحادثات (Chats) ---------------------------
   الجلسة (Session) = اتصال البلجن بحساب المستخدم، كودها ثابت.
   المحادثة (Chat) = سجل + خريطة إنجازات. للمستخدم عدة محادثات والنشطة واحدة.
   Firestore: sessions/{code}/chats/{chatId}  و  .../chats/{chatId}/turns/{ts}   */
const DEFAULT_TITLE = "محادثة جديدة";
const newChatId = () => crypto.randomBytes(6).toString("hex");
const validChatId = (id) => /^[a-f0-9]{12}$/.test(String(id));
const chatsCol = (s) => db.collection("sessions").doc(s.code).collection("chats");

async function loadTurns(s, chatId) {
  const snap = await chatsCol(s).doc(chatId).collection("turns").orderBy("createdAt", "desc").limit(20).get();
  const msgs = [];
  snap.docs.reverse().forEach((d) => {
    try {
      msgs.push(...JSON.parse(d.data().messages));
    } catch {}
  });
  return msgs;
}

async function listChats(s) {
  if (!db)
    return [...s.devChats.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  const snap = await chatsCol(s).orderBy("updatedAt", "desc").limit(40).get();
  return snap.docs.map((d) => ({ id: d.id, title: d.data().title || DEFAULT_TITLE, updatedAt: d.data().updatedAt || 0 }));
}

async function createChat(s) {
  const id = newChatId();
  const now = Date.now();
  s.chatId = id;
  s.title = DEFAULT_TITLE;
  s.messages = [];
  s.roadmap = null;
  if (db) await chatsCol(s).doc(id).set({ title: s.title, createdAt: now, updatedAt: now, roadmap: null });
  else s.devChats.set(id, { id, title: s.title, updatedAt: now, messages: s.messages, roadmap: null });
  return id;
}

async function loadChat(s, id) {
  if (!validChatId(id)) return false;
  if (!db) {
    const c = s.devChats.get(id);
    if (!c) return false;
    s.chatId = id;
    s.title = c.title;
    s.messages = c.messages;
    s.roadmap = c.roadmap;
    return true;
  }
  const doc = await chatsCol(s).doc(id).get();
  if (!doc.exists) return false;
  const d = doc.data();
  s.messages = await loadTurns(s, id);
  s.chatId = id;
  s.title = d.title || DEFAULT_TITLE;
  try {
    s.roadmap = d.roadmap ? JSON.parse(d.roadmap) : null;
  } catch {
    s.roadmap = null;
  }
  return true;
}

// عنوان + وقت التحديث + الخريطة (كتابة واحدة)
async function saveChatMeta(s) {
  const now = Date.now();
  if (!db) {
    const c = s.devChats.get(s.chatId);
    if (c) Object.assign(c, { title: s.title, updatedAt: now, messages: s.messages, roadmap: s.roadmap });
    return;
  }
  try {
    await chatsCol(s).doc(s.chatId).set({ title: s.title, updatedAt: now, roadmap: s.roadmap ? JSON.stringify(s.roadmap) : null }, { merge: true });
  } catch (e) {
    console.error("saveChatMeta failed:", e.message);
  }
}

async function deleteChat(s, id) {
  if (!db) return void s.devChats.delete(id);
  const ref = chatsCol(s).doc(id);
  const turns = await ref.collection("turns").limit(450).get();
  const batch = db.batch();
  turns.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();
}

// نضمن وجود محادثة نشطة: آخر محادثة، أو ننشئ واحدة جديدة
async function ensureActiveChat(s) {
  if (s.chatId) return;
  if (!s.chatInitP) {
    s.chatInitP = (async () => {
      const list = await listChats(s);
      if (!(list.length && (await loadChat(s, list[0].id)))) await createChat(s);
    })().finally(() => {
      s.chatInitP = null;
    });
  }
  await s.chatInitP;
}

const chatState = (s) => ({ chatId: s.chatId, title: s.title, messages: slimMessages(s.messages), roadmap: s.roadmap });

// يرجّع الجلسة من الذاكرة أو يستعيدها من Firestore (مثلاً بعد إعادة تشغيل السيرفر)
async function ensureSession(code) {
  if (!code) return null;
  if (sessions.has(code)) return sessions.get(code);
  if (!db) return null;
  if ((missingCodes.get(code) || 0) > Date.now()) return null;
  const doc = await db.collection("sessions").doc(String(code)).get();
  if (!doc.exists) {
    missingCodes.set(code, Date.now() + 60000);
    return null;
  }
  if (sessions.has(code)) return sessions.get(code); // سبقنا طلب آخر
  return newSession(code, doc.data().uid);
}

// لكل مستخدم جلسة واحدة ثابتة (كودها ثابت، فيحفظه البلجن)
async function getUserSessionBase(user) {
  const uid = user.uid;
  let code = userCode.get(uid);
  if (!code && db) {
    const u = await db.collection("users").doc(uid).get();
    code = u.exists ? u.data().currentCode : null;
  }
  if (code) {
    const s = await ensureSession(code);
    if (s && s.uid === uid) {
      userCode.set(uid, code);
      return s;
    }
  }
  code = newCode();
  const s = newSession(code, uid);
  userCode.set(uid, code);
  if (db) {
    await db.collection("sessions").doc(code).set({ uid, createdAt: Date.now() });
    await db.collection("users").doc(uid).set({ email: user.email || null, currentCode: code, updatedAt: Date.now() }, { merge: true });
  }
  return s;
}

async function getUserSession(user) {
  const s = await getUserSessionBase(user);
  await ensureActiveChat(s);
  return s;
}

/* ----------------------------- المصادقة والحدود ----------------------------- */
async function authenticate(req) {
  if (!admin) return { uid: "dev", email: "dev@local" }; // وضع التطوير
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const fail = (m) => Object.assign(new Error(m), { status: 401 });
  if (!token) throw fail("unauthorized");
  try {
    const d = await admin.auth().verifyIdToken(token);
    return { uid: d.uid, email: d.email || null };
  } catch {
    throw fail("invalid token");
  }
}

const isAdmin = (u) => !!u.email && ADMIN_EMAILS.includes(u.email.toLowerCase());
const today = () => new Date().toISOString().slice(0, 10);

async function getUsage(user) {
  const limit = db && !isAdmin(user) ? DAILY_LIMIT : null; // null = بلا حد
  if (!db) return { used: 0, limit };
  const d = await db.collection("usage").doc(`${user.uid}_${today()}`).get();
  return { used: d.exists ? d.data().count || 0 : 0, limit };
}

async function bumpUsage(user) {
  if (!db) return;
  await db
    .collection("usage")
    .doc(`${user.uid}_${today()}`)
    .set({ uid: user.uid, date: today(), count: admin.firestore.FieldValue.increment(1) }, { merge: true });
}

// EventSource لا يدعم الهيدرز، فنستعمل تذكرة قصيرة العمر بدل وضع التوكن في الرابط
const tickets = new Map();
function makeTicket(uid) {
  const t = crypto.randomBytes(16).toString("hex");
  tickets.set(t, { uid, exp: Date.now() + 6 * 3600 * 1000 });
  return t;
}
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of tickets) if (v.exp < n) tickets.delete(k);
}, 60000).unref();

// حفظ دورة المحادثة (كتابة للدورة + كتابة لبيانات المحادثة: العنوان والخريطة)
async function persistTurn(s, startLen) {
  // عنوان المحادثة = أول رسالة للمستخدم
  if (s.title === DEFAULT_TITLE) {
    const first = s.messages.find((m) => m.role === "user" && typeof m.content === "string");
    if (first) s.title = first.content.replace(/^🎯\s*/, "").replace(/\s+/g, " ").trim().slice(0, 40) || DEFAULT_TITLE;
  }
  if (db) {
    const turn = s.messages.slice(startLen);
    if (turn.length) {
      let payload = JSON.stringify(turn);
      if (Buffer.byteLength(payload) > 900000) {
        // حد وثيقة Firestore = 1MiB: نقصّ نتائج الأدوات الطويلة
        payload = JSON.stringify(
          turn.map((m) =>
            typeof m.content === "string"
              ? m
              : { ...m, content: m.content.map((b) => (b.type === "tool_result" ? { ...b, content: String(b.content).slice(0, 1500) } : b)) }
          )
        );
      }
      if (Buffer.byteLength(payload) > 900000) console.warn("persistTurn: turn too large, skipped");
      else {
        try {
          await chatsCol(s).doc(s.chatId).collection("turns").doc(String(Date.now())).set({ createdAt: Date.now(), messages: payload });
        } catch (e) {
          console.error("persistTurn failed:", e.message);
        }
      }
    }
  }
  await saveChatMeta(s);
}

// نسخة خفيفة من المحادثة لإعادة رسمها في المتصفح
const slimMessages = (msgs) =>
  msgs.map((m) =>
    typeof m.content === "string"
      ? m
      : {
          role: m.role,
          content: m.content.map((b) =>
            b.type === "tool_use"
              ? { type: "tool_use", id: b.id, name: b.name, input: { path: b.input?.path, name: b.input?.name, className: b.input?.className } }
              : b.type === "tool_result"
              ? { type: "tool_result", tool_use_id: b.tool_use_id, is_error: !!b.is_error }
              : b
          ),
        }
  );

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
  {
    name: "set_roadmap",
    description:
      "Create the developer's achievements roadmap (a visual map of milestones). Call it ONCE when the roadmap is 'none' and the developer describes the game/world they want. 6-12 concrete milestones in build order. This replaces any existing roadmap.",
    input_schema: {
      type: "object",
      properties: {
        goal: str("One sentence summarizing the game/world the developer wants"),
        milestones: {
          type: "array",
          description: "Ordered milestones",
          items: {
            type: "object",
            properties: {
              id: str("Short unique id like m1, m2"),
              title: str("Short title (max ~6 words)"),
              description: str("What gets built in this milestone, concrete and small enough for one request"),
            },
            required: ["id", "title", "description"],
          },
        },
      },
      required: ["goal", "milestones"],
    },
  },
  {
    name: "add_milestones",
    description: "Append more milestones to the existing roadmap (when the developer asks for more steps or ideas).",
    input_schema: {
      type: "object",
      properties: {
        milestones: {
          type: "array",
          items: {
            type: "object",
            properties: { id: str("Short unique id"), title: str("Short title"), description: str("What gets built") },
            required: ["id", "title", "description"],
          },
        },
      },
      required: ["milestones"],
    },
  },
  {
    name: "update_milestone",
    description: "Update a milestone's status: in_progress when you start it, done when you finished building and verified it.",
    input_schema: {
      type: "object",
      properties: { id: str("Milestone id"), status: { type: "string", enum: ["todo", "in_progress", "done"] } },
      required: ["id", "status"],
    },
  },
];

const SYSTEM = `You are an expert Roblox game-development agent connected live to the developer's Roblox Studio session through tools.
Work like a careful engineer:
- Explore first (get_explorer / get_selection / read_script) before changing anything. Never guess paths.
- Make changes with the tools, in small verified steps. After creating or editing, re-check if something could have gone wrong.
- Scripts go in the right place: server logic in ServerScriptService, client logic in StarterPlayer.StarterPlayerScripts or StarterGui, shared modules in ReplicatedStorage.
- Write clean, modern Luau (task.wait, no deprecated APIs, typed where helpful) and keep Parts Anchored unless physics is needed.
- Paths are dot-separated starting from a service name. Instance names containing dots are not supported.
- Reply in the same language the developer writes in. Keep replies short: say what you did and what to test.

Achievements roadmap (the developer sees it as a visual map next to the chat):
- The current roadmap state is appended below. If it is "none" and the developer describes the game or world they want to make, call set_roadmap FIRST (6-12 milestones in build order, written in the developer's language, e.g. map base, spawn/lobby, core gameplay, UI, progression/data, polish). Do NOT start building from the initial description: after creating the roadmap, tell them in one or two sentences to pick a milestone on the map (or ask you to start).
- If they ask for more steps or ideas, call add_milestones.
- A message starting with 🎯 asks you to execute that milestone: call update_milestone(in_progress), build it fully with the Studio tools, verify it, then call update_milestone(done) and say what to test.
- When you finish work that clearly matches a milestone on your own, mark it done too.`;

const roadmapSummary = (s) =>
  s.roadmap ? { goal: s.roadmap.goal, milestones: s.roadmap.milestones.map(({ id, title, status }) => ({ id, title, status })) } : null;

const systemFor = (s) => SYSTEM + "\n\n[Current roadmap state]\n" + (s.roadmap ? JSON.stringify(roadmapSummary(s)) : "none");

/* ---------------------- محوّلات المزوّدين ----------------------
   نخزّن المحادثة دائماً بصيغة Anthropic (blocks: text / tool_use / tool_result)
   ونحوّلها لصيغة OpenAI عند الحاجة، فيمكن تبديل المزوّد في منتصف المحادثة. */

// --- Claude (Anthropic) ---
async function callAnthropic(p, messages, system) {
  const clean = messages.map((m) =>
    typeof m.content === "string"
      ? m
      : { role: m.role, content: m.content.map(({ extra, ...b }) => b) } // نحذف الحقول الخاصة بمزوّدين آخرين
  );
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: p.model, max_tokens: 8000, system, tools: TOOLS, messages: clean }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Gemini / Groq / DeepSeek (واجهة متوافقة مع OpenAI) ---
function toOpenAIMessages(messages, system) {
  const out = [{ role: "system", content: system }];
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
    if ((spec.type === "object" || spec.type === "array") && typeof args[k] === "string") {
      try {
        args[k] = JSON.parse(args[k]);
      } catch {}
    }
  }
  return args;
}

async function callOpenAICompat(id, p, messages, system) {
  const body = {
    model: p.model,
    messages: toOpenAIMessages(messages, system),
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

async function callModel(providerId, messages, system) {
  const p = PROVIDERS[providerId];
  if (!p || !p.key) throw new Error(`Provider "${providerId}" is not configured on the server`);
  return p.kind === "anthropic" ? callAnthropic(p, messages, system) : callOpenAICompat(providerId, p, messages, system);
}

/* --------------------- أدوات الخريطة (تُنفَّذ على السيرفر) --------------------- */
const SERVER_TOOLS = new Set(["set_roadmap", "add_milestones", "update_milestone"]);
const STATUSES = ["todo", "in_progress", "done"];

function cleanMilestones(list, existing = []) {
  const used = new Set(existing.map((m) => m.id));
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !m.title) continue;
    const fallback = "m" + (existing.length + out.length + 1);
    let id = String(m.id || fallback).replace(/[^\w-]/g, "").slice(0, 30) || fallback;
    while (used.has(id)) id += "x";
    used.add(id);
    out.push({ id, title: String(m.title).slice(0, 120), description: String(m.description || "").slice(0, 600), status: "todo" });
  }
  return out;
}

function runServerTool(s, name, a) {
  a = a || {};
  if (name === "set_roadmap") {
    const ms = cleanMilestones(a.milestones).slice(0, 20);
    if (!ms.length) return { ok: false, error: "milestones is empty" };
    s.roadmap = { goal: String(a.goal || "").slice(0, 300), milestones: ms };
  } else if (name === "add_milestones") {
    if (!s.roadmap) return { ok: false, error: "no roadmap yet, call set_roadmap first" };
    const add = cleanMilestones(a.milestones, s.roadmap.milestones).slice(0, 30 - s.roadmap.milestones.length);
    if (!add.length) return { ok: false, error: "nothing to add (empty list or roadmap is full)" };
    s.roadmap.milestones.push(...add);
  } else if (name === "update_milestone") {
    const m = s.roadmap && s.roadmap.milestones.find((x) => x.id === a.id);
    if (!m) return { ok: false, error: "unknown milestone id: " + a.id };
    if (!STATUSES.includes(a.status)) return { ok: false, error: "status must be todo | in_progress | done" };
    m.status = a.status;
  }
  emit(s, { type: "roadmap", roadmap: s.roadmap });
  return { ok: true, roadmap: roadmapSummary(s) };
}

/* ------------------------------ حلقة الوكيل ------------------------------ */
async function runAgent(s, userText, providerId) {
  s.busy = true;
  const startLen = s.messages.length;
  s.messages.push({ role: "user", content: userText });
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callModel(providerId, s.messages, systemFor(s));
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
        const r = SERVER_TOOLS.has(u.name)
          ? runServerTool(s, u.name, u.input)
          : studioConnected(s)
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
    emit(s, { type: "error", text: String(e.message || e) });
  } finally {
    await persistTurn(s, startLen);
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

      // إعدادات عامة للمتصفح (إعدادات Firebase للويب ليست سرية)
      if (req.method === "GET" && url.pathname === "/api/config") {
        return json(res, 200, { firebase: WEB_CONFIG, authRequired: !!admin });
      }

      // إنشاء/استعادة جلسة المستخدم
      if (req.method === "POST" && url.pathname === "/api/session") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        return json(res, 200, { code: s.code, email: user.email, usage: await getUsage(user) });
      }

      // حالة المحادثة النشطة: السجل + خريطة الإنجازات
      if (req.method === "GET" && url.pathname === "/api/history") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        return json(res, 200, chatState(s));
      }

      // قائمة المحادثات السابقة
      if (req.method === "GET" && url.pathname === "/api/chats") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        return json(res, 200, { chats: await listChats(s), active: s.chatId });
      }

      // محادثة جديدة (إن كانت الحالية فارغة نبقيها)
      if (req.method === "POST" && url.pathname === "/api/chats/new") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        if (s.busy) return json(res, 409, { error: "الوكيل مشغول، انتظر حتى ينتهي" });
        if (s.messages.length) await createChat(s);
        return json(res, 200, chatState(s));
      }

      // فتح محادثة سابقة
      if (req.method === "POST" && url.pathname === "/api/chats/select") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        if (s.busy) return json(res, 409, { error: "الوكيل مشغول، انتظر حتى ينتهي" });
        const { id } = await readJson(req);
        if (!(await loadChat(s, String(id)))) return json(res, 404, { error: "chat not found" });
        return json(res, 200, chatState(s));
      }

      // حذف محادثة
      if (req.method === "POST" && url.pathname === "/api/chats/delete") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        if (s.busy) return json(res, 409, { error: "الوكيل مشغول، انتظر حتى ينتهي" });
        const { id } = await readJson(req);
        if (!validChatId(id)) return json(res, 400, { error: "bad id" });
        await deleteChat(s, id);
        if (id === s.chatId) {
          const list = await listChats(s);
          if (!(list.length && (await loadChat(s, list[0].id)))) await createChat(s);
        }
        return json(res, 200, chatState(s));
      }

      // تغيير حالة مرحلة يدوياً (تم / إعادة)
      if (req.method === "POST" && url.pathname === "/api/roadmap/status") {
        const user = await authenticate(req);
        const s = await getUserSession(user);
        const { id, status } = await readJson(req);
        const m = s.roadmap && s.roadmap.milestones.find((x) => x.id === id);
        if (!m) return json(res, 404, { error: "milestone not found" });
        if (!STATUSES.includes(status)) return json(res, 400, { error: "bad status" });
        m.status = status;
        emit(s, { type: "roadmap", roadmap: s.roadmap });
        await saveChatMeta(s);
        return json(res, 200, { ok: true });
      }

      // تذكرة لقناة الأحداث (SSE)
      if (req.method === "GET" && url.pathname === "/api/events-ticket") {
        const user = await authenticate(req);
        return json(res, 200, { ticket: makeTicket(user.uid) });
      }

      // بث الأحداث للمتصفح (SSE)
      if (req.method === "GET" && url.pathname === "/api/events") {
        const t = tickets.get(url.searchParams.get("ticket"));
        if (!t || t.exp < Date.now()) return json(res, 401, { error: "bad ticket" });
        const s = await getUserSession({ uid: t.uid });
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

      if (req.method === "GET" && url.pathname === "/api/providers") {
        const list = availableProviders();
        return json(res, 200, { providers: list, default: list[0]?.id || null });
      }

      // رسالة من المستخدم (أو طلب تنفيذ مرحلة من الخريطة)
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const user = await authenticate(req);
        const { message, provider, milestoneId } = await readJson(req);
        const s = await getUserSession(user);
        if (s.busy) return json(res, 409, { error: "الوكيل مشغول، انتظر حتى ينتهي" });

        let text = String(message || "");
        let milestone = null;
        if (milestoneId) {
          milestone = s.roadmap && s.roadmap.milestones.find((x) => x.id === milestoneId);
          if (!milestone) return json(res, 404, { error: "المرحلة غير موجودة" });
          text = `🎯 نفّذ مرحلة الخريطة: «${milestone.title}» (id: ${milestone.id})\n${milestone.description}`;
        }
        if (!text.trim()) return json(res, 400, { error: "empty" });

        const list = availableProviders();
        const chosen = list.find((p) => p.id === provider) ? provider : list[0]?.id;
        if (!chosen) return json(res, 400, { error: "no AI provider configured on the server" });
        const usage = await getUsage(user);
        if (usage.limit !== null && usage.used >= usage.limit)
          return json(res, 429, { error: `وصلت للحد اليومي (${usage.limit} رسالة). جرّب غداً.` });
        s.busy = true; // نمنع الإرسال المزدوج أثناء الكتابة في Firestore
        try {
          await bumpUsage(user);
        } catch (e) {
          s.busy = false;
          throw e;
        }
        emit(s, { type: "usage", used: usage.used + 1, limit: usage.limit });
        if (milestone) {
          milestone.status = "in_progress";
          emit(s, { type: "roadmap", roadmap: s.roadmap });
        }
        runAgent(s, text, chosen);
        return json(res, 200, { ok: true });
      }

      // البلجن: ينتظر أوامر (long-poll)
      if (req.method === "POST" && url.pathname === "/plugin/poll") {
        const { code } = await readJson(req);
        const s = await ensureSession(String(code || "").toUpperCase());
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
        const s = await ensureSession(String(code || "").toUpperCase());
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
      if (!e.status) console.error(e);
      json(res, e.status || 500, { error: String(e.message || e) });
    }
  })
  .listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
