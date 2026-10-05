/* ============================================================
 *  ⚡ ZAIN BOT v8.0 - PAIRING CODE + QR BOTH
 *  ⚡ Fast | Dual Display | Auto-Refresh | 24/7
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
    PHONE_NUMBER: process.env.PHONE_NUMBER || '',
    PORT: process.env.PORT || 10000,
    SELF_URL: process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com',
    AI_MODEL: 'llama-3.3-70b-versatile',
    STT_MODEL: 'whisper-large-v3-turbo',
    TTS_VOICE: 'ar-EG-SalmaNeural',
    PING_INTERVAL: 25000
};

const PORT = CONFIG.PORT;
if (!CONFIG.GROQ_API_KEY) { console.error('❌ GROQ_API_KEY missing!'); process.exit(1); }

const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

let currentPairCode = null;
let currentQRDataUrl = null;
let codeTimestamp = 0;
let sock = null;
let isConnected = false;
let lastError = '';
let reconnecting = false;
let codeRenewTimer = null;
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
        if (reply) {
            hist.push({ role: 'assistant', content: reply });
            userHistory.set(userId, hist);
        }
        return reply;
    } catch (err) { log('AI: ' + err.message, 'err'); metrics.totalErrors++; return null; }
}

// ===== WEB DASHBOARD =====
http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const up = Math.floor((Date.now() - startTime) / 1000);
            const codeAge = currentPairCode ? Math.floor((Date.now() - codeTimestamp) / 1000) : 0;
            const codeRemaining = currentPairCode ? Math.max(0, 55 - codeAge) : 0;
            const qrImg = currentQRDataUrl || '';

            res.end(`<!DOCTYPE html>
<html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔑 Zain Bot v8.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh;padding:15px;display:flex;flex-direction:column;align-items:center}
.h{text-align:center;margin-bottom:15px}
.h h1{font-size:22px;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.badge{display:inline-block;padding:6px 16px;border-radius:20px;font-weight:bold;font-size:13px;margin-top:6px}
.online{background:#10b981}.offline{background:#ef4444}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:18px;margin:10px 0;width:100%;max-width:480px}
.card h2{font-size:16px;margin-bottom:10px;color:#a78bfa;text-align:center}
.code-box{background:#000;border:3px solid #10b981;border-radius:14px;padding:20px 10px;text-align:center;margin:10px 0;box-shadow:0 0 25px rgba(16,185,129,0.5)}
.code{color:#10b981;font-size:34px;font-weight:900;letter-spacing:5px;font-family:'Courier New',monospace;user-select:all;cursor:pointer;word-break:break-all}
.code:hover{color:#34d399}
.countdown{margin-top:8px;font-size:13px;color:#fbbf24;font-weight:bold}
.progress{height:5px;background:#1f2937;border-radius:3px;margin-top:6px;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 1s linear;border-radius:3px}
.copy-btn{background:#10b981;padding:12px;font-size:15px;width:100%;border-radius:10px;border:none;color:#fff;font-weight:bold;cursor:pointer;margin-top:6px}
.copy-btn:active{background:#059669}
.qr-box{background:#fff;padding:12px;border-radius:12px;display:block;margin:10px auto;max-width:250px;width:100%}
.step{background:rgba(255,255,255,0.03);padding:10px;border-radius:8px;margin:5px 0;font-size:13px;line-height:1.6}
.step b{color:#a78bfa}
.err{background:rgba(127,29,29,0.5);padding:10px;border-radius:8px;font-size:12px;border-left:3px solid #ef4444;margin-top:8px}
.loading{text-align:center;padding:25px;color:#9ca3af}
.spinner{display:inline-block;width:35px;height:35px;border:3px solid #374151;border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:10px}
@keyframes spin{to{transform:rotate(360deg)}}
.divider{text-align:center;color:#6b7280;font-size:12px;margin:8px 0;font-weight:bold}
.stats-bar{text-align:center;font-size:11px;color:#6b7280;margin-top:10px;line-height:1.6}
</style></head><body>
<div class="h"><h1>⚡ ZAIN BOT v8.0</h1>
<span class="badge ${isConnected?'online':'offline'}">${isConnected?'✅ متصل 24/7':'⏳ ينتظر الربط'}</span></div>

${isConnected ? `
<div class="card" style="text-align:center">
<h2>🎉 تم الربط بنجاح!</h2>
<p style="margin-top:10px;line-height:1.8;font-size:14px">البوت متصل بواتساب ويعمل الآن<br>أرسل <b style="color:#10b981">!help</b> لأي محادثة</p>
</div>
` : currentPairCode ? `
<div class="card">
<h2>🔑 رمز الربط (الأسرع)</h2>
<div class="code-box" onclick="copyCode()">
<div class="code" id="code">${currentPairCode}</div>
<div class="countdown">⏱️ متبقي: <span id="timer">${codeRemaining}</span> ثانية</div>
<div class="progress"><div class="progress-bar" id="bar" style="width:${(codeRemaining/55)*100}%"></div></div>
</div>
<button class="copy-btn" onclick="copyCode()">📋 نسخ الرمز</button>
<div class="step">
<b>1️⃣</b> واتساب ⚙️ → الأجهزة المرتبطة<br>
<b>2️⃣</b> اضغط "ربط جهاز"<br>
<b>3️⃣</b> اختر <b>"الربط برقم الهاتف"</b><br>
<b>4️⃣</b> الصق الرمز: <b style="color:#10b981">${currentPairCode}</b>
</div>
</div>

<div class="divider">↓ أو استخدم QR ↓</div>

<div class="card">
<h2>📱 QR Code</h2>
${qrImg ? `<img class="qr-box" src="${qrImg}" alt="QR">` : `<div class="loading"><div class="spinner"></div><p>جاري توليد QR...</p></div>`}
<div class="step" style="font-size:12px">
<b>💡 نصيحة:</b> إذا كنت تستخدم هاتفاً واحداً،<br>
التقط <b>screenshot</b> للـ QR ثم افتحه في تطبيق آخر لمسحه.<br>
أو استخدم <b>الرمز أعلاه</b> (أسهل وأسرع).
</div>
</div>
` : `
<div class="card">
<div class="loading">
<div class="spinner"></div>
<h2 style="color:#a78bfa">⏳ جاري التوليد...</h2>
<p style="margin-top:8px;font-size:13px">انتظر 10-15 ثانية</p>
<button class="copy-btn" style="margin-top:15px" onclick="location.reload()">🔄 تحديث</button>
</div>
</div>
`}

${lastError ? `<div class="err">⚠️ ${lastError}</div>` : ''}

<div class="stats-bar">
⏱️ التشغيل: ${formatUptime(up)} | 💬 ${metrics.totalMessages} رسالة | 💓 ${metrics.pingsSent} Ping
</div>

<script>
function copyCode() {
    const code = document.getElementById('code')?.innerText;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
        alert('✅ تم نسخ الرمز:\\n\\n' + code + '\\n\\nافتح واتساب الآن وأدخله!');
    }).catch(() => {
        const t = document.createElement('textarea');
        t.value = code;
        document.body.appendChild(t);
        t.select();
        document.execCommand('copy');
        document.body.removeChild(t);
        alert('✅ تم النسخ: ' + code);
    });
}

let remaining = ${codeRemaining};
setInterval(() => {
    remaining--;
    const t = document.getElementById('timer');
    const b = document.getElementById('bar');
    if (t) t.innerText = Math.max(0, remaining);
    if (b) b.style.width = Math.max(0, (remaining/55)*100) + '%';
    if (remaining <= 0) location.reload();
}, 1000);

setTimeout(() => location.reload(), 55000);
</script>
</body></html>`);
        }
        else if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                connected: isConnected,
                pairCode: currentPairCode,
                hasQR: !!currentQRDataUrl,
                codeAge: currentPairCode ? Math.floor((Date.now() - codeTimestamp) / 1000) : 0,
                phone: CONFIG.PHONE_NUMBER,
                uptime: Math.floor((Date.now() - startTime) / 1000),
                metrics, error: lastError
            }));
        }
        else if (url === '/health' || url === '/ping') {
            res.writeHead(200); res.end('OK');
        }
        else { res.writeHead(404); res.end('404'); }
    } catch (e) { res.writeHead(500); res.end('Error'); }
}).listen(PORT, () => log(`🌐 Dashboard on ${PORT}`, 'ok'));

// ===== KEEP-ALIVE =====
function startSelfPing() {
    log(`💓 Self-Ping every ${CONFIG.PING_INTERVAL/1000}s`, 'ping');
    const pingOnce = () => {
        https.get(`${CONFIG.SELF_URL}/health?t=${Date.now()}`, (res) => {
            res.on('data', () => {});
            res.on('end', () => { if (res.statusCode === 200) metrics.pingsSent++; else metrics.pingsFailed++; });
        }).on('error', () => { metrics.pingsFailed++; });
    };
    setInterval(pingOnce, CONFIG.PING_INTERVAL);
    setTimeout(pingOnce, 5000);
}

function startLocalPing() {
    setInterval(() => {
        http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    }, 60000);
}

// ===== REQUEST PAIRING CODE =====
async function requestPairingCode(socket) {
    if (isConnected || !CONFIG.PHONE_NUMBER) return;

    try {
        const cleanNum = CONFIG.PHONE_NUMBER.replace(/[^0-9]/g, '');
        log(`🔑 Requesting pairing code for ${cleanNum}...`, 'code');
        const code = await socket.requestPairingCode(cleanNum);
        currentPairCode = code;
        codeTimestamp = Date.now();
        lastError = '';
        log(`✅ PAIRING CODE: ${code}`, 'code');

        if (codeRenewTimer) clearTimeout(codeRenewTimer);
        codeRenewTimer = setTimeout(() => {
            if (!isConnected && currentPairCode === code) {
                log('⏰ Code expired, renewing...', 'warn');
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 56000);
    } catch (err) {
        log('Pairing failed: ' + err.message, 'err');
        lastError = 'فشل الرمز: ' + err.message;
        if (!isConnected) setTimeout(() => requestPairingCode(socket), 6000);
    }
}

// ===== BOT START =====
async function startBot() {
    if (reconnecting) return;
    reconnecting = true;
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

        // ⚡ طلب الرمز فوراً
        if (!state.creds.registered && CONFIG.PHONE_NUMBER) {
            setTimeout(() => requestPairingCode(sock), 2500);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // 📱 استقبال QR وتوليد صورة
            if (qr && !isConnected) {
                try {
                    currentQRDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 5 });
                    log('📱 QR generated', 'code');
                } catch (e) { log('QR gen: ' + e.message, 'warn'); }
            }

            if (connection === 'close') {
                currentPairCode = null;
                currentQRDataUrl = null;
                isConnected = false;
                reconnecting = false;
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
                if (text === '!help') {
                    await sock.sendMessage(from, { text: `🛡️ الأوامر:\n!ping\n!status\n!voice\n!clear` }, { quoted: msg });
                    return;
                }
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
log('🚀 ZAIN BOT v8.0 - Pairing + QR starting...', 'ok');
startSelfPing();
startLocalPing();
startBot();

process.on('uncaughtException', (err) => log('Uncaught: ' + err.message, 'err'));
process.on('unhandledRejection', (err) => log('Unhandled: ' + err.message, 'err'));
