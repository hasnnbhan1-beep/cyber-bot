/* ============================================================
 *  ⚡ ZAIN CYBER BOT v5.2 ULTIMATE (Session Reset + Fixed)
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
    MAX_HISTORY: 10,
    RATE_LIMIT: 20,
    RATE_WINDOW: 60000,
    CACHE_TTL: 300000,
    PING_INTERVAL: 25000,
    RECONNECT_BASE: 3000
};

const PORT = CONFIG.PORT;

if (!CONFIG.GROQ_API_KEY) { console.error('❌ GROQ_API_KEY missing!'); process.exit(1); }

const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

// ===== STATE =====
let currentQR = null;
let currentPairCode = null;
let sock = null;
let isConnected = false;
let lastError = '';
let pairingAttempts = 0;
let reconnecting = false;
let reconnectAttempts = 0;
const MAX_PAIRING = 10;
const startTime = Date.now();

// ===== METRICS =====
const metrics = {
    totalMessages: 0,
    totalReplies: 0,
    totalErrors: 0,
    totalVoiceReplies: 0,
    totalVoiceTranscribed: 0,
    totalCommands: 0,
    avgResponseTime: 0,
    responseTimes: [],
    pingsSent: 0,
    pingsFailed: 0
};

const userHistory = new Map();
const userRateLimit = new Map();
const responseCache = new Map();
const voiceEnabled = new Map();

// ===== UTILS =====
function log(msg, type = 'info') {
    const icons = { info: 'ℹ️', ok: '✅', warn: '⚠️', err: '❌', ping: '💓' };
    console.log(`[${new Date().toISOString()}] ${icons[type] || '•'} ${msg}`);
}

function escapeXml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
}

function cleanPhone(p) {
    if (!p) return '';
    return p.replace(/[^0-9]/g, '');
}

function checkRateLimit(userId) {
    const now = Date.now();
    const user = userRateLimit.get(userId) || { count: 0, reset: now + CONFIG.RATE_WINDOW };
    if (now > user.reset) { user.count = 0; user.reset = now + CONFIG.RATE_WINDOW; }
    user.count++;
    userRateLimit.set(userId, user);
    return user.count <= CONFIG.RATE_LIMIT;
}

function addToHistory(userId, role, content) {
    const hist = userHistory.get(userId) || [];
    hist.push({ role, content });
    if (hist.length > CONFIG.MAX_HISTORY * 2) hist.shift();
    userHistory.set(userId, hist);
    return hist;
}

function cacheResponse(key, response) {
    responseCache.set(key, { response, time: Date.now() });
    if (responseCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of responseCache) {
            if (now - v.time > CONFIG.CACHE_TTL) responseCache.delete(k);
        }
    }
}

function getCachedResponse(key) {
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.time < CONFIG.CACHE_TTL) return cached.response;
    return null;
}

// ===== TTS =====
async function sendVoiceReply(text, jid, quotedMsg) {
    let audioFilePath = null;
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(CONFIG.TTS_VOICE, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const cleanText = escapeXml(text.substring(0, 500));
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

// ===== STT =====
async function transcribeAudio(msg) {
    let audioPath = null;
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        audioPath = path.join(__dirname, '..', `temp_${Date.now()}.ogg`);
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
async function askAI(userText, userId, systemExtra = '') {
    const t0 = Date.now();
    try {
        const history = addToHistory(userId, 'user', userText);
        const messages = [
            { role: 'system', content: `أنت "زين" - مساعد ذكاء اصطناعي متطور من فريق Zain Cyber. تجيب بالعربية الفصحى مع رموز تعبيرية. أنت خبير في: الأمن السيبراني، البرمجة، التقنية.${systemExtra}` },
            ...history.slice(-CONFIG.MAX_HISTORY)
        ];
        
        const completion = await groq.chat.completions.create({
            messages,
            model: CONFIG.AI_MODEL,
            temperature: 0.7,
            max_tokens: 2048
        });
        
        const reply = completion.choices?.[0]?.message?.content || null;
        if (reply) {
            addToHistory(userId, 'assistant', reply);
            const elapsed = Date.now() - t0;
            metrics.responseTimes.push(elapsed);
            if (metrics.responseTimes.length > 100) metrics.responseTimes.shift();
            metrics.avgResponseTime = Math.round(metrics.responseTimes.reduce((a,b)=>a+b,0) / metrics.responseTimes.length);
        }
        return reply;
    } catch (err) {
        log('AI: ' + err.message, 'err');
        metrics.totalErrors++;
        return null;
    }
}

// ===== COMMANDS =====
const COMMANDS = {
    '!help': 'قائمة الأوامر',
    '!ping': 'اختبار سرعة',
    '!status': 'حالة البوت',
    '!stats': 'إحصائيات',
    '!voice': 'تشغيل/إيقاف الرد الصوتي',
    '!clear': 'حذف سجل المحادثة',
    '!time': 'الوقت',
    '!date': 'التاريخ',
    '!id': 'معرف المحادثة',
    '!echo': 'إعادة النص'
};

async function handleCommand(text, from, msg, userId) {
    metrics.totalCommands++;
    const cmd = text.trim().toLowerCase();
    const args = cmd.split(' ').slice(1).join(' ');
    const cmdName = cmd.split(' ')[0];

    switch (cmdName) {
        case '!help':
            await sock.sendMessage(from, {
                text: `*🛡️ ZAIN CYBER BOT v5.2*\n\n${Object.entries(COMMANDS).map(([k,v]) => `*${k}* — ${v}`).join('\n')}`
            }, { quoted: msg });
            return true;

        case '!ping': {
            const t = Date.now();
            await sock.sendMessage(from, { text: `🏓 *Pong!*\n⚡ ${Date.now() - t}ms` }, { quoted: msg });
            return true;
        }

        case '!status': {
            const up = Math.floor((Date.now() - startTime) / 1000);
            await sock.sendMessage(from, {
                text: `📊 *الحالة*\n✅ الاتصال: ${isConnected ? 'متصل' : 'غير متصل'}\n⏱️ التشغيل: ${formatUptime(up)}\n💬 الرسائل: ${metrics.totalMessages}\n⚡ الاستجابة: ${metrics.avgResponseTime}ms`
            }, { quoted: msg });
            return true;
        }

        case '!stats': {
            const up = Math.floor((Date.now() - startTime) / 1000);
            await sock.sendMessage(from, {
                text: `📈 *إحصائيات*\n⏱️ ${formatUptime(up)}\n💬 رسائل: ${metrics.totalMessages}\n✅ ردود: ${metrics.totalReplies}\n🎙️ صوتيات: ${metrics.totalVoiceReplies}\n⚙️ أوامر: ${metrics.totalCommands}\n❌ أخطاء: ${metrics.totalErrors}\n💓 Ping: ${metrics.pingsSent}`
            }, { quoted: msg });
            return true;
        }

        case '!voice': {
            const curr = voiceEnabled.get(userId) || false;
            voiceEnabled.set(userId, !curr);
            await sock.sendMessage(from, { text: `🎙️ الرد الصوتي: ${!curr ? '✅ مُفعّل' : '❌ مُعطّل'}` }, { quoted: msg });
            return true;
        }

        case '!clear':
            userHistory.delete(userId);
            await sock.sendMessage(from, { text: '🗑️ تم حذف سجل المحادثة' }, { quoted: msg });
            return true;

        case '!time':
            await sock.sendMessage(from, { text: `🕐 ${new Date().toLocaleTimeString('ar-EG')}` }, { quoted: msg });
            return true;

        case '!date':
            await sock.sendMessage(from, { text: `📅 ${new Date().toLocaleDateString('ar-EG', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}` }, { quoted: msg });
            return true;

        case '!id':
            await sock.sendMessage(from, { text: `🆔 \`${from}\`` }, { quoted: msg });
            return true;

        case '!echo':
            await sock.sendMessage(from, { text: args || 'استخدم: !echo نص' }, { quoted: msg });
            return true;

        default:
            return false;
    }
}

// ===== WEB DASHBOARD =====
http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const qrImg = currentQR ? await qrcode.toDataURL(currentQR, {margin:2, scale:6}) : '';
            const up = Math.floor((Date.now() - startTime) / 1000);

            res.end(`<!DOCTYPE html>
<html dir="rtl" lang="ar"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡ Zain Cyber Bot v5.2</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh;padding:20px;display:flex;flex-direction:column;align-items:center}
.h{text-align:center;margin-bottom:20px}
.h h1{font-size:26px;background:linear-gradient(90deg,#a78bfa,#10b981);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:10px}
.badge{display:inline-block;padding:8px 20px;border-radius:20px;font-weight:bold;font-size:14px}
.online{background:#10b981}.offline{background:#ef4444}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:22px;margin:12px 0;width:100%;max-width:500px}
.card h2{font-size:18px;margin-bottom:12px;color:#a78bfa}
.code{background:#000;color:#10b981;padding:22px;border-radius:10px;font-size:32px;font-weight:bold;text-align:center;letter-spacing:8px;font-family:monospace;margin:10px 0;user-select:all;cursor:pointer}
.code:hover{background:#065f46}
.hint{font-size:13px;color:#9ca3af;line-height:1.8;margin-top:10px}
.btn{display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:10px;font-weight:bold;margin:8px 5px;border:none;cursor:pointer;font-size:15px}
.btn-g{background:#10b981}
img.qr{background:#fff;padding:15px;border-radius:12px;display:block;margin:10px auto;max-width:100%}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.stat{background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;text-align:center}
.stat .n{font-size:18px;font-weight:bold;color:#a78bfa}
.stat .l{font-size:11px;color:#9ca3af;margin-top:3px}
.err{background:rgba(127,29,29,0.5);padding:12px;border-radius:8px;font-size:13px;margin-top:10px;border-left:3px solid #ef4444}
</style></head><body>
<div class="h"><h1>⚡ ZAIN CYBER BOT v5.2</h1>
<span class="badge ${isConnected?'online':'offline'}">${isConnected?'✅ متصل 24/7':'⏳ غير متصل'}</span></div>

<div class="card"><h2>📊 الإحصائيات</h2>
<div class="stats">
<div class="stat"><div class="n">${formatUptime(up)}</div><div class="l">التشغيل</div></div>
<div class="stat"><div class="n">${metrics.totalMessages}</div><div class="l">رسائل</div></div>
<div class="stat"><div class="n">${metrics.totalReplies}</div><div class="l">ردود</div></div>
<div class="stat"><div class="n">${metrics.avgResponseTime}ms</div><div class="l">استجابة</div></div>
</div></div>

${currentPairCode ? `
<div class="card"><h2>🔑 رمز الربط</h2>
<div class="code" onclick="navigator.clipboard.writeText('${currentPairCode}');this.style.background='#065f46';alert('✅ تم النسخ');">${currentPairCode}</div>
<button class="btn btn-g" onclick="navigator.clipboard.writeText('${currentPairCode}');alert('✅ تم النسخ')">📋 نسخ</button>
<div class="hint"><b>⚠️ صالح 60 ثانية!</b><br>
1️⃣ واتساب ← الإعدادات<br>
2️⃣ الأجهزة المرتبطة ← ربط جهاز<br>
3️⃣ اختر <b>"الربط برقم الهاتف"</b><br>
4️⃣ أدخل الرمز</div></div>` : ''}

${qrImg ? `
<div class="card"><h2>📱 QR Code</h2>
<img class="qr" src="${qrImg}"></div>` : ''}

${!currentQR && !currentPairCode && !isConnected ? `
<div class="card"><h2>⏳ جاري التحميل...</h2>
<button class="btn" onclick="location.reload()">🔄 تحديث</button></div>` : ''}

${lastError ? `<div class="err">⚠️ ${lastError}</div>` : ''}
</body></html>`);
        }
        else if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                connected: isConnected, hasQR: !!currentQR, hasPairCode: !!currentPairCode,
                pairCode: currentPairCode, phone: CONFIG.PHONE_NUMBER,
                uptime: Math.floor((Date.now() - startTime) / 1000),
                metrics, error: lastError, attempts: pairingAttempts
            }));
        }
        else if (url === '/health' || url === '/ping') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
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

// ===== PAIRING CODE =====
async function requestPairingCode(socket) {
    if (pairingAttempts >= MAX_PAIRING || isConnected) return;
    pairingAttempts++;
    try {
        log(`🔑 Pairing attempt ${pairingAttempts}/${MAX_PAIRING}...`);
        const code = await socket.requestPairingCode(cleanPhone(CONFIG.PHONE_NUMBER));
        currentPairCode = code;
        lastError = '';
        log(`✅ PAIRING CODE: ${code}`, 'ok');
        setTimeout(() => {
            if (currentPairCode === code && !isConnected) {
                log('⏰ Code expired, renewing...', 'warn');
                currentPairCode = null;
                requestPairingCode(socket);
            }
        }, 55000);
    } catch (err) {
        log(`❌ Pairing ${pairingAttempts} failed: ${err.message}`, 'err');
        lastError = `فشل الرمز (${pairingAttempts}/${MAX_PAIRING}): ${err.message}`;
        if (pairingAttempts < MAX_PAIRING && !isConnected) {
            setTimeout(() => requestPairingCode(socket), 5000);
        }
    }
}

// ===== BOT START =====
async function startBot() {
    if (reconnecting) { log('Already reconnecting...', 'warn'); return; }
    reconnecting = true;
    try {
        const sessionPath = path.join(__dirname, '..', 'session');

        // 🗑️ حذف الجلسة القديمة تلقائياً في كل تشغيل
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
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5
        });

        sock.ev.on('creds.update', saveCreds);

        if (!state.creds.registered && CONFIG.PHONE_NUMBER) {
            setTimeout(() => requestPairingCode(sock), 4000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { currentQR = qr; log('📱 QR ready'); }

            if (connection === 'close') {
                currentQR = null; currentPairCode = null; isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                log(`❌ Disconnected (${code})`, 'err');
                reconnecting = false;
                if (code !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    pairingAttempts = 0;
                    const delay = Math.min(CONFIG.RECONNECT_BASE * Math.pow(1.5, reconnectAttempts - 1), 60000);
                    log(`🔄 Reconnect in ${Math.round(delay/1000)}s`, 'warn');
                    setTimeout(startBot, delay);
                }
            } else if (connection === 'open') {
                currentQR = null; currentPairCode = null; isConnected = true;
                lastError = ''; pairingAttempts = 0; reconnectAttempts = 0; reconnecting = false;
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

                if (!checkRateLimit(userId)) {
                    await sock.sendMessage(from, { text: '⏸️ تمهّل! تجاوزت الحد المسموح.' }, { quoted: msg });
                    return;
                }

                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                if (text.startsWith('!')) {
                    const handled = await handleCommand(text, from, msg, userId);
                    if (handled) return;
                }

                if (msg.message.audioMessage) {
                    await sock.sendMessage(from, { text: '🎧 جاري تحليل الصوت...' }, { quoted: msg });
                    const t = await transcribeAudio(msg);
                    if (t) text = t;
                    else { await sock.sendMessage(from, { text: '❌ لم أفهم الصوت' }, { quoted: msg }); return; }
                }

                if (!text || !text.trim()) return;
                log(`📨 ${text.substring(0, 60)}`);

                const cacheKey = `${userId}:${text}`;
                let reply = getCachedResponse(cacheKey);
                if (!reply) {
                    reply = await askAI(text, userId);
                    if (reply) cacheResponse(cacheKey, reply);
                }

                if (reply) {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                    metrics.totalReplies++;
                    if (voiceEnabled.get(userId)) {
                        await sendVoiceReply(reply, from, msg);
                    }
                }
            } catch (err) {
                log('Msg: ' + err.message, 'err');
                metrics.totalErrors++;
            }
        });

    } catch (err) {
        lastError = 'Boot: ' + err.message;
        log('❌ ' + err.message, 'err');
        reconnecting = false;
        setTimeout(startBot, 10000);
    }
}

// ===== BOOT =====
log('🚀 ZAIN CYBER BOT v5.2 starting...', 'ok');
log(`📱 Phone: ${CONFIG.PHONE_NUMBER || '❌ not set'}`, 'info');
log(`🌐 Self-URL: ${CONFIG.SELF_URL}`, 'info');
startSelfPing();
startLocalPing();
startBot();

process.on('uncaughtException', (err) => log('Uncaught: ' + err.message, 'err'));
process.on('unhandledRejection', (err) => log('Unhandled: ' + err.message, 'err'));
