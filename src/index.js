/* ============================================================
 *  ⚡ ZAIN BOT v9.0 - INSTANT VALID PAIRING CODE
 *  ⚡ Code requested AFTER socket ready = always valid
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

const CONFIG = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    PHONE_NUMBER: (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, ''),
    PORT: process.env.PORT || 10000,
    SELF_URL: process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com',
    AI_MODEL: 'llama-3.3-70b-versatile',
    STT_MODEL: 'whisper-large-v3-turbo',
    TTS_VOICE: 'ar-EG-SalmaNeural'
};

const PORT = CONFIG.PORT;
if (!CONFIG.GROQ_API_KEY) { console.error('❌ GROQ_API_KEY missing!'); process.exit(1); }
if (!CONFIG.PHONE_NUMBER) { console.error('❌ PHONE_NUMBER missing!'); process.exit(1); }

const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

let currentPairCode = null;
let currentQRDataUrl = null;
let codeTimestamp = 0;
let sock = null;
let isConnected = false;
let lastError = '';
let reconnecting = false;
let socketReady = false;
let codeRenewTimer = null;
let codeRequestCount = 0;
const startTime = Date.now();

const metrics = { totalMessages: 0, totalReplies: 0, totalErrors: 0, pingsSent: 0, pingsFailed: 0 };
const userHistory = new Map();
const voiceEnabled = new Map();

function log(msg, type = 'info') {
    const icons = { info: 'ℹ️', ok: '✅', warn: '⚠️', err: '❌', ping: '💓', code: '🔑' };
    console.log(`[${new Date().toISOString()}] ${icons[type] || '•'} ${msg}`);
}

function escapeXml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function formatUptime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ===== TTS =====
async function sendVoiceReply(text, jid, quotedMsg) {
    let audioFilePath = null;
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(CONFIG.TTS_VOICE, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const cleanText = escapeXml(text.substring(0, 400));
        const tmpDir = path.join(__dirname, '..', 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const result = await tts.toFile(tmpDir, cleanText);
        audioFilePath = result.audioFilePath;
        if (audioFilePath && fs.existsSync(audioFilePath) && sock) {
            await sock.sendMessage(jid, {
                audio: { url: audioFilePath },
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, { quoted: quotedMsg });
        }
    } catch (err) { log('TTS: ' + err.message, 'warn'); }
    finally { if (audioFilePath && fs.existsSync(audioFilePath)) { try { fs.unlinkSync(audioFilePath); } catch (e) {} } }
}

// ===== STT =====
async function transcribeAudio(msg) {
    let audioPath = null;
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        audioPath = path.join(__dirname, '..', `t_${Date.now()}.ogg`);
        fs.writeFileSync(audioPath, buffer);
        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('file', fs.createReadStream(audioPath));
        formData.append('model', CONFIG.STT_MODEL);
        formData.append('language', 'ar');
        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` },
            body: formData
        });
        const result = await response.json();
        return result.text || null;
    } catch (err) { log('STT: ' + err.message, 'warn'); return null; }
    finally { if (audioPath && fs.existsSync(audioPath)) { try { fs.unlinkSync(audioPath); } catch (e) {} } }
}

// ===== AI =====
async function askAI(userText, userId) {
    try {
        const hist = userHistory.get(userId) || [];
        hist.push({ role: 'user', content: userText });
        if (hist.length > 16) hist.shift();
        userHistory.set(userId, hist);

        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'أنت "زين" - مساعد ذكي متطور. تجيب بالعربية الفصحى مع رموز تعبيرية.' },
                ...hist.slice(-8)
            ],
            model: CONFIG.AI_MODEL,
            temperature: 0.7,
            max_tokens: 2048
        });
        const reply = completion.choices?.[0]?.message?.content || null;
        if (reply) { hist.push({ role: 'assistant', content: reply }); userHistory.set(userId, hist); }
        return reply;
    } catch (err) { log('AI: ' + err.message, 'err'); metrics.totalErrors++; return null; }
}

// ===== REQUEST PAIRING CODE (بعد جاهزية الاتصال فقط) =====
async function requestPairingCode(socket) {
    if (isConnected || !socketReady || !socket) {
        log('⏭️ Skipping code request (socket not ready)', 'warn');
        return;
    }

    codeRequestCount++;

    // إذا تجاوزنا 3 محاولات، ننتظر 30 ثانية قبل إعادة المحاولة
    if (codeRequestCount > 3) {
        log('⏸️ Too many attempts, waiting 30s before retry...', 'warn');
        codeRequestCount = 0;
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => requestPairingCode(socket), 30000);
        return;
    }

    try {
        log(`🔑 Requesting pairing code for ${CONFIG.PHONE_NUMBER} (attempt ${codeRequestCount})...`, 'code');

        const code = await socket.requestPairingCode(CONFIG.PHONE_NUMBER);
        currentPairCode = code;
        codeTimestamp = Date.now();
        lastError = '';
        log(`✅ NEW PAIRING CODE: ${code}`, 'code');

        // تجديد تلقائي بعد 50 ثانية (قبل انتهاء صلاحية الرمز)
        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => {
            if (!isConnected && currentPairCode === code) {
                log('🔄 Renewing code...', 'warn');
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 50000);

    } catch (err) {
        log('❌ Pairing failed: ' + err.message, 'err');
        lastError = 'فشل الرمز: ' + err.message;

        // إعادة المحاولة بعد 8 ثوان
        if (!isConnected) {
            if (codeRenewTimer) clearTimeout(codeRenewTimer);
            codeRenewTimer = setTimeout(() => requestPairingCode(socket), 8000);
        }
    }
}

// ===== WEB DASHBOARD =====
http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        // ⚡ زر يدوي لتوليد رمز جديد
        if (url === '/refresh-code') {
            if (socket && socketReady && !isConnected) {
                if (codeRenewTimer) clearTimeout(codeRenewTimer);
                codeRequestCount = 0;
                currentPairCode = null;
                await requestPairingCode(socket);
            }
            res.writeHead(302, { 'Location': '/' });
            res.end();
            return;
        }

        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const up = Math.floor((Date.now() - startTime) / 1000);
            const codeAge = currentPairCode ? Math.floor((Date.now() - codeTimestamp) / 1000) : 0;
            const codeRemaining = currentPairCode ? Math.max(0, 50 - codeAge) : 0;
            const qrImg = currentQRDataUrl || '';

            res.end(`<!DOCTYPE html>
<html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔑 Zain Bot v9.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh;padding:12px;display:flex;flex-direction:column;align-items:center}
.h{text-align:center;margin-bottom:12px}
.h h1{font-size:20px;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.badge{display:inline-block;padding:5px 14px;border-radius:20px;font-weight:bold;font-size:12px;margin-top:5px}
.online{background:#10b981}.offline{background:#ef4444}.ready{background:#f59e0b}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:16px;margin:8px 0;width:100%;max-width:480px}
.card h2{font-size:15px;margin-bottom:8px;color:#a78bfa;text-align:center}
.code-box{background:#000;border:3px solid #10b981;border-radius:12px;padding:16px 8px;text-align:center;margin:8px 0;box-shadow:0 0 25px rgba(16,185,129,0.6)}
.code{color:#10b981;font-size:36px;font-weight:900;letter-spacing:5px;font-family:'Courier New',monospace;user-select:all;cursor:pointer;word-break:break-all}
.countdown{margin-top:6px;font-size:13px;color:#fbbf24;font-weight:bold}
.progress{height:5px;background:#1f2937;border-radius:3px;margin-top:5px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 1s linear}
.copy-btn{background:#10b981;padding:14px;font-size:16px;width:100%;border-radius:10px;border:none;color:#fff;font-weight:bold;cursor:pointer;margin-top:6px}
.copy-btn:active{background:#059669}
.refresh-btn{background:#7c3aed;padding:10px;font-size:13px;width:100%;border-radius:8px;border:none;color:#fff;font-weight:bold;cursor:pointer;margin-top:6px}
.qr-box{background:#fff;padding:10px;border-radius:10px;display:block;margin:8px auto;max-width:230px;width:100%}
.step{background:rgba(255,255,255,0.03);padding:9px;border-radius:8px;margin:4px 0;font-size:12px;line-height:1.6}
.step b{color:#a78bfa}
.err{background:rgba(127,29,29,0.5);padding:10px;border-radius:8px;font-size:12px;border-left:3px solid #ef4444;margin-top:6px}
.loading{text-align:center;padding:20px;color:#9ca3af}
.spinner{display:inline-block;width:30px;height:30px;border:3px solid #374151;border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.divider{text-align:center;color:#6b7280;font-size:11px;margin:5px 0;font-weight:bold}
.stats-bar{text-align:center;font-size:11px;color:#6b7280;margin-top:8px}
.tip{background:rgba(16,185,129,0.1);border-right:3px solid #10b981;padding:8px;border-radius:6px;font-size:11px;margin-top:6px;color:#a7f3d0}
</style></head><body>
<div class="h"><h1>⚡ ZAIN BOT v9.0</h1>
<span class="badge ${isConnected?'online':socketReady?'ready':'offline'}">${isConnected?'✅ متصل 24/7':socketReady?'🔑 جاهز - خذ الرمز':'⏳ جاري التحضير'}</span></div>

${isConnected ? `
<div class="card" style="text-align:center">
<h2>🎉 تم الربط بنجاح!</h2>
<p style="margin-top:8px;line-height:1.7;font-size:13px">البوت متصل بواتساب<br>أرسل <b style="color:#10b981">!help</b> للبوت</p>
</div>
` : currentPairCode ? `
<div class="card">
<h2>🔑 رمز الربط (جاهز - صالح الآن!)</h2>
<div class="code-box" onclick="copyCode()">
<div class="code" id="code">${currentPairCode}</div>
<div class="countdown">⏱️ <span id="timer">${codeRemaining}</span> ثانية</div>
<div class="progress"><div class="progress-bar" id="bar" style="width:${(codeRemaining/50)*100}%"></div></div>
</div>
<button class="copy-btn" onclick="copyCode()">📋 نسخ الرمز فوراً</button>
<a href="/refresh-code"><button class="refresh-btn">🔄 طلب رمز جديد</button></a>
<div class="tip">⚡ <b>الرمز صالح فقط لمدة 50 ثانية!</b><br>اسرع: انسخه → افتح واتساب → أدخله</div>
<div class="step">
<b>1.</b> اضغط <b>"نسخ الرمز"</b> أعلاه<br>
<b>2.</b> افتح <b>واتساب</b> على هذا الجهاز<br>
<b>3.</b> <b>الإعدادات ⚙️</b> ← <b>الأجهزة المرتبطة</b><br>
<b>4.</b> <b>ربط جهاز</b> ← <b>"الربط برقم الهاتف"</b><br>
<b>5.</b> الصق الرمز ← <b>ربط</b>
</div>
</div>

<div class="divider">↓ أو استخدم QR Code ↓</div>

<div class="card">
<h2>📱 QR Code (بديل)</h2>
${qrImg ? `<img class="qr-box" src="${qrImg}">` : `<div class="loading"><div class="spinner"></div><p>جاري توليد QR...</p></div>`}
</div>
` : `
<div class="card">
<div class="loading">
<div class="spinner"></div>
<h2 style="color:#a78bfa">⏳ جاري تجهيز الرمز...</h2>
<p style="margin-top:6px;font-size:12px">الاتصال بواتساب جارٍ...<br>سيظهر الرمز خلال 10-20 ثانية</p>
<button class="copy-btn" style="margin-top:12px" onclick="location.reload()">🔄 تحديث</button>
</div>
</div>
`}

${lastError ? `<div class="err">⚠️ ${lastError}</div>` : ''}

<div class="stats-bar">⏱️ ${formatUptime(up)} | 💬 ${metrics.totalMessages} | 💓 ${metrics.pingsSent}</div>

<script>
function copyCode() {
    const code = document.getElementById('code')?.innerText.trim();
    if (!code) return;
    // نسخ للـ clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
            alert('✅ تم نسخ الرمز:\\n\\n' + code + '\\n\\n⚡ اسرع! افتح واتساب وأدخله خلال 50 ثانية.');
        }).catch(() => fallbackCopy(code));
    } else {
        fallbackCopy(code);
    }
}
function fallbackCopy(code) {
    const t = document.createElement('textarea');
    t.value = code;
    t.style.position = 'fixed';
    t.style.left = '-9999px';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); alert('✅ تم النسخ: ' + code); }
    catch(e) { prompt('انسخ الرمز يدوياً:', code); }
    document.body.removeChild(t);
}

let remaining = ${codeRemaining};
setInterval(() => {
    remaining--;
    const t = document.getElementById('timer');
    const b = document.getElementById('bar');
    if (t) t.innerText = Math.max(0, remaining);
    if (b) b.style.width = Math.max(0, (remaining/50)*100) + '%';
    if (remaining <= 0 && !${isConnected}) setTimeout(() => location.reload(), 500);
}, 1000);

if (!${isConnected}) setTimeout(() => location.reload(), 50000);
</script>
</body></html>`);
        }
        else if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                connected: isConnected,
                socketReady,
                pairCode: currentPairCode,
                hasQR: !!currentQRDataUrl,
                codeAge: currentPairCode ? Math.floor((Date.now() - codeTimestamp) / 1000) : 0,
                codeAttempts: codeRequestCount,
                phone: CONFIG.PHONE_NUMBER,
                uptime: Math.floor((Date.now() - startTime) / 1000),
                metrics, error: lastError
            }));
        }
        else if (url === '/health' || url === '/ping') { res.writeHead(200); res.end('OK'); }
        else { res.writeHead(404); res.end('404'); }
    } catch (e) { res.writeHead(500); res.end('Error'); }
}).listen(PORT, () => log(`🌐 Dashboard on ${PORT}`, 'ok'));

// ===== KEEP-ALIVE =====
function startSelfPing() {
    const pingOnce = () => {
        https.get(`${CONFIG.SELF_URL}/health?t=${Date.now()}`, (res) => {
            res.on('data', () => {});
            res.on('end', () => { if (res.statusCode === 200) metrics.pingsSent++; else metrics.pingsFailed++; });
        }).on('error', () => { metrics.pingsFailed++; });
    };
    setInterval(pingOnce, 25000);
    setTimeout(pingOnce, 5000);
    log('💓 Self-Ping started', 'ping');
}

function startLocalPing() {
    setInterval(() => {
        http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    }, 60000);
}

// ===== BOT START =====
async function startBot() {
    if (reconnecting) return;
    reconnecting = true;
    socketReady = false;

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
            maxMsgRetryCount: 3,
            qrTimeout: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // 📱 عند وصول QR = الاتصال جاهز → اطلب الرمز الآن
            if (qr && !isConnected && !socketReady) {
                socketReady = true;
                log('✅ Socket ready (QR received) - now requesting code', 'ok');

                try {
                    currentQRDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 5 });
                } catch (e) { log('QR gen: ' + e.message, 'warn'); }

                // ⚡ الآن فقط نطلب رمز الربط
                if (!state.creds.registered) {
                    setTimeout(() => requestPairingCode(sock), 500);
                }
            }

            if (connection === 'close') {
                currentPairCode = null;
                currentQRDataUrl = null;
                isConnected = false;
                socketReady = false;
                reconnecting = false;
                codeRequestCount = 0;
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`❌ Disconnected (${code})`, 'err');
                if (code !== DisconnectReason.loggedOut) {
                    log('🔄 Reconnect in 3s...', 'warn');
                    setTimeout(startBot, 3000);
                }
            } else if (connection === 'open') {
                currentPairCode = null;
                currentQRDataUrl = null;
                isConnected = true;
                lastError = '';
                reconnecting = false;
                socketReady = false;
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

                metrics.totalMessages++;
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                if (text === '!ping') { await sock.sendMessage(from, { text: '🏓 Pong!' }, { quoted: msg }); return; }
                if (text === '!status') {
                    const up = Math.floor((Date.now() - startTime) / 1000);
                    await sock.sendMessage(from, { text: `📊 متصل: ${isConnected}\n⏱️ ${formatUptime(up)}` }, { quoted: msg });
                    return;
                }
                if (text === '!voice') {
                    const curr = voiceEnabled.get(from) || false;
                    voiceEnabled.set(from, !curr);
                    await sock.sendMessage(from, { text: `🎙️ ${!curr ? 'مُفعّل ✅' : 'مُعطّل ❌'}` }, { quoted: msg });
                    return;
                }
                if (text === '!help') { await sock.sendMessage(from, { text: `🛡️ الأوامر:\n!ping\n!status\n!voice\n!clear` }, { quoted: msg }); return; }
                if (text === '!clear') { userHistory.delete(from); await sock.sendMessage(from, { text: '🗑️ تم' }, { quoted: msg }); return; }

                if (msg.message.audioMessage) {
                    await sock.sendMessage(from, { text: '🎧 تحليل...' }, { quoted: msg });
                    const t = await transcribeAudio(msg);
                    if (t) text = t; else { await sock.sendMessage(from, { text: '❌ لم أفهم' }, { quoted: msg }); return; }
                }

                if (!text || !text.trim()) return;
                const reply = await askAI(text, from);
                if (reply) {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                    metrics.totalReplies++;
                    if (voiceEnabled.get(from)) await sendVoiceReply(reply, from, msg);
                }
            } catch (err) { log('Msg: ' + err.message, 'err'); metrics.totalErrors++; }
        });

    } catch (err) {
        lastError = 'Boot: ' + err.message;
        log('❌ ' + err.message, 'err');
        reconnecting = false;
        setTimeout(startBot, 5000);
    }
}

// ===== BOOT =====
log('🚀 ZAIN BOT v9.0 starting...', 'ok');
startSelfPing();
startLocalPing();
startBot();

process.on('uncaughtException', (err) => log('Uncaught: ' + err.message, 'err'));
process.on('unhandledRejection', (err) => log('Unhandled: ' + err.message, 'err'));
