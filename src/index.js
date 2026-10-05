/* ============================================================
 *  ⚡ ZAIN BOT v10.0 - WORKING VERSION (Back to what worked)
 * ============================================================ */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const http = require('http');
const https = require('https');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const PORT = process.env.PORT || 10000;
const SELF_URL = process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com';

if (!GROQ_API_KEY) { console.error('GROQ_API_KEY missing'); process.exit(1); }
if (!PHONE_NUMBER) { console.error('PHONE_NUMBER missing'); process.exit(1); }

const groq = new Groq({ apiKey: GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

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

const metrics = { messages: 0, replies: 0, errors: 0, pings: 0 };
const userHistory = new Map();
const voiceEnabled = new Map();

function log(m, t='info') {
    const i = { info:'ℹ️', ok:'✅', warn:'⚠️', err:'❌', ping:'💓', code:'🔑' };
    console.log(`[${new Date().toISOString()}] ${i[t]||'•'} ${m}`);
}
function fmt(s) { const h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function sendVoiceReply(text, jid, quoted) {
    let fp = null;
    try {
        const t = new MsEdgeTTS();
        await t.setMetadata('ar-EG-SalmaNeural', OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const dir = path.join(__dirname, '..', 'tmp');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const r = await t.toFile(dir, esc(text.substring(0, 400)));
        fp = r.audioFilePath;
        if (fp && fs.existsSync(fp) && sock) {
            await sock.sendMessage(jid, { audio:{url:fp}, mimetype:'audio/ogg; codecs=opus', ptt:true }, { quoted });
        }
    } catch(e) { log('TTS: '+e.message, 'warn'); }
    finally { if (fp && fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e){} }
}

async function stt(msg) {
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
        const reply = r.choices?.[0]?.message?.content || null;
        if (reply) { h.push({ role:'assistant', content:reply }); userHistory.set(uid, h); }
        return reply;
    } catch(e) { log('AI: '+e.message, 'err'); metrics.errors++; return null; }
}

// ===== WEB DASHBOARD =====
http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // 🆕 زر لطلب رمز جديد يدوياً
    if (url === '/new-code') {
        if (sock && !isConnected) {
            if (codeRenewTimer) clearTimeout(codeRenewTimer);
            pairingAttempts = 0;
            currentPairCode = null;
            requestPairingCode(sock);
        }
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
    }

    if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const up = Math.floor((Date.now() - startTime)/1000);
        const codeAge = currentPairCode ? Math.floor((Date.now() - codeTimestamp)/1000) : 0;
        const remaining = currentPairCode ? Math.max(0, 55 - codeAge) : 0;

        res.end(`<!DOCTYPE html><html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zain Bot v10.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh;padding:15px;display:flex;flex-direction:column;align-items:center}
.h{text-align:center;margin-bottom:15px}
.h h1{font-size:22px;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.badge{display:inline-block;padding:6px 16px;border-radius:20px;font-weight:bold;font-size:13px;margin-top:8px}
.on{background:#10b981}.off{background:#ef4444}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:20px;margin:10px 0;width:100%;max-width:480px}
.card h2{font-size:16px;margin-bottom:12px;color:#a78bfa;text-align:center}
.code-box{background:#000;border:3px solid #10b981;border-radius:14px;padding:22px 10px;text-align:center;margin:12px 0;box-shadow:0 0 30px rgba(16,185,129,0.6)}
.code{color:#10b981;font-size:38px;font-weight:900;letter-spacing:6px;font-family:'Courier New',monospace;user-select:all;word-break:break-all}
.countdown{margin-top:10px;font-size:14px;color:#fbbf24;font-weight:bold}
.progress{height:6px;background:#1f2937;border-radius:3px;margin-top:8px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 1s linear}
.copy-btn{background:#10b981;padding:16px;font-size:17px;width:100%;border-radius:10px;border:none;color:#fff;font-weight:bold;cursor:pointer;margin-top:8px}
.copy-btn:active{background:#059669}
.new-btn{display:block;background:#7c3aed;padding:12px;font-size:14px;width:100%;border-radius:10px;border:none;color:#fff;font-weight:bold;cursor:pointer;margin-top:8px;text-align:center;text-decoration:none}
.step{background:rgba(255,255,255,0.03);padding:12px;border-radius:10px;margin:6px 0;font-size:13px;line-height:1.8}
.step b{color:#a78bfa}
.err{background:rgba(127,29,29,0.5);padding:10px;border-radius:8px;font-size:12px;border-left:3px solid #ef4444;margin-top:8px}
.loading{text-align:center;padding:30px;color:#9ca3af}
.spinner{display:inline-block;width:40px;height:40px;border:4px solid #374151;border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:15px}
@keyframes spin{to{transform:rotate(360deg)}}
.tip{background:rgba(16,185,129,0.15);border-right:3px solid #10b981;padding:10px;border-radius:6px;font-size:12px;margin-top:8px;color:#a7f3d0;line-height:1.6}
.stats-bar{text-align:center;font-size:11px;color:#6b7280;margin-top:10px}
</style></head><body>
<div class="h"><h1>⚡ ZAIN BOT v10.0</h1>
<span class="badge ${isConnected?'on':'off'}">${isConnected?'✅ متصل':'⏳ ينتظر الربط'}</span></div>

${isConnected ? `
<div class="card" style="text-align:center">
<h2>🎉 تم الربط بنجاح!</h2>
<p style="margin-top:8px;line-height:1.7;font-size:13px">البوت متصل ويعمل الآن<br>أرسل <b style="color:#10b981">!help</b> للبوت</p>
</div>
` : currentPairCode ? `
<div class="card">
<h2>🔑 رمز الربط (صالح الآن!)</h2>
<div class="code-box">
<div class="code" id="code">${currentPairCode}</div>
<div class="countdown">⏱️ متبقي: <span id="timer">${remaining}</span> ثانية</div>
<div class="progress"><div class="progress-bar" id="bar" style="width:${(remaining/55)*100}%"></div></div>
</div>
<button class="copy-btn" onclick="copyCode()">📋 نسخ الرمز الآن</button>
<a href="/new-code" class="new-btn">🔄 طلب رمز جديد</a>

<div class="tip">⚡ <b>اسرع!</b> الرمز صالح 55 ثانية فقط. انسخه وأدخله فوراً.</div>

<div class="step">
<b>الخطوات:</b><br>
1️⃣ اضغط <b>"نسخ الرمز الآن"</b><br>
2️⃣ افتح <b>واتساب</b> على هذا الجهاز<br>
3️⃣ الإعدادات ⚙️ ← <b>الأجهزة المرتبطة</b><br>
4️⃣ اضغط <b>ربط جهاز</b><br>
5️⃣ اختر <b>"الربط برقم الهاتف"</b><br>
6️⃣ الصق الرمز ← اضغط <b>ربط</b>
</div>
</div>
` : `
<div class="card">
<div class="loading">
<div class="spinner"></div>
<h2 style="color:#a78bfa">⏳ جاري تجهيز الرمز...</h2>
<p style="margin-top:8px;font-size:13px">انتظر 5-15 ثانية</p>
</div>
</div>
`}

${lastError ? `<div class="err">⚠️ ${lastError}</div>` : ''}
<div class="stats-bar">⏱️ ${fmt(up)} | 💬 ${metrics.messages} | 💓 ${metrics.pings}</div>

<script>
function copyCode() {
    const code = document.getElementById('code')?.innerText.trim();
    if (!code) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => {
            alert('✅ تم نسخ الرمز:\\n\\n' + code + '\\n\\n⚡ افتح واتساب فوراً!');
        }).catch(() => fb(code));
    } else { fb(code); }
}
function fb(code) {
    const t = document.createElement('textarea');
    t.value = code; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); alert('✅ تم النسخ: ' + code); } catch(e) { prompt('انسخ يدوياً:', code); }
    document.body.removeChild(t);
}
let r = ${remaining};
setInterval(() => {
    r--;
    const t = document.getElementById('timer'), b = document.getElementById('bar');
    if (t) t.innerText = Math.max(0, r);
    if (b) b.style.width = Math.max(0, (r/55)*100) + '%';
    if (r <= 0 && !${isConnected}) setTimeout(() => location.reload(), 500);
}, 1000);
if (!${isConnected}) setTimeout(() => location.reload(), 56000);
</script>
</body></html>`);
    }
    else if (url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            connected: isConnected,
            pairCode: currentPairCode,
            phone: PHONE_NUMBER,
            uptime: Math.floor((Date.now()-startTime)/1000),
            metrics, error: lastError
        }));
    }
    else if (url === '/health' || url === '/ping') { res.writeHead(200); res.end('OK'); }
    else { res.writeHead(404); res.end('404'); }
}).listen(PORT, () => log(`🌐 Dashboard on ${PORT}`));

// ===== Keep-Alive =====
setInterval(() => {
    https.get(`${SELF_URL}/health?t=${Date.now()}`, r => {
        r.on('data',()=>{}); r.on('end',()=>{ if(r.statusCode===200) metrics.pings++; });
    }).on('error', ()=>{});
}, 25000);
setInterval(() => { http.get(`http://localhost:${PORT}/health`, ()=>{}).on('error', ()=>{}); }, 60000);

// ===== REQUEST PAIRING CODE (النسخة الأصلية الناجحة) =====
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
                log('🔄 Renewing code...', 'warn');
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 53000);
    } catch (err) {
        log(`❌ Pairing failed: ${err.message}`, 'err');
        lastError = `فشل الرمز: ${err.message}`;
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => requestPairingCode(socket), 6000);
    }
}

// ===== BOT START =====
async function startBot() {
    if (reconnecting) return;
    reconnecting = true;
    pairingAttempts = 0;

    try {
        const sessionPath = path.join(__dirname, '..', 'session');

        // 🗑️ حذف الجلسة القديمة
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            log('🗑️ Session cleared', 'warn');
        }

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

        // ⚡ طلب الرمز فوراً (الطريقة التي نجحت سابقاً)
        if (!state.creds.registered) {
            setTimeout(() => requestPairingCode(sock), 3500);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                currentPairCode = null;
                isConnected = false;
                reconnecting = false;
                pairingAttempts = 0;
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`❌ Disconnected (${code})`, 'err');
                if (code !== DisconnectReason.loggedOut) {
                    log('🔄 Reconnect in 3s...', 'warn');
                    setTimeout(startBot, 3000);
                }
            } else if (connection === 'open') {
                currentPairCode = null;
                isConnected = true;
                lastError = '';
                reconnecting = false;
                if (codeRenewTimer) clearTimeout(codeRenewTimer);
                log('✅✅✅ BOT CONNECTED! ✅✅✅', 'ok');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            try {
                const msg = messages[0];
                if (!msg?.message || msg.key.fromMe) return;
                const from = msg.key.remoteJid;
                if (from.endsWith('@g.us')) return;

                metrics.messages++;
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                if (text === '!ping') { await sock.sendMessage(from, { text: '🏓 Pong!' }, { quoted: msg }); return; }
                if (text === '!status') {
                    const up = Math.floor((Date.now() - startTime) / 1000);
                    await sock.sendMessage(from, { text: `📊 متصل: ${isConnected}\n⏱️ ${fmt(up)}` }, { quoted: msg });
                    return;
                }
                if (text === '!voice') {
                    const curr = voiceEnabled.get(from) || false;
                    voiceEnabled.set(from, !curr);
                    await sock.sendMessage(from, { text: `🎙️ ${!curr ? 'مُفعّل ✅' : 'مُعطّل ❌'}` }, { quoted: msg });
                    return;
                }
                if (text === '!help') { await sock.sendMessage(from, { text: '🛡️ الأوامر:\n!ping\n!status\n!voice\n!clear' }, { quoted: msg }); return; }
                if (text === '!clear') { userHistory.delete(from); await sock.sendMessage(from, { text: '🗑️ تم' }, { quoted: msg }); return; }

                if (msg.message.audioMessage) {
                    await sock.sendMessage(from, { text: '🎧 تحليل...' }, { quoted: msg });
                    const t = await stt(msg);
                    if (t) text = t; else { await sock.sendMessage(from, { text: '❌ لم أفهم' }, { quoted: msg }); return; }
                }

                if (!text || !text.trim()) return;
                const reply = await askAI(text, from);
                if (reply) {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                    metrics.replies++;
                    if (voiceEnabled.get(from)) await sendVoiceReply(reply, from, msg);
                }
            } catch (err) { log('Msg: ' + err.message, 'err'); metrics.errors++; }
        });

    } catch (err) {
        lastError = 'Boot: ' + err.message;
        log('❌ ' + err.message, 'err');
        reconnecting = false;
        setTimeout(startBot, 5000);
    }
}

// ===== BOOT =====
log('🚀 ZAIN BOT v10.0 starting...', 'ok');
startBot();

process.on('uncaughtException', (err) => log('Uncaught: ' + err.message, 'err'));
process.on('unhandledRejection', (err) => log('Unhandled: ' + err.message, 'err'));
