/* ============================================================
 *  ⚡ ZAIN BOT v13.0 - ULTRA FAST EDITION
 *  ⚡ Zero CDN | Cached HTML | Instant Response | Login
 * ============================================================ */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const http = require('http');
const https = require('https');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const PORT = process.env.PORT || 10000;
const SELF_URL = process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com';
const AUTH_USER = process.env.AUTH_USER || 'zeen';
const AUTH_PASS = process.env.AUTH_PASS || 'zeen';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

if (!GROQ_API_KEY) { console.error('GROQ_API_KEY missing'); process.exit(1); }
if (!PHONE_NUMBER) { console.error('PHONE_NUMBER missing'); process.exit(1); }

const groq = new Groq({ apiKey: GROQ_API_KEY, timeout: 30000, maxRetries: 2 });

// ===== SESSION =====
const sessions = new Map();
function createSession() {
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, Date.now() + SESSION_DURATION);
    return token;
}
function validateSession(token) {
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp || Date.now() > exp) { sessions.delete(token); return false; }
    return true;
}
function getCookie(req, name) {
    const c = req.headers.cookie || '';
    const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? m[1] : null;
}

// ===== STATE =====
let currentPairCode = null;
let codeTimestamp = 0;
let sock = null;
let isConnected = false;
let lastError = '';
let pairingAttempts = 0;
let reconnecting = false;
let codeRenewTimer = null;
const startTime = Date.now();
const MAX_PAIRING = 5;

const metrics = { messages:0, replies:0, errors:0, pings:0, ai:0, voiceOut:0, voiceIn:0 };
const logs = [];
const messages = [];
const userHistory = new Map();
const voiceEnabled = new Map();

function log(m, t='info') {
    const i = { info:'ℹ️', ok:'✅', warn:'⚠️', err:'❌', ping:'💓', code:'🔑', auth:'🔐' };
    console.log(`[${new Date().toISOString()}] ${i[t]||'•'} ${m}`);
    logs.push({ t: Date.now(), type:t, msg:m });
    if (logs.length > 100) logs.shift();
}
function fmtUptime(s) {
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
    return h>0 ? `${h}h ${m}m` : `${m}m`;
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function pushMsg(e) { messages.push(e); if (messages.length > 100) messages.shift(); }

// ===== TTS/STT/AI =====
async function sendVoice(text, jid, quoted) {
    let fp = null;
    try {
        const t = new MsEdgeTTS();
        await t.setMetadata('ar-EG-SalmaNeural', OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const dir = path.join(__dirname, '..', 'tmp');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const r = await t.toFile(dir, text.substring(0, 400));
        fp = r.audioFilePath;
        if (fp && fs.existsSync(fp) && sock) {
            await sock.sendMessage(jid, { audio:{url:fp}, mimetype:'audio/ogg; codecs=opus', ptt:true }, { quoted });
            metrics.voiceOut++;
        }
    } catch(e) { log('TTS: '+e.message, 'warn'); }
    finally { if (fp && fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e){} }
}

async function transcribe(msg) {
    let fp = null;
    try {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        fp = path.join(__dirname, '..', `t_${Date.now()}.ogg`);
        fs.writeFileSync(fp, buf);
        const FD = require('form-data');
        const f = new FD();
        f.append('file', fs.createReadStream(fp));
        f.append('model', 'whisper-large-v3-turbo');
        f.append('language', 'ar');
        const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method:'POST', headers:{'Authorization':`Bearer ${GROQ_API_KEY}`}, body:f
        });
        const j = await r.json();
        if (j.text) metrics.voiceIn++;
        return j.text || null;
    } catch(e) { log('STT: '+e.message, 'warn'); return null; }
    finally { if (fp && fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e){} }
}

async function askAI(text, uid) {
    try {
        const h = userHistory.get(uid) || [];
        h.push({ role:'user', content:text });
        if (h.length > 16) h.shift();
        const r = await groq.chat.completions.create({
            messages: [
                { role:'system', content:'أنت "زين" - مساعد ذكي. تجيب بالعربية الفصحى مع رموز تعبيرية.' },
                ...h.slice(-8)
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7,
            max_tokens: 2048
        });
        metrics.ai++;
        const reply = r.choices?.[0]?.message?.content || null;
        if (reply) { h.push({ role:'assistant', content:reply }); userHistory.set(uid, h); }
        return reply;
    } catch(e) { log('AI: '+e.message, 'err'); metrics.errors++; return null; }
}

// ===== FAST HTML BUILDERS (No CDN, No External JS) =====
const SHARED_CSS = `*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}
body{background:#0a0a15;color:#e5e7eb;min-height:100vh;display:flex;direction:rtl}
.sidebar{width:210px;background:#13131f;border-left:1px solid #1f2937;padding:15px 12px;position:fixed;top:0;right:0;bottom:0;overflow-y:auto}
.logo{font-size:18px;font-weight:900;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:3px}
.sub{font-size:10px;color:#6b7280;margin-bottom:15px}
.nav{display:block;padding:10px 12px;margin:3px 0;border-radius:8px;color:#9ca3af;text-decoration:none;font-size:13px}
.nav:hover{background:#1f2937;color:#fff}
.nav.active{background:linear-gradient(90deg,#7c3aed,#10b981);color:#fff;font-weight:bold}
.main{margin-right:210px;padding:20px;flex:1}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #1f2937}
.topbar h1{font-size:20px}
.badge{padding:5px 14px;border-radius:20px;font-size:12px;font-weight:bold}
.badge.on{background:#10b981}
.badge.off{background:#ef4444}
.card{background:#13131f;border:1px solid #1f2937;border-radius:14px;padding:18px;margin-bottom:12px}
.card h2{font-size:15px;margin-bottom:12px;color:#a78bfa}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.stat{background:#13131f;border:1px solid #1f2937;border-radius:10px;padding:12px;text-align:center}
.stat .n{font-size:20px;font-weight:900;color:#10b981}
.stat .l{font-size:10px;color:#9ca3af;margin-top:3px}
.kv{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1f2937;font-size:13px}
.kv:last-child{border:none}
.kv span{color:#a78bfa;font-weight:bold;word-break:break-all}
.code-box{background:#000;border:3px solid #10b981;border-radius:14px;padding:20px;text-align:center;margin:10px 0}
.code{color:#10b981;font-size:36px;font-weight:900;letter-spacing:6px;font-family:'Courier New',monospace;user-select:all}
.countdown{margin-top:8px;font-size:13px;color:#fbbf24;font-weight:bold}
.progress{height:5px;background:#1f2937;border-radius:3px;margin-top:8px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 1s linear;width:100%}
.btn{background:#7c3aed;color:#fff;padding:11px 20px;border-radius:9px;border:none;cursor:pointer;font-weight:bold;font-size:13px;margin:4px 0;width:100%}
.btn:hover{opacity:0.9}
.btn.green{background:#10b981}
.btn.red{background:#ef4444}
.steps{margin-top:12px}
.step{background:rgba(255,255,255,0.03);padding:9px 11px;border-radius:7px;margin:4px 0;font-size:12px;line-height:1.6}
.input{width:100%;background:#0a0a15;border:1px solid #374151;border-radius:8px;padding:11px;color:#fff;font-size:13px;margin-bottom:8px;font-family:inherit}
.input:focus{outline:none;border-color:#7c3aed}
.msgs{max-height:450px;overflow-y:auto}
.msg{background:#0a0a15;border:1px solid #1f2937;border-radius:9px;padding:10px;margin:6px 0;border-right:3px solid #7c3aed}
.msg.out{border-right-color:#10b981}
.msg-head{font-size:11px;color:#9ca3af;margin-bottom:4px;display:flex;justify-content:space-between}
.msg-body{font-size:12px;line-height:1.5;word-break:break-word}
.logbox{max-height:500px;overflow-y:auto;font-size:11px}
.log{padding:6px 8px;border-right:3px solid #374151;background:#0a0a15;border-radius:5px;margin:3px 0;display:flex;gap:8px}
.log .lt{color:#6b7280;min-width:60px}
.spinner{display:inline-block;width:35px;height:35px;border:3px solid #374151;border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.bar{height:20px;background:#1f2937;border-radius:4px;margin:3px 0;overflow:hidden;position:relative}
.bar-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#10b981);border-radius:4px;transition:0.3s}
.bar-label{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;color:#fff;font-weight:bold}
@media(max-width:768px){
  .sidebar{width:100%;position:relative;height:auto;border:none;border-bottom:1px solid #1f2937}
  .main{margin-right:0;padding:12px}
  body{flex-direction:column}
  .grid4{grid-template-columns:repeat(2,1fr)}
  .code{font-size:26px;letter-spacing:4px}
}`;

function loginPage(err) {
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔐 تسجيل الدخول</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}
body{background:#0a0a15;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:15px;direction:rtl}
.box{width:100%;max-width:380px;background:#13131f;border:1px solid #1f2937;border-radius:18px;padding:30px 22px;box-shadow:0 15px 50px rgba(0,0,0,0.5)}
.logo{text-align:center;margin-bottom:22px}
.icon{display:inline-flex;align-items:center;justify-content:center;width:60px;height:60px;border-radius:16px;background:linear-gradient(135deg,#7c3aed,#10b981);font-size:30px;margin-bottom:12px}
h1{font-size:22px;font-weight:900;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.p{color:#6b7280;font-size:11px;margin-top:3px;letter-spacing:2px}
label{display:block;color:#9ca3af;font-size:12px;margin-bottom:5px}
input{width:100%;background:#0a0a15;border:1.5px solid #374151;border-radius:9px;padding:12px;color:#fff;font-size:14px;margin-bottom:12px;font-family:inherit}
input:focus{outline:none;border-color:#7c3aed}
button{width:100%;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;padding:13px;border-radius:9px;border:none;font-size:15px;font-weight:bold;cursor:pointer}
button:active{transform:scale(0.98)}
.err{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;padding:10px;border-radius:8px;font-size:12px;margin-bottom:12px;text-align:center}
.f{text-align:center;color:#4b5563;font-size:10px;margin-top:15px}
</style></head><body>
<div class="box">
<div class="logo"><div class="icon">⚡</div><h1>ZAIN BOT</h1><div class="p">PRO v13.0</div></div>
${err?`<div class="err">⚠️ ${err}</div>`:''}
<form method="POST" action="/login">
<label>👤 اسم المستخدم</label>
<input type="text" name="username" required autocomplete="username" autofocus>
<label>🔑 كلمة المرور</label>
<input type="password" name="password" required autocomplete="current-password">
<button type="submit">🔐 دخول</button>
</form>
<div class="f">© 2026 Zain Cyber Bot</div>
</div></body></html>`;
}

function dashboard(page) {
    const pages = { home:'🏠 الرئيسية', qr:'🔑 الربط', chats:'💬 المحادثات', analytics:'📊 التحليلات', logs:'📋 السجلات', settings:'⚙️ الإعدادات' };
    const nav = Object.entries(pages).map(([k,v]) => `<a href="/${k==='home'?'':k}" class="nav ${page===k?'active':''}">${v}</a>`).join('');
    const up = Math.floor((Date.now()-startTime)/1000);
    const badge = isConnected ? '<span class="badge on">✅ متصل</span>' : '<span class="badge off">⏳ ينتظر</span>';
    
    let content = '';
    
    if (page === 'home') {
        content = `<div class="grid4">
<div class="stat"><div class="n">${fmtUptime(up)}</div><div class="l">التشغيل</div></div>
<div class="stat"><div class="n">${metrics.messages}</div><div class="l">رسائل</div></div>
<div class="stat"><div class="n">${metrics.replies}</div><div class="l">ردود</div></div>
<div class="stat"><div class="n">${metrics.ai}</div><div class="l">AI</div></div>
<div class="stat"><div class="n">${metrics.voiceOut}</div><div class="l">صوت خارج</div></div>
<div class="stat"><div class="n">${metrics.voiceIn}</div><div class="l">صوت داخل</div></div>
<div class="stat"><div class="n">${metrics.pings}</div><div class="l">Ping</div></div>
<div class="stat"><div class="n">${metrics.errors}</div><div class="l">أخطاء</div></div>
</div>
<div class="card"><h2>ℹ️ معلومات</h2>
<div class="kv"><b>الرقم:</b><span>${PHONE_NUMBER}</span></div>
<div class="kv"><b>الحالة:</b><span>${isConnected?'✅ متصل':'⏳ غير متصل'}</span></div>
<div class="kv"><b>التشغيل:</b><span>${fmtUptime(up)}</span></div>
<div class="kv"><b>الإصدار:</b><span>v13.0 FAST</span></div>
</div>`;
    }
    else if (page === 'qr') {
        content = isConnected ? `<div class="card" style="text-align:center"><h2>🎉 متصل!</h2><p style="margin-top:10px;font-size:13px">أرسل !help للبوت</p></div>`
        : currentPairCode ? `<div class="card"><h2>🔑 رمز الربط</h2>
<div class="code-box"><div class="code" id="code">${currentPairCode}</div>
<div class="countdown">⏱️ <span id="timer">${Math.max(0,55-Math.floor((Date.now()-codeTimestamp)/1000))}</span>s</div>
<div class="progress"><div class="progress-bar" id="bar"></div></div></div>
<button class="btn green" onclick="copyCode()">📋 نسخ</button>
<button class="btn" onclick="location.reload()">🔄 تحديث</button>
<div class="steps">
<div class="step"><b>1.</b> انسخ الرمز</div>
<div class="step"><b>2.</b> واتساب ← الإعدادات ⚙️</div>
<div class="step"><b>3.</b> الأجهزة المرتبطة ← ربط جهاز</div>
<div class="step"><b>4.</b> اختر "الربط برقم الهاتف"</div>
<div class="step"><b>5.</b> الصق الرمز</div>
</div></div>`
        : `<div class="card" style="text-align:center"><div class="spinner"></div><h2 style="margin-top:12px">⏳ جاري التجهيز</h2><p style="margin-top:8px;font-size:12px;color:#9ca3af">انتظر 10-15 ثانية</p><button class="btn" onclick="location.reload()" style="margin-top:12px">🔄 تحديث</button></div>`;
    }
    else if (page === 'chats') {
        const list = messages.slice(-40).reverse().map(m => `<div class="msg ${m.dir}"><div class="msg-head"><b>${esc(m.from)}</b><span>${new Date(m.t).toLocaleTimeString('ar-EG')}</span></div><div class="msg-body">${esc(m.text)}</div></div>`).join('') || '<p style="text-align:center;color:#6b7280;padding:20px">لا رسائل</p>';
        content = `<div class="card"><h2>📤 إرسال</h2>
<input id="sendTo" class="input" placeholder="رقم المستلم: 9639...">
<textarea id="sendText" class="input" rows="2" placeholder="النص..."></textarea>
<button class="btn green" onclick="sendMsg()">📨 إرسال</button>
<div id="sendResult" style="margin-top:6px;font-size:12px"></div></div>
<div class="card"><h2>💬 الرسائل (${messages.length})</h2><div class="msgs">${list}</div></div>`;
    }
    else if (page === 'analytics') {
        const max = Math.max(1, metrics.messages);
        const bars = [
            { l:'الرسائل', v:metrics.messages, c:'#10b981' },
            { l:'الردود', v:metrics.replies, c:'#7c3aed' },
            { l:'AI', v:metrics.ai, c:'#ec4899' },
            { l:'صوت خارج', v:metrics.voiceOut, c:'#f59e0b' },
            { l:'صوت داخل', v:metrics.voiceIn, c:'#06b6d4' },
            { l:'Ping', v:metrics.pings, c:'#a78bfa' },
            { l:'أخطاء', v:metrics.errors, c:'#ef4444' }
        ].map(b => `<div style="margin:8px 0"><div style="font-size:12px;color:#9ca3af;margin-bottom:4px">${b.l}: ${b.v}</div><div class="bar"><div class="bar-fill" style="width:${(b.v/max)*100}%;background:${b.c}"></div></div></div>`).join('');
        content = `<div class="card"><h2>📊 الإحصائيات</h2>${bars}</div>`;
    }
    else if (page === 'logs') {
        const colors = { info:'#9ca3af', ok:'#10b981', warn:'#fbbf24', err:'#ef4444', ping:'#a78bfa', code:'#10b981', auth:'#ec4899' };
        const list = logs.slice(-80).reverse().map(l => `<div class="log" style="border-color:${colors[l.type]||'#374151'}"><span class="lt">${new Date(l.t).toLocaleTimeString('ar-EG')}</span><span>${esc(l.msg)}</span></div>`).join('') || '<p style="text-align:center;color:#6b7280">لا سجلات</p>';
        content = `<div class="card"><h2>📋 السجلات (${logs.length})</h2><div class="logbox">${list}</div></div>`;
    }
    else if (page === 'settings') {
        content = `<div class="card"><h2>⚙️ الإعدادات</h2>
<div class="kv"><b>الرقم:</b><span>${PHONE_NUMBER}</span></div>
<div class="kv"><b>الحالة:</b><span>${isConnected?'✅':'⏳'}</span></div>
<div class="kv"><b>الأوامر:</b><span>!ping !status !voice !help</span></div>
</div>
<div class="card"><h2>🎛️ أدوات</h2>
<button class="btn" onclick="if(confirm('رمز جديد؟'))location.href='/api/newcode'">🔑 رمز جديد</button>
<button class="btn red" onclick="if(confirm('مسح؟'))fetch('/api/clear',{method:'POST'}).then(()=>location.reload())">🗑️ مسح السجلات</button>
<a href="/logout" class="btn red" style="text-decoration:none;display:block;text-align:center">🚪 خروج</a>
</div>`;
    }
    
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zain Bot - ${pages[page]}</title>
<style>${SHARED_CSS}</style></head><body>
<div class="sidebar">
<div class="logo">⚡ ZAIN BOT</div>
<div class="sub">v13.0 FAST • ${AUTH_USER}</div>
${nav}
<a href="/logout" class="nav" style="margin-top:15px;color:#ef4444">🚪 خروج</a>
</div>
<div class="main">
<div class="topbar"><h1>${pages[page]}</h1>${badge}</div>
${content}
</div>
${page==='qr'&&currentPairCode ? `<script>
function copyCode(){const c=document.getElementById('code').innerText.trim();navigator.clipboard.writeText(c).then(()=>alert('✅ تم النسخ: '+c)).catch(()=>{const t=document.createElement('textarea');t.value=c;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);alert('✅ تم النسخ: '+c);});}
let r=${Math.max(0,55-Math.floor((Date.now()-codeTimestamp)/1000))};
setInterval(()=>{r--;const t=document.getElementById('timer'),b=document.getElementById('bar');if(t)t.innerText=Math.max(0,r);if(b)b.style.width=Math.max(0,(r/55)*100)+'%';if(r<=0)location.reload();},1000);
setTimeout(()=>location.reload(),56000);
</script>` : ''}
${page==='chats' ? `<script>
async function sendMsg(){const to=document.getElementById('sendTo').value.trim();const text=document.getElementById('sendText').value.trim();const r=document.getElementById('sendResult');if(!to||!text){r.innerHTML='<span style="color:#ef4444">❌</span>';return;}r.textContent='⏳...';try{const res=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,text})});const j=await res.json();if(j.ok){r.innerHTML='<span style="color:#10b981">✅ تم</span>';document.getElementById('sendText').value='';}else r.innerHTML='<span style="color:#ef4444">❌ '+j.error+'</span>';}catch(e){r.innerHTML='<span style="color:#ef4444">❌ '+e.message+'</span>';}}
</script>` : ''}
${page==='home'||page==='logs' ? `<script>setTimeout(()=>location.reload(),30000);</script>` : ''}
</body></html>`;
}

// ===== HTTP SERVER =====
const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    
    // ⚡ Health check - responds INSTANTLY (no auth, no HTML)
    if (url === '/health' || url === '/ping') {
        res.writeHead(200, { 'Content-Type':'text/plain', 'Cache-Control':'no-cache' });
        return res.end('OK');
    }
    
    try {
        // Login POST
        if (url === '/login' && req.method === 'POST') {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => {
                try {
                    const parsed = require('querystring').parse(raw);
                    if (parsed.username === AUTH_USER && parsed.password === AUTH_PASS) {
                        const token = createSession();
                        log(`🔐 Login: ${parsed.username}`, 'auth');
                        res.writeHead(302, {
                            'Set-Cookie': `zain_session=${token}; Path=/; Max-Age=${SESSION_DURATION/1000}; HttpOnly; SameSite=Lax`,
                            'Location': '/'
                        });
                        return res.end();
                    }
                    log(`🔐 Login failed`, 'warn');
                    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
                    res.end(loginPage('بيانات خاطئة'));
                } catch(e) {
                    res.writeHead(400); res.end('Bad request');
                }
            });
            return;
        }
        
        if (url === '/login') {
            res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
            return res.end(loginPage());
        }
        
        if (url === '/logout') {
            const t = getCookie(req, 'zain_session');
            if (t) sessions.delete(t);
            res.writeHead(302, { 'Set-Cookie':'zain_session=; Path=/; Max-Age=0', 'Location':'/login' });
            return res.end();
        }
        
        // 🔒 Auth check
        const token = getCookie(req, 'zain_session');
        if (!validateSession(token)) {
            if (url.startsWith('/api/')) {
                res.writeHead(401, { 'Content-Type':'application/json' });
                return res.end('{"error":"Unauthorized"}');
            }
            res.writeHead(302, { 'Location':'/login' });
            return res.end();
        }
        
        // API routes
        if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-cache' });
            return res.end(JSON.stringify({
                connected: isConnected, pairCode: currentPairCode,
                phone: PHONE_NUMBER, uptime: Math.floor((Date.now()-startTime)/1000),
                metrics, error: lastError
            }));
        }
        if (url === '/api/newcode') {
            if (sock && !isConnected) {
                if (codeRenewTimer) clearTimeout(codeRenewTimer);
                pairingAttempts = 0;
                currentPairCode = null;
                requestPairingCode(sock);
            }
            res.writeHead(302, { Location: '/qr' });
            return res.end();
        }
        if (url === '/api/clear' && req.method === 'POST') {
            logs.length = 0; messages.length = 0;
            res.writeHead(200); return res.end('OK');
        }
        if (url === '/api/send' && req.method === 'POST') {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', async () => {
                try {
                    const body = JSON.parse(raw || '{}');
                    if (!sock || !isConnected) {
                        res.writeHead(200, { 'Content-Type':'application/json' });
                        return res.end('{"ok":false,"error":"غير متصل"}');
                    }
                    let to = String(body.to||'').replace(/[^0-9]/g,'');
                    if (!to) throw new Error('رقم غير صالح');
                    await sock.sendMessage(to + '@s.whatsapp.net', { text: body.text });
                    pushMsg({ t:Date.now(), from:'أنت → '+to, text:body.text, dir:'out' });
                    metrics.replies++;
                    res.writeHead(200, { 'Content-Type':'application/json' });
                    res.end('{"ok":true}');
                } catch(e) {
                    res.writeHead(200, { 'Content-Type':'application/json' });
                    res.end(JSON.stringify({ ok:false, error:e.message }));
                }
            });
            return;
        }
        
        // Dashboard pages
        let page = 'home';
        if (url === '/qr') page = 'qr';
        else if (url === '/chats') page = 'chats';
        else if (url === '/analytics') page = 'analytics';
        else if (url === '/logs') page = 'logs';
        else if (url === '/settings') page = 'settings';
        
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
        res.end(dashboard(page));
    } catch(e) {
        log('HTTP: '+e.message, 'err');
        res.writeHead(500); res.end('Error');
    }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, () => log('🌐 Fast server on '+PORT, 'ok'));

// ===== KEEP-ALIVE =====
setInterval(() => {
    https.get(`${SELF_URL}/health?t=${Date.now()}`, r => {
        r.on('data',()=>{}); r.on('end',()=>{ if(r.statusCode===200) metrics.pings++; });
    }).on('error', ()=>{});
}, 25000);
setInterval(() => { http.get(`http://localhost:${PORT}/health`, ()=>{}).on('error', ()=>{}); }, 60000);

// ===== PAIRING =====
async function requestPairingCode(socket) {
    if (isConnected) return;
    if (pairingAttempts >= MAX_PAIRING) {
        pairingAttempts = 0;
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => requestPairingCode(socket), 30000);
        return;
    }
    pairingAttempts++;
    try {
        const code = await socket.requestPairingCode(PHONE_NUMBER);
        currentPairCode = code;
        codeTimestamp = Date.now();
        lastError = '';
        log(`✅ CODE: ${code}`, 'code');
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => {
            if (!isConnected && currentPairCode === code) {
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 53000);
    } catch(err) {
        lastError = 'فشل الرمز: '+err.message;
        log('❌ '+err.message, 'err');
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => requestPairingCode(socket), 6000);
    }
}

// ===== BOT =====
async function startBot() {
    if (reconnecting) return;
    reconnecting = true;
    pairingAttempts = 0;
    
    try {
        const sessionPath = path.join(__dirname, '..', 'session');
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        
        sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 1000,
            maxMsgRetryCount: 3
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        if (!state.creds.registered) {
            setTimeout(() => requestPairingCode(sock), 3500);
        }
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                currentPairCode = null; isConnected = false;
                reconnecting = false; pairingAttempts = 0;
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`❌ DC (${code})`, 'err');
                if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 3000);
            } else if (connection === 'open') {
                currentPairCode = null; isConnected = true;
                lastError = ''; reconnecting = false;
                if (codeRenewTimer) clearTimeout(codeRenewTimer);
                log('✅ CONNECTED!', 'ok');
            }
        });
        
        sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
            if (type !== 'notify') return;
            try {
                const msg = msgs[0];
                if (!msg?.message || msg.key.fromMe) return;
                const from = msg.key.remoteJid;
                if (from.endsWith('@g.us')) return;
                
                metrics.messages++;
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                if (msg.message.audioMessage) {
                    const t = await transcribe(msg);
                    if (t) text = t;
                }
                if (!text || !text.trim()) return;
                
                log(`📨 ${text.substring(0,40)}`, 'msg');
                pushMsg({ t:Date.now(), from: from.split('@')[0], text, dir:'in' });
                
                if (text === '!ping') { await sock.sendMessage(from, {text:'🏓 Pong!'}, {quoted:msg}); return; }
                if (text === '!help') { await sock.sendMessage(from, {text:'🛡️ !ping !status !voice !clear'}, {quoted:msg}); return; }
                if (text === '!voice') {
                    const c = voiceEnabled.get(from)||false;
                    voiceEnabled.set(from, !c);
                    await sock.sendMessage(from, {text:`🎙️ ${!c?'✅':'❌'}`}, {quoted:msg});
                    return;
                }
                if (text === '!clear') { userHistory.delete(from); await sock.sendMessage(from, {text:'🗑️'}, {quoted:msg}); return; }
                if (text === '!status') {
                    await sock.sendMessage(from, {text:`✅ ${isConnected}\n💬 ${metrics.messages}`}, {quoted:msg});
                    return;
                }
                
                const reply = await askAI(text, from);
                if (reply) {
                    await sock.sendMessage(from, {text:reply}, {quoted:msg});
                    metrics.replies++;
                    pushMsg({ t:Date.now(), from:'Bot → '+from.split('@')[0], text:reply, dir:'out' });
                    if (voiceEnabled.get(from)) await sendVoice(reply, from, msg);
                }
            } catch(err) { log('Msg: '+err.message, 'err'); metrics.errors++; }
        });
    } catch(err) {
        lastError = 'Boot: '+err.message;
        log('❌ '+err.message, 'err');
        reconnecting = false;
        setTimeout(startBot, 5000);
    }
}

log('🚀 v13.0 FAST starting...', 'ok');
log(`🔐 ${AUTH_USER} / ${AUTH_PASS}`, 'auth');
startBot();

process.on('uncaughtException', e => log('UE: '+e.message, 'err'));
process.on('unhandledRejection', e => log('UR: '+e.message, 'err'));
