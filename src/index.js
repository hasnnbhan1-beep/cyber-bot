/* ============================================================
 *  ⚡ ZAIN CYBER BOT v12.0 - PRO DASHBOARD + LOGIN
 *  Login: zeen / zeen
 * ============================================================ */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const http = require('http');
const https = require('https');
const qrcode = require('qrcode');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const PORT = process.env.PORT || 10000;
const SELF_URL = process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com';

// 🔐 Login credentials
const AUTH_USER = process.env.AUTH_USER || 'zeen';
const AUTH_PASS = process.env.AUTH_PASS || 'zeen';
const SESSION_SECRET = process.env.SESSION_SECRET || 'zain-bot-secret-2026';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!GROQ_API_KEY) { console.error('GROQ_API_KEY missing'); process.exit(1); }
if (!PHONE_NUMBER) { console.error('PHONE_NUMBER missing'); process.exit(1); }

const groq = new Groq({ apiKey: GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

// ===== SESSION MGMT =====
const sessions = new Map();
function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { created: Date.now(), expires: Date.now() + SESSION_DURATION });
    return token;
}
function validateSession(token) {
    if (!token) return false;
    const s = sessions.get(token);
    if (!s) return false;
    if (Date.now() > s.expires) { sessions.delete(token); return false; }
    return true;
}
function parseCookies(req) {
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) cookies[k] = v.join('=');
    });
    return cookies;
}
function getSession(req) { return parseCookies(req).zain_session || null; }

// ===== STATE =====
let currentPairCode = null;
let codeTimestamp = 0;
let currentQRDataUrl = null;
let sock = null;
let isConnected = false;
let lastError = '';
let pairingAttempts = 0;
let reconnecting = false;
let codeRenewTimer = null;
const startTime = Date.now();
const MAX_PAIRING = 5;

const metrics = { messages: 0, replies: 0, errors: 0, pings: 0, ai: 0, voiceOut: 0, voiceIn: 0 };
const logs = [];
const messages = [];
const timeline = [];
const userHistory = new Map();
const voiceEnabled = new Map();
const MAX_LOGS = 300;
const MAX_MESSAGES = 200;

function log(msg, type='info') {
    const icons = { info:'ℹ️', ok:'✅', warn:'⚠️', err:'❌', ping:'💓', code:'🔑', msg:'💬', auth:'🔐' };
    console.log(`[${new Date().toISOString()}] ${icons[type]||'•'} ${msg}`);
    logs.push({ t: Date.now(), type, msg });
    if (logs.length > MAX_LOGS) logs.shift();
}
function fmtUptime(s) {
    const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
    if (d>0) return `${d}d ${h}h ${m}m`;
    if (h>0) return `${h}h ${m}m`;
    return `${m}m`;
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function pushMessage(entry) {
    messages.push(entry);
    if (messages.length > MAX_MESSAGES) messages.shift();
    const now = Math.floor(Date.now()/60000)*60000;
    const last = timeline[timeline.length-1];
    if (last && last.t === now) last.c++;
    else timeline.push({ t: now, c: 1 });
    if (timeline.length > 60) timeline.shift();
}
function readBody(req) {
    return new Promise(resolve => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => { try { resolve(JSON.parse(body||'{}')); } catch { resolve({}); } });
    });
}

// ===== TTS/STT/AI =====
async function sendVoice(text, jid, quoted) {
    let fp = null;
    try {
        const t = new MsEdgeTTS();
        await t.setMetadata('ar-EG-SalmaNeural', OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const dir = path.join(__dirname, '..', 'tmp');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const r = await t.toFile(dir, esc(text.substring(0,400)));
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

// ===== LOGIN PAGE =====
function loginPage(error) {
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔐 تسجيل الدخول - Zain Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}
body{
  background:linear-gradient(135deg,#0a0e27 0%,#1a1f3a 50%,#0f172a 100%);
  min-height:100vh;display:flex;align-items:center;justify-content:center;
  padding:20px;direction:rtl;
}
.login-box{
  width:100%;max-width:400px;background:rgba(19,19,31,0.85);
  border:1px solid #1f2937;border-radius:20px;padding:35px 25px;
  backdrop-filter:blur(20px);box-shadow:0 20px 60px rgba(0,0,0,0.5);
  animation:slideIn 0.5s ease;
}
@keyframes slideIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.logo{text-align:center;margin-bottom:25px}
.logo-icon{
  display:inline-flex;align-items:center;justify-content:center;
  width:70px;height:70px;border-radius:20px;
  background:linear-gradient(135deg,#7c3aed,#10b981);
  font-size:36px;margin-bottom:15px;
  box-shadow:0 8px 25px rgba(124,58,237,0.4);
}
.logo h1{
  font-size:24px;font-weight:900;
  background:linear-gradient(90deg,#a78bfa,#10b981);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
}
.logo p{color:#6b7280;font-size:12px;margin-top:5px;letter-spacing:2px}
.field{margin-bottom:15px}
.field label{display:block;color:#9ca3af;font-size:13px;margin-bottom:6px;font-weight:500}
.field input{
  width:100%;background:#0a0a15;border:1.5px solid #374151;
  border-radius:10px;padding:14px;color:#fff;font-size:15px;
  transition:0.2s;font-family:inherit;
}
.field input:focus{outline:none;border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15)}
.btn{
  width:100%;background:linear-gradient(135deg,#7c3aed,#6d28d9);
  color:#fff;padding:15px;border-radius:10px;border:none;
  font-size:16px;font-weight:bold;cursor:pointer;margin-top:10px;
  transition:0.2s;
}
.btn:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(124,58,237,0.4)}
.btn:active{transform:translateY(0)}
.err{
  background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);
  color:#fca5a5;padding:12px;border-radius:8px;font-size:13px;
  margin-bottom:15px;text-align:center;
}
.footer{text-align:center;color:#4b5563;font-size:11px;margin-top:20px}
</style></head><body>
<div class="login-box">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <h1>ZAIN BOT</h1>
    <p>PRO DASHBOARD v12.0</p>
  </div>
  ${error ? `<div class="err">⚠️ ${error}</div>` : ''}
  <form method="POST" action="/login">
    <div class="field">
      <label>👤 اسم المستخدم</label>
      <input type="text" name="username" placeholder="اسم المستخدم" required autocomplete="username" autofocus>
    </div>
    <div class="field">
      <label>🔑 كلمة المرور</label>
      <input type="password" name="password" placeholder="كلمة المرور" required autocomplete="current-password">
    </div>
    <button type="submit" class="btn">🔐 تسجيل الدخول</button>
  </form>
  <div class="footer">© 2026 Zain Cyber Bot - All rights reserved</div>
</div>
</body></html>`;
}

// ===== DASHBOARD HTML =====
function dashboard(page) {
    const pages = { home:'🏠 الرئيسية', qr:'🔑 الربط', chats:'💬 المحادثات', analytics:'📊 التحليلات', logs:'📋 السجلات', settings:'⚙️ الإعدادات' };
    const nav = Object.entries(pages).map(([k,v]) =>
        `<a href="/${k==='home'?'':k}" class="nav ${page===k?'active':''}">${v}</a>`).join('');

    const up = Math.floor((Date.now()-startTime)/1000);
    const badge = isConnected ? '<span class="badge on">✅ متصل</span>' : '<span class="badge off">⏳ ينتظر</span>';

    let content = '';
    if (page === 'home') {
        content = `
<div class="grid4">
  <div class="stat"><div class="n">${fmtUptime(up)}</div><div class="l">التشغيل</div></div>
  <div class="stat"><div class="n">${metrics.messages}</div><div class="l">رسائل</div></div>
  <div class="stat"><div class="n">${metrics.replies}</div><div class="l">ردود</div></div>
  <div class="stat"><div class="n">${metrics.ai}</div><div class="l">AI</div></div>
  <div class="stat"><div class="n">${metrics.voiceOut}</div><div class="l">صوت خارج</div></div>
  <div class="stat"><div class="n">${metrics.voiceIn}</div><div class="l">صوت داخل</div></div>
  <div class="stat"><div class="n">${metrics.pings}</div><div class="l">Ping</div></div>
  <div class="stat"><div class="n">${metrics.errors}</div><div class="l">أخطاء</div></div>
</div>
<div class="card"><h2>ℹ️ معلومات النظام</h2>
<div class="kv"><b>رقم الهاتف:</b><span>${PHONE_NUMBER}</span></div>
<div class="kv"><b>حالة الاتصال:</b><span>${isConnected?'✅ متصل بواتساب':'⏳ غير متصل'}</span></div>
<div class="kv"><b>وقت التشغيل:</b><span>${fmtUptime(up)}</span></div>
<div class="kv"><b>الرابط:</b><span>${SELF_URL}</span></div>
<div class="kv"><b>الإصدار:</b><span>v12.0 PRO</span></div>
</div>`;
    }
    else if (page === 'qr') {
        content = isConnected ? `
<div class="card" style="text-align:center">
  <h2>🎉 متصل بنجاح!</h2>
  <p style="margin-top:10px">البوت يعمل الآن على واتساب. أرسل <b>!help</b> للبوت.</p>
</div>` : currentPairCode ? `
<div class="card">
  <h2>🔑 رمز الربط</h2>
  <div class="code-box">
    <div class="code" id="code">${currentPairCode}</div>
    <div class="countdown">⏱️ <span id="timer">${Math.max(0,55-Math.floor((Date.now()-codeTimestamp)/1000))}</span> ثانية</div>
    <div class="progress"><div class="progress-bar" id="bar"></div></div>
  </div>
  <button class="btn big green" onclick="copyCode()">📋 نسخ الرمز</button>
  <button class="btn big" onclick="location.reload()">🔄 تحديث</button>
  <div class="steps">
    <div class="step"><b>1.</b> انسخ الرمز فوق</div>
    <div class="step"><b>2.</b> افتح واتساب ← الإعدادات ⚙️</div>
    <div class="step"><b>3.</b> الأجهزة المرتبطة ← ربط جهاز</div>
    <div class="step"><b>4.</b> اختر <b style="color:#10b981">"الربط برقم الهاتف"</b></div>
    <div class="step"><b>5.</b> الصق الرمز ← ربط</div>
  </div>
</div>
${currentQRDataUrl ? `
<div class="card">
  <h2>📱 QR Code (بديل)</h2>
  <img src="${currentQRDataUrl}" style="background:#fff;padding:15px;border-radius:12px;display:block;margin:10px auto;max-width:250px;width:100%">
</div>` : ''}` : `
<div class="card" style="text-align:center">
  <div class="spinner"></div>
  <h2>⏳ جاري التجهيز...</h2>
  <p style="margin-top:10px;color:#9ca3af">انتظر 10-15 ثانية ثم حدّث الصفحة</p>
  <button class="btn big" onclick="location.reload()" style="margin-top:15px">🔄 تحديث</button>
</div>`;
    }
    else if (page === 'chats') {
        const list = messages.slice(-50).reverse().map(m => `
<div class="msg ${m.dir}">
  <div class="msg-head"><b>${esc(m.from)}</b> <span class="time">${new Date(m.t).toLocaleTimeString('ar-EG')}</span></div>
  <div class="msg-body">${esc(m.text)}</div>
</div>`).join('') || '<p style="text-align:center;color:#6b7280;padding:30px">لا توجد رسائل بعد</p>';

        content = `
<div class="card">
  <h2>📤 إرسال رسالة</h2>
  <input id="sendTo" class="input" placeholder="رقم المستلم (مثال: 9639XXXXXXXXXX)" />
  <textarea id="sendText" class="input" rows="3" placeholder="نص الرسالة..."></textarea>
  <button class="btn big green" onclick="sendMsg()">📨 إرسال</button>
  <div id="sendResult" style="margin-top:8px;font-size:13px"></div>
</div>
<div class="card">
  <h2>💬 آخر الرسائل (${messages.length})</h2>
  <div class="msgs">${list}</div>
</div>`;
    }
    else if (page === 'analytics') {
        content = `
<div class="card">
  <h2>📊 الرسائل خلال آخر ساعة</h2>
  <canvas id="chart1" height="120"></canvas>
</div>
<div class="card">
  <h2>📈 إحصائيات سريعة</h2>
  <div class="grid3">
    <div class="stat"><div class="n">${metrics.messages}</div><div class="l">إجمالي</div></div>
    <div class="stat"><div class="n">${metrics.replies}</div><div class="l">ردود</div></div>
    <div class="stat"><div class="n">${metrics.ai}</div><div class="l">AI</div></div>
  </div>
</div>`;
    }
    else if (page === 'logs') {
        const list = logs.slice(-100).reverse().map(l => {
            const colors = { info:'#9ca3af', ok:'#10b981', warn:'#fbbf24', err:'#ef4444', ping:'#a78bfa', code:'#10b981', msg:'#60a5fa', auth:'#ec4899' };
            return `<div class="log" style="border-color:${colors[l.type]||'#374151'}">
              <span class="lt">${new Date(l.t).toLocaleTimeString('ar-EG')}</span>
              <span>${esc(l.msg)}</span>
            </div>`;
        }).join('') || '<p style="text-align:center;color:#6b7280">لا سجلات</p>';
        content = `<div class="card"><h2>📋 آخر ${logs.length} حدث</h2><div class="logbox">${list}</div></div>`;
    }
    else if (page === 'settings') {
        content = `
<div class="card">
  <h2>⚙️ إعدادات النظام</h2>
  <div class="kv"><b>الرقم المسجل:</b><span>${PHONE_NUMBER}</span></div>
  <div class="kv"><b>الحالة:</b><span>${isConnected?'✅ متصل':'⏳ غير متصل'}</span></div>
  <div class="kv"><b>الأوامر المتاحة:</b><span>!ping !status !voice !help !clear</span></div>
</div>
<div class="card">
  <h2>🎛️ أدوات سريعة</h2>
  <button class="btn big" onclick="if(confirm('طلب رمز جديد؟'))location.href='/api/newcode'">🔑 طلب رمز جديد</button>
  <button class="btn big red" onclick="if(confirm('مسح جميع الرسائل والسجلات؟'))fetch('/api/clear',{method:'POST'}).then(()=>location.reload())">🗑️ مسح السجلات</button>
</div>
<div class="card">
  <h2>🔐 الجلسة</h2>
  <p style="color:#9ca3af;font-size:13px;line-height:1.8">أنت مسجل الدخول كـ <b style="color:#10b981">${AUTH_USER}</b></p>
  <a href="/logout" class="btn big red" style="text-decoration:none;display:block;text-align:center;margin-top:10px">🚪 تسجيل الخروج</a>
</div>
<div class="card">
  <h2>ℹ️ عن النظام</h2>
  <p style="line-height:1.8;color:#9ca3af;font-size:13px">
    <b>Zain Cyber Bot v12.0 PRO</b><br>
    بوت واتساب ذكي مدعوم بـ Groq AI (Llama 3.3)<br>
    المميزات: AI Chat • TTS • STT • Keep-Alive 24/7 • Login
  </p>
</div>`;
    }

    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zain Bot - ${pages[page]}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}
body{background:#0a0a15;color:#e5e7eb;min-height:100vh;display:flex;direction:rtl}
.sidebar{width:230px;background:#13131f;border-left:1px solid #1f2937;padding:20px 15px;position:fixed;top:0;right:0;bottom:0;overflow-y:auto}
.logo{font-size:20px;font-weight:900;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:5px}
.sub{font-size:11px;color:#6b7280;margin-bottom:20px}
.nav{display:block;padding:12px 14px;margin:4px 0;border-radius:10px;color:#9ca3af;text-decoration:none;font-size:14px;transition:0.2s}
.nav:hover{background:#1f2937;color:#fff}
.nav.active{background:linear-gradient(90deg,#7c3aed,#10b981);color:#fff;font-weight:bold}
.main{margin-right:230px;padding:25px;flex:1;max-width:1200px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;padding-bottom:15px;border-bottom:1px solid #1f2937}
.topbar h1{font-size:22px;color:#e5e7eb}
.badge{padding:6px 16px;border-radius:20px;font-size:13px;font-weight:bold}
.badge.on{background:#10b981;color:#fff}
.badge.off{background:#ef4444;color:#fff}
.user-tag{font-size:12px;color:#6b7280;margin-top:5px}
.card{background:#13131f;border:1px solid #1f2937;border-radius:16px;padding:20px;margin-bottom:15px}
.card h2{font-size:16px;margin-bottom:15px;color:#a78bfa}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:15px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.stat{background:#13131f;border:1px solid #1f2937;border-radius:12px;padding:15px;text-align:center}
.stat .n{font-size:22px;font-weight:900;color:#10b981}
.stat .l{font-size:11px;color:#9ca3af;margin-top:4px}
.kv{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1f2937;font-size:14px}
.kv:last-child{border:none}
.kv span{color:#a78bfa;font-weight:bold;word-break:break-all}
.code-box{background:#000;border:3px solid #10b981;border-radius:14px;padding:22px;text-align:center;margin:12px 0;box-shadow:0 0 30px rgba(16,185,129,0.5)}
.code{color:#10b981;font-size:38px;font-weight:900;letter-spacing:6px;font-family:'Courier New',monospace;user-select:all}
.countdown{margin-top:10px;font-size:14px;color:#fbbf24;font-weight:bold}
.progress{height:6px;background:#1f2937;border-radius:3px;margin-top:10px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 1s linear;width:100%}
.btn{background:#7c3aed;color:#fff;padding:12px 22px;border-radius:10px;border:none;cursor:pointer;font-weight:bold;font-size:14px;margin:5px 0;transition:0.2s}
.btn:hover{opacity:0.9;transform:translateY(-1px)}
.btn.big{width:100%;padding:14px;font-size:15px}
.btn.green{background:#10b981}
.btn.red{background:#ef4444}
.steps{margin-top:15px}
.step{background:rgba(255,255,255,0.03);padding:10px 12px;border-radius:8px;margin:5px 0;font-size:13px;line-height:1.6}
.input{width:100%;background:#0a0a15;border:1px solid #374151;border-radius:8px;padding:12px;color:#fff;font-size:14px;margin-bottom:10px;font-family:inherit}
.input:focus{outline:none;border-color:#7c3aed}
.msgs{max-height:500px;overflow-y:auto}
.msg{background:#0a0a15;border:1px solid #1f2937;border-radius:10px;padding:12px;margin:8px 0;border-right:3px solid #7c3aed}
.msg.in{border-right-color:#10b981}
.msg.out{border-right-color:#7c3aed}
.msg-head{font-size:12px;color:#9ca3af;margin-bottom:6px;display:flex;justify-content:space-between}
.msg-body{font-size:13px;color:#e5e7eb;line-height:1.6;word-break:break-word}
.logbox{max-height:600px;overflow-y:auto;font-family:'Courier New',monospace;font-size:12px}
.log{padding:8px 10px;border-right:3px solid #374151;background:#0a0a15;border-radius:6px;margin:4px 0;display:flex;gap:10px}
.log .lt{color:#6b7280;font-size:11px;min-width:70px}
.spinner{display:inline-block;width:40px;height:40px;border:4px solid #374151;border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:15px}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:768px){
  .sidebar{width:100%;position:relative;height:auto;border:none;border-bottom:1px solid #1f2937}
  .main{margin-right:0;padding:15px}
  body{flex-direction:column}
  .grid4{grid-template-columns:repeat(2,1fr)}
  .code{font-size:28px}
}
</style></head><body>
<div class="sidebar">
  <div class="logo">⚡ ZAIN BOT</div>
  <div class="sub">v12.0 PRO • ${AUTH_USER}</div>
  ${nav}
  <a href="/logout" class="nav" style="margin-top:20px;color:#ef4444">🚪 خروج</a>
</div>
<div class="main">
  <div class="topbar">
    <h1>${pages[page]}</h1>
    ${badge}
  </div>
  ${content}
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
function copyCode(){
  const c=document.getElementById('code')?.innerText.trim();
  if(!c)return;
  navigator.clipboard.writeText(c).then(()=>alert('✅ تم النسخ: '+c+'\\n\\nافتح واتساب فوراً!')).catch(()=>{
    const t=document.createElement('textarea');t.value=c;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);alert('✅ تم النسخ: '+c);
  });
}
async function sendMsg(){
  const to=document.getElementById('sendTo').value.trim();
  const text=document.getElementById('sendText').value.trim();
  const r=document.getElementById('sendResult');
  if(!to||!text){r.innerHTML='<span style="color:#ef4444">❌ املأ الحقول</span>';return;}
  r.innerHTML='⏳ جاري الإرسال...';
  try{
    const res=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,text})});
    const j=await res.json();
    if(j.ok){r.innerHTML='<span style="color:#10b981">✅ تم الإرسال</span>';document.getElementById('sendText').value='';}
    else r.innerHTML='<span style="color:#ef4444">❌ '+j.error+'</span>';
  }catch(e){r.innerHTML='<span style="color:#ef4444">❌ '+e.message+'</span>';}
}
${page==='qr'&&currentPairCode?`
let r=${Math.max(0,55-Math.floor((Date.now()-codeTimestamp)/1000))};
setInterval(()=>{
  r--;const t=document.getElementById('timer'),b=document.getElementById('bar');
  if(t)t.innerText=Math.max(0,r);
  if(b)b.style.width=Math.max(0,(r/55)*100)+'%';
  if(r<=0)location.reload();
},1000);
setTimeout(()=>location.reload(),56000);`:''}
${page==='analytics'?`
const tl=${JSON.stringify(timeline)};
if(tl.length){
  new Chart(document.getElementById('chart1'),{
    type:'line',
    data:{
      labels:tl.map(x=>new Date(x.t).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'})),
      datasets:[{label:'الرسائل',data:tl.map(x=>x.c),borderColor:'#10b981',backgroundColor:'rgba(16,185,129,0.1)',fill:true,tension:0.4}]
    },
    options:{responsive:true,plugins:{legend:{labels:{color:'#e5e7eb'}}},scales:{x:{ticks:{color:'#9ca3af'}},y:{ticks:{color:'#9ca3af'}}}}
  });
}`:''}
${page==='chats'||page==='home'||page==='logs'?`setTimeout(()=>location.reload(),15000);`:''}
</script>
</body></html>`;
}

// ===== HTTP SERVER =====
http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    try {
        // 🔓 LOGIN ROUTES (public)
        if (url === '/login' && req.method === 'POST') {
            const body = await readBody(req);
            const formData = require('querystring').parse(body.raw || '');
            // Handle both JSON and form
            let username = body.username, password = body.password;
            if (!username) {
                const raw = await new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); });
                const parsed = require('querystring').parse(raw);
                username = parsed.username;
                password = parsed.password;
            }
            if (username === AUTH_USER && password === AUTH_PASS) {
                const token = createSession();
                log(`🔐 Login success: ${username}`, 'auth');
                res.writeHead(302, {
                    'Set-Cookie': `zain_session=${token}; Path=/; Max-Age=${SESSION_DURATION/1000}; HttpOnly; SameSite=Lax`,
                    'Location': '/'
                });
                return res.end();
            }
            log(`🔐 Login failed: ${username}`, 'warn');
            res.writeHead(401, { 'Content-Type':'text/html; charset=utf-8' });
            return res.end(loginPage('اسم المستخدم أو كلمة المرور غير صحيحة'));
        }

        if (url === '/login') {
            res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
            return res.end(loginPage());
        }

        if (url === '/logout') {
            const token = getSession(req);
            if (token) sessions.delete(token);
            log('🔐 Logout', 'auth');
            res.writeHead(302, { 'Set-Cookie':'zain_session=; Path=/; Max-Age=0', 'Location':'/login' });
            return res.end();
        }

        // 🔒 Everything below requires auth
        const token = getSession(req);
        if (!validateSession(token)) {
            // API requests: return JSON
            if (url.startsWith('/api/')) {
                res.writeHead(401, { 'Content-Type':'application/json' });
                return res.end(JSON.stringify({ error:'Unauthorized' }));
            }
            res.writeHead(302, { 'Location':'/login' });
            return res.end();
        }

        // API routes (authenticated)
        if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
                connected: isConnected, pairCode: currentPairCode,
                hasQR: !!currentQRDataUrl, phone: PHONE_NUMBER,
                uptime: Math.floor((Date.now()-startTime)/1000),
                metrics, error: lastError
            }));
        }
        if (url === '/api/messages') {
            res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
            return res.end(JSON.stringify(messages.slice(-100)));
        }
        if (url === '/api/logs') {
            res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
            return res.end(JSON.stringify(logs.slice(-100)));
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
            logs.length = 0; messages.length = 0; timeline.length = 0;
            res.writeHead(200); return res.end('OK');
        }
        if (url === '/api/send' && req.method === 'POST') {
            const body = await readBody(req);
            if (!sock || !isConnected) {
                res.writeHead(200, { 'Content-Type':'application/json' });
                return res.end(JSON.stringify({ ok:false, error:'البوت غير متصل' }));
            }
            try {
                let to = String(body.to||'').replace(/[^0-9]/g,'');
                if (!to) throw new Error('رقم غير صالح');
                const jid = to + '@s.whatsapp.net';
                await sock.sendMessage(jid, { text: body.text });
                pushMessage({ t:Date.now(), from:'أنت → '+to, text:body.text, dir:'out' });
                metrics.replies++;
                res.writeHead(200, { 'Content-Type':'application/json' });
                return res.end(JSON.stringify({ ok:true }));
            } catch(e) {
                res.writeHead(200, { 'Content-Type':'application/json' });
                return res.end(JSON.stringify({ ok:false, error:e.message }));
            }
        }
        if (url === '/health' || url === '/ping') {
            res.writeHead(200); return res.end('OK');
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
}).listen(PORT, () => log('🌐 Dashboard on '+PORT, 'ok'));

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
        log('⏸️ Max attempts, waiting 30s...', 'warn');
        pairingAttempts = 0;
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => requestPairingCode(socket), 30000);
        return;
    }
    pairingAttempts++;
    try {
        log(`🔑 Requesting code (attempt ${pairingAttempts})...`, 'code');
        const code = await socket.requestPairingCode(PHONE_NUMBER);
        currentPairCode = code;
        codeTimestamp = Date.now();
        lastError = '';
        log(`✅ PAIRING CODE: ${code}`, 'code');
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => {
            if (!isConnected && currentPairCode === code) {
                log('🔄 Renewing...', 'warn');
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 53000);
    } catch(err) {
        log(`❌ Pairing failed: ${err.message}`, 'err');
        lastError = `فشل الرمز: ${err.message}`;
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
            const { connection, lastDisconnect, qr } = update;

            if (qr && !currentQRDataUrl) {
                try { currentQRDataUrl = await qrcode.toDataURL(qr, {margin:1, scale:5}); } catch(e){}
            }

            if (connection === 'close') {
                currentPairCode = null; currentQRDataUrl = null; isConnected = false;
                reconnecting = false; pairingAttempts = 0;
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`❌ Disconnected (${code})`, 'err');
                if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 3000);
            } else if (connection === 'open') {
                currentPairCode = null; currentQRDataUrl = null;
                isConnected = true; lastError = ''; reconnecting = false;
                if (codeRenewTimer) clearTimeout(codeRenewTimer);
                log('✅✅✅ BOT CONNECTED! ✅✅✅', 'ok');
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
                log(`📨 ${text.substring(0,50)}`, 'msg');
                pushMessage({ t:Date.now(), from: from.split('@')[0], text, dir:'in' });

                if (text === '!ping') { await sock.sendMessage(from, {text:'🏓 Pong!'}, {quoted:msg}); return; }
                if (text === '!status') {
                    const up = Math.floor((Date.now()-startTime)/1000);
                    await sock.sendMessage(from, {text:`📊 متصل: ${isConnected}\n⏱️ ${fmtUptime(up)}\n💬 ${metrics.messages}`}, {quoted:msg});
                    return;
                }
                if (text === '!voice') {
                    const c = voiceEnabled.get(from)||false;
                    voiceEnabled.set(from, !c);
                    await sock.sendMessage(from, {text:`🎙️ ${!c?'مُفعّل ✅':'مُعطّل ❌'}`}, {quoted:msg});
                    return;
                }
                if (text === '!help') {
                    await sock.sendMessage(from, {text:'🛡️ الأوامر:\n!ping !status !voice !clear'}, {quoted:msg});
                    return;
                }
                if (text === '!clear') { userHistory.delete(from); await sock.sendMessage(from, {text:'🗑️ تم'}, {quoted:msg}); return; }

                const reply = await askAI(text, from);
                if (reply) {
                    await sock.sendMessage(from, {text:reply}, {quoted:msg});
                    metrics.replies++;
                    pushMessage({ t:Date.now(), from:'Bot → '+from.split('@')[0], text:reply, dir:'out' });
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

// ===== BOOT =====
log('🚀 ZAIN BOT v12.0 PRO + LOGIN starting...', 'ok');
log(`🔐 Login: ${AUTH_USER} / ${AUTH_PASS === 'zeen' ? 'zeen' : '***'}`, 'auth');
startBot();

process.on('uncaughtException', e => log('Uncaught: '+e.message, 'err'));
process.on('unhandledRejection', e => log('Unhandled: '+e.message, 'err'));
