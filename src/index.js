/* ============================================================
 *  ⚡ ZAIN CYBER BOT v6.0 SPEED EDITION
 *  ⚡ QR-First  |  Fast Boot  |  24/7 Keep-Alive
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

// ===== CONFIG =====
const CONFIG = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    PHONE_NUMBER: process.env.PHONE_NUMBER || '',
    PORT: process.env.PORT || 10000,
    SELF_URL: process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com',
    AI_MODEL: 'llama-3.3-70b-versatile',
    STT_MODEL: 'whisper-large-v3-turbo',
    TTS_VOICE: 'ar-EG-SalmaNeural',
    MAX_HISTORY: 8,
    PING_INTERVAL: 25000,
    RECONNECT_BASE: 2000
};

const PORT = CONFIG.PORT;
if (!CONFIG.GROQ_API_KEY) { console.error('❌ GROQ_API_KEY missing!'); process.exit(1); }

const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

// ===== STATE =====
let currentQR = null;
let currentQRDataUrl = null;
let currentPairCode = null;
let sock = null;
let isConnected = false;
let lastError = '';
let reconnecting = false;
let reconnectAttempts = 0;
const startTime = Date.now();

const metrics = {
    totalMessages: 0,
    totalReplies: 0,
    totalErrors: 0,
    totalVoiceReplies: 0,
    totalVoiceTranscribed: 0,
    avgResponseTime: 0,
    responseTimes: [],
    pingsSent: 0,
    pingsFailed: 0
};

const userHistory = new Map();
const responseCache = new Map();
const voiceEnabled = new Map();

// ===== UTILS =====
function log(msg, type = 'info') {
    const icons = { info: 'ℹ️', ok: '✅', warn: '⚠️', err: '❌', ping: '💓', qr: '📱' };
    console.log(`[${new Date().toISOString()}] ${icons[type] || '•'} ${msg}`);
}

function escapeXml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function addToHistory(userId, role, content) {
    const hist = userHistory.get(userId) || [];
    hist.push({ role, content });
    if (hist.length > CONFIG.MAX_HISTORY * 2) hist.shift();
    userHistory.set(userId, hist);
    return hist;
}

function getCachedResponse(key) {
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.time < 300000) return cached.response;
    return null;
}

function cacheResponse(key, response) {
    responseCache.set(key, { response, time: Date.now() });
    if (responseCache.size > 300) {
        const oldest = [...responseCache.entries()].sort((a,b) => a[1].time - b[1].time).slice(0, 100);
        oldest.forEach(([k]) => responseCache.delete(k));
    }
}

// ===== TTS (Optimized) =====
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
            metrics.totalVoiceReplies++;
        }
    } catch (err) { log('TTS: ' + err.message, 'warn'); }
    finally { if (audioFilePath && fs.existsSync(audioFilePath)) { try { fs.unlinkSync(audioFilePath); } catch (e) {} } }
}

// ===== STT (Optimized) =====
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
        if (result.text) metrics.totalVoiceTranscribed++;
        return result.text || null;
    } catch (err) { log('STT: ' + err.message, 'warn'); return null; }
    finally { if (audioPath && fs.existsSync(audioPath)) { try { fs.unlinkSync(audioPath); } catch (e) {} } }
}

// ===== AI =====
async function askAI(userText, userId) {
    const t0 = Date.now();
    try {
        const history = addToHistory(userId, 'user', userText);
        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'أنت "زين" - مساعد ذكي متطور. تجيب بالعربية الفصحى مع رموز تعبيرية. خبير في الأمن السيبراني والبرمجة.' },
                ...history.slice(-CONFIG.MAX_HISTORY)
            ],
            model: CONFIG.AI_MODEL,
            temperature: 0.7,
            max_tokens: 2048
        });
        const reply = completion.choices?.[0]?.message?.content || null;
        if (reply) {
            addToHistory(userId, 'assistant', reply);
            const elapsed = Date.now() - t0;
            metrics.responseTimes.push(elapsed);
            if (metrics.responseTimes.length > 50) metrics.responseTimes.shift();
            metrics.avgResponseTime = Math.round(metrics.responseTimes.reduce((a,b)=>a+b,0) / metrics.responseTimes.length);
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

            res.end(`<!DOCTYPE html>
<html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡ Zain Bot v6.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh;padding:15px;display:flex;flex-direction:column;align-items:center}
.h{text-align:center;margin-bottom:15px}
.h h1{font-size:24px;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.badge{display:inline-block;padding:6px 16px;border-radius:20px;font-weight:bold;font-size:13px;margin-top:8px}
.online{background:#10b981}.offline{background:#ef4444}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:18px;margin:10px 0;width:100%;max-width:480px}
.card h2{font-size:17px;margin-bottom:12px;color:#a78bfa}
.code{background:#000;color:#10b981;padding:18px;border-radius:10px;font-size:28px;font-weight:bold;text-align:center;letter-spacing:6px;font-family:monospace;margin:8px 0;cursor:pointer}
.hint{font-size:12px;color:#9ca3af;line-height:1.7;margin-top:8px}
.btn{display:inline-block;background:#7c3aed;color:#fff;padding:10px 20px;border-radius:8px;font-weight:bold;margin:5px 3px;border:none;cursor:pointer;font-size:14px}
.btn-g{background:#10b981}
.btn-r{background:#ef4444}
img.qr{background:#fff;padding:12px;border-radius:12px;display:block;margin:8px auto;max-width:280px;width:100%}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.stat{background:rgba(255,255,255,0.05);padding:10px;border-radius:8px;text-align:center}
.stat .n{font-size:16px;font-weight:bold;color:#a78bfa}
.stat .l{font-size:10px;color:#9ca3af;margin-top:2px}
.err{background:rgba(127,29,29,0.5);padding:10px;border-radius:8px;font-size:12px;margin-top:8px;border-left:3px solid #ef4444}
.reload{position:fixed;bottom:20px;right:20px;background:#7c3aed;width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;box-shadow:0 4px 12px rgba(124,58,237,0.5);border:none;color:#fff}
</style></head><body>
<div class="h"><h1>⚡ ZAIN BOT v6.0</h1>
<span class="badge ${isConnected?'online':'offline'}">${isConnected?'✅ متصل 24/7':'⏳ ينتظر الربط'}</span></div>

<div class="card"><h2>📊 الحالة</h2>
<div class="stats">
<div class="stat"><div class="n">${formatUptime(up)}</div><div class="l">التشغيل</div></div>
<div class="stat"><div class="n">${metrics.totalMessages}</div><div class="l">رسائل</div></div>
<div class="stat"><div class="n">${metrics.totalReplies}</div><div class="l">ردود</div></div>
</div></div>

${currentQRDataUrl ? `
<div class="card"><h2>📱 امسح QR للربط (الأسرع)</h2>
<img class="qr" src="${currentQRDataUrl}">
<div class="hint"><b>⚡ الطريقة الأسرع والأكثر ضماناً:</b><br>
1️⃣ افتح <b>هذه الصفحة</b> على جهاز آخر (كمبيوتر/تابلت/هاتف صديق)<br>
2️⃣ على هاتفك: واتساب ← الإعدادات ← الأجهزة المرتبطة<br>
3️⃣ اضغط "ربط جهاز" ← امسح الرمز أعلاه</div></div>` : ''}

${currentPairCode ? `
<div class="card"><h2>🔑 أو استخدم رمز الربط</h2>
<div class="code" onclick="navigator.clipboard.writeText('${currentPairCode}');alert('✅ تم النسخ')">${currentPairCode}</div>
<button class="btn btn-g" onclick="navigator.clipboard.writeText('${currentPairCode}');alert('✅ تم النسخ')">📋 نسخ الرمز</button>
<div class="hint">
1️⃣ واتساب ← الإعدادات<br>
2️⃣ الأجهزة المرتبطة ← ربط جهاز<br>
3️⃣ اختر "الربط برقم الهاتف"<br>
4️⃣ أدخل الرمز</div></div>` : ''}

${!currentQRDataUrl && !currentPairCode && !isConnected ? `
<div class="card"><h2>⏳ جاري التحميل...</h2>
<p class="hint">انتظر 10-20 ثانية ثم اضغط تحديث</p></div>` : ''}

${lastError ? `<div class="err">⚠️ ${lastError}</div>` : ''}

<button class="reload" onclick="location.reload()">🔄</button>
<script>
  // تحديث تلقائي كل 20 ثانية إذا لم يكن متصلاً
  ${!isConnected ? 'setTimeout(()=>location.reload(),20000);' : ''}
</script>
</body></html>`);
        }
        else if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                connected: isConnected,
                hasQR: !!currentQR,
                hasPairCode: !!currentPairCode,
                pairCode: currentPairCode,
                phone: CONFIG.PHONE_NUMBER,
                uptime: Math.floor((Date.now() - startTime) / 1000),
                metrics,
                error: lastError
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
            res.on('end', () => {
                if (res.statusCode === 200) metrics.pingsSent++;
                else metrics.pingsFailed++;
            });
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

// ===== BOT START (Fast + QR Priority) =====
async function startBot() {
    if (reconnecting) return;
    reconnecting = true;
    try {
        const sessionPath = path.join(__dirname, '..', 'session');
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        sock = makeWASocket({
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            generateHighQualityLinkPreview: false,   // ⚡ أسرع
            syncFullHistory: false,
            markOnlineOnConnect: false,               // ⚡ أسرع
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 1000,
            maxMsgRetryCount: 3,
            qrTimeout: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        // ⚡ الأولوية للـ QR — الرمز فقط إذا لم يأتِ QR خلال 8 ثوان
        let qrReceived = false;
        if (!state.creds.registered && CONFIG.PHONE_NUMBER) {
            setTimeout(() => {
                if (!qrReceived && !state.creds.registered && !isConnected) {
                    log('🔑 No QR received, requesting pairing code...', 'info');
                    requestPairingCode(sock);
                }
            }, 8000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrReceived = true;
                currentQR = qr;
                currentPairCode = null;
                // ⚡ توليد QR بسرعة
                try {
                    currentQRDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 5, errorCorrectionLevel: 'M' });
                    log('📱 QR generated (fast mode)', 'qr');
                } catch (e) { log('QR gen: ' + e.message, 'warn'); }
            }

            if (connection === 'close') {
                currentQR = null;
                currentQRDataUrl = null;
                currentPairCode = null;
                isConnected = false;
                reconnecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`❌ Disconnected (${code})`, 'err');
                if (code !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    const delay = Math.min(CONFIG.RECONNECT_BASE * Math.pow(1.5, reconnectAttempts - 1), 30000);
                    log(`🔄 Reconnect in ${Math.round(delay/1000)}s`, 'warn');
                    setTimeout(startBot, delay);
                }
            } else if (connection === 'open') {
                currentQR = null;
                currentQRDataUrl = null;
                currentPairCode = null;
                isConnected = true;
                lastError = '';
                reconnectAttempts = 0;
                reconnecting = false;
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

                const userId = from;
                metrics.totalMessages++;

                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                // Commands
                if (text.startsWith('!')) {
                    if (text === '!ping') {
                        await sock.sendMessage(from, { text: '🏓 Pong!' }, { quoted: msg });
                        return;
                    }
                    if (text === '!status') {
                        const up = Math.floor((Date.now() - startTime) / 1000);
                        await sock.sendMessage(from, { text: `📊 متصل: ${isConnected}\n⏱️ ${formatUptime(up)}\n💬 ${metrics.totalMessages} رسالة` }, { quoted: msg });
                        return;
                    }
                    if (text === '!voice') {
                        const curr = voiceEnabled.get(userId) || false;
                        voiceEnabled.set(userId, !curr);
                        await sock.sendMessage(from, { text: `🎙️ ${!curr ? 'مُفعّل ✅' : 'مُعطّل ❌'}` }, { quoted: msg });
                        return;
                    }
                    if (text === '!help') {
                        await sock.sendMessage(from, { text: `🛡️ *الأوامر*\n!ping - اختبار\n!status - الحالة\n!voice - صوت\n!clear - مسح` }, { quoted: msg });
                        return;
                    }
                    if (text === '!clear') {
                        userHistory.delete(userId);
                        await sock.sendMessage(from, { text: '🗑️ تم المسح' }, { quoted: msg });
                        return;
                    }
                }

                // Voice
                if (msg.message.audioMessage) {
                    await sock.sendMessage(from, { text: '🎧 تحليل...' }, { quoted: msg });
                    const t = await transcribeAudio(msg);
                    if (t) text = t;
                    else { await sock.sendMessage(from, { text: '❌ لم أفهم' }, { quoted: msg }); return; }
                }

                if (!text || !text.trim()) return;
                log(`📨 ${text.substring(0, 50)}`);

                const cacheKey = `${userId}:${text.substring(0, 100)}`;
                let reply = getCachedResponse(cacheKey);
                if (!reply) {
                    reply = await askAI(text, userId);
                    if (reply) cacheResponse(cacheKey, reply);
                }

                if (reply) {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                    metrics.totalReplies++;
                    if (voiceEnabled.get(userId)) await sendVoiceReply(reply, from, msg);
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

// ===== PAIRING CODE (Fallback) =====
async function requestPairingCode(socket) {
    if (isConnected || !CONFIG.PHONE_NUMBER) return;
    try {
        const code = await socket.requestPairingCode(CONFIG.PHONE_NUMBER.replace(/[^0-9]/g, ''));
        currentPairCode = code;
        log(`🔑 PAIRING CODE: ${code}`, 'ok');
        setTimeout(() => {
            if (currentPairCode === code && !isConnected) {
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 55000);
    } catch (err) {
        log('Pairing failed: ' + err.message, 'err');
    }
}

// ===== BOOT =====
log('🚀 ZAIN BOT v6.0 SPEED starting...', 'ok');
startSelfPing();
startLocalPing();
startBot();

process.on('uncaughtException', (err) => log('Uncaught: ' + err.message, 'err'));
process.on('unhandledRejection', (err) => log('Unhandled: ' + err.message, 'err'));
