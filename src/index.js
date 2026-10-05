/* ============================================================
 *  ⚡ ZAIN CYBER BOT v4.0 PRO - ULTIMATE EDITION
 *  Features: AI Chat, TTS, STT, Pairing, QR, Auto-Reconnect,
 *            Self-Ping 24/7, External Keep-Alive, Dashboard
 * ============================================================ */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const http = require('http');
const https = require('https');
const qrcode = require('qrcode');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';
const PORT = process.env.PORT || 10000;
const SELF_URL = process.env.SELF_URL || 'https://cyber-bot-urcz.onrender.com';

if (!GROQ_API_KEY) { console.error('❌ GROQ_API_KEY missing!'); process.exit(1); }

const groq = new Groq({ apiKey: GROQ_API_KEY, timeout: 60000, maxRetries: 3 });

let currentQR = null;
let currentPairCode = null;
let sock = null;
let isConnected = false;
let lastError = '';
let pairingRequested = false;
let totalMessages = 0;
let startTime = Date.now();

// ===== utilities =====
function escapeXml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ===== TTS =====
async function sendVoiceReply(text, jid, quotedMsg) {
    let audioFilePath = null;
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata('ar-EG-SalmaNeural', OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
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
            log('🎙️ Voice reply sent');
        }
    } catch (err) { log('TTS: ' + err.message); }
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
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('language', 'ar');
        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
            body: formData
        });
        const result = await response.json();
        return result.text || null;
    } catch (err) { log('STT: ' + err.message); return null; }
    finally { if (audioPath && fs.existsSync(audioPath)) { try { fs.unlinkSync(audioPath); } catch (e) {} } }
}

// ===== AI =====
async function askAI(userText) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'أنت "زين" - مساعد ذكاء اصطناعي متطور. تجيب بالعربية الفصحى مع رموز تعبيرية مناسبة. أنت خبير في الأمن السيبراني، البرمجة، والتقنية.' },
                { role: 'user', content: userText }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7,
            max_tokens: 2048
        });
        return completion.choices?.[0]?.message?.content || null;
    } catch (err) { log('AI: ' + err.message); return null; }
}

// ===== SELF-PING (الطبقة الأولى) =====
function startSelfPing() {
    log('🔄 Self-Ping started (every 30s)');
    setInterval(() => {
        const url = `${SELF_URL}/health?t=${Date.now()}`;
        https.get(url, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                if (res.statusCode === 200) log('💓 Self-ping OK');
            });
        }).on('error', (err) => log('⚠️ Self-ping: ' + err.message));
    }, 30000); // كل 30 ثانية
}

// ===== LOCAL PING (الطبقة الثانية) =====
function startLocalPing() {
    setInterval(() => {
        http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    }, 60000); // كل دقيقة
}

// ===== WEB SERVER =====
http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const qrImg = currentQR ? await qrcode.toDataURL(currentQR, {margin:2, scale:6}) : '';
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const mins = Math.floor((uptime % 3600) / 60);

            res.end(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zain Cyber Bot v4.0</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh;padding:20px;display:flex;flex-direction:column;align-items:center}
  .h{text-align:center;margin-bottom:30px}
  .h h1{font-size:28px;margin-bottom:10px}
  .badge{display:inline-block;padding:8px 20px;border-radius:20px;font-weight:bold;font-size:14px}
  .online{background:#10b981}.offline{background:#ef4444}
  .card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:25px;margin:15px 0;width:100%;max-width:500px;backdrop-filter:blur(10px)}
  .card h2{font-size:20px;margin-bottom:15px;color:#a78bfa}
  .code{background:#000;color:#10b981;padding:20px;border-radius:10px;font-size:32px;font-weight:bold;text-align:center;letter-spacing:8px;font-family:monospace;margin:10px 0;user-select:all}
  .hint{font-size:13px;color:#9ca3af;margin-top:10px;line-height:1.8}
  .btn{display:inline-block;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;margin:8px 5px;border:none;cursor:pointer;font-size:15px}
  .btn-g{background:#10b981}
  img.qr{background:#fff;padding:15px;border-radius:12px;display:block;margin:10px auto;max-width:100%}
  .err{background:#7f1d1d;padding:12px;border-radius:8px;font-size:14px;margin-top:10px}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
  .stat{background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;text-align:center}
  .stat .n{font-size:20px;font-weight:bold;color:#a78bfa}
  .stat .l{font-size:12px;color:#9ca3af}
</style>
</head>
<body>
  <div class="h">
    <h1>⚡ Zain Cyber Bot v4.0 PRO</h1>
    <span class="badge ${isConnected?'online':'offline'}">${isConnected?'✅ متصل 24/7':'⏳ غير متصل'}</span>
  </div>

  <div class="card">
    <h2>📊 إحصائيات</h2>
    <div class="stats">
      <div class="stat"><div class="n">${hours}h ${mins}m</div><div class="l">مدة التشغيل</div></div>
      <div class="stat"><div class="n">${totalMessages}</div><div class="l">رسائل</div></div>
    </div>
  </div>

  ${currentPairCode ? `
  <div class="card">
    <h2>🔑 رمز الربط</h2>
    <div class="code" id="c">${currentPairCode}</div>
    <button class="btn btn-g" onclick="navigator.clipboard.writeText('${currentPairCode}');alert('تم النسخ!')">📋 نسخ</button>
    <div class="hint">
      ⚠️ صالح 60 ثانية فقط!<br>
      1. واتساب → الإعدادات<br>
      2. الأجهزة المرتبطة → ربط جهاز<br>
      3. اختر "الربط برقم الهاتف"<br>
      4. أدخل الرمز
    </div>
  </div>` : ''}

  ${qrImg ? `
  <div class="card">
    <h2>📱 QR Code</h2>
    <img class="qr" src="${qrImg}">
    <div class="hint">امسح من واتساب → الأجهزة المرتبطة</div>
  </div>` : ''}

  ${!currentQR && !currentPairCode ? `
  <div class="card">
    <h2>⏳ جاري التحميل...</h2>
    <p class="hint">انتظر 15-30 ثانية</p>
    <button class="btn" onclick="location.reload()">🔄 تحديث</button>
  </div>` : ''}

  ${lastError ? `<div class="err">⚠️ ${lastError}</div>` : ''}

  <div class="card">
    <h2>ℹ️ معلومات</h2>
    <p class="hint">
      <b>الرقم:</b> ${PHONE_NUMBER || '❌'}<br>
      <b>البريد:</b> متصل بـ Groq AI<br>
      <b>الحالة:</b> ${isConnected?'متصل ✅':'غير متصل'}
    </p>
  </div>

  <script>${!currentQR && !currentPairCode ? 'setTimeout(()=>location.reload(),15000);' : ''}</script>
</body>
</html>`);
        }
        else if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                connected: isConnected,
                hasQR: !!currentQR,
                hasPairCode: !!currentPairCode,
                pairCode: currentPairCode,
                phone: PHONE_NUMBER,
                uptime: Math.floor((Date.now() - startTime) / 1000),
                messages: totalMessages,
                error: lastError
            }));
        }
        else if (url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        }
        else {
            res.writeHead(404);
            res.end('404');
        }
    } catch (e) {
        res.writeHead(500);
        res.end('Error');
    }
}).listen(PORT, () => log(`🌐 Dashboard on port ${PORT}`));

// ===== تشغيل البوت =====
async function startBot() {
    try {
        const sessionPath = path.join(__dirname, '..', 'session');
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        sock = makeWASocket({
            auth: state,
            browser: ['Zain-Bot', 'Chrome', '120.0.0.0'],
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                log('📱 QR generated');

                if (!state.creds.registered && PHONE_NUMBER && !pairingRequested) {
                    pairingRequested = true;
                    setTimeout(async () => {
                        try {
                            log('📱 Requesting pairing code...');
                            const code = await sock.requestPairingCode(PHONE_NUMBER);
                            currentPairCode = code;
                            lastError = '';
                            log('🔑 PAIRING CODE: ' + code);
                        } catch (err) {
                            lastError = 'فشل الرمز: ' + err.message;
                            pairingRequested = false;
                            log('❌ ' + lastError);
                        }
                    }, 2000);
                }
            }

            if (connection === 'close') {
                currentQR = null;
                currentPairCode = null;
                isConnected = false;
                pairingRequested = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                log('❌ Disconnected, code: ' + code);
                if (code !== DisconnectReason.loggedOut) {
                    log('🔄 Reconnecting in 5s...');
                    setTimeout(startBot, 5000);
                }
            } else if (connection === 'open') {
                currentQR = null;
                currentPairCode = null;
                isConnected = true;
                lastError = '';
                log('✅ BOT CONNECTED SUCCESSFULLY!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            try {
                const msg = messages[0];
                if (!msg?.message || msg.key.fromMe) return;
                const from = msg.key.remoteJid;
                if (from.endsWith('@g.us')) return;

                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                totalMessages++;

                // Command handling
                if (text === '!ping' || text === '.ping') {
                    await sock.sendMessage(from, { text: '🏓 Pong! البوت يعمل ✅' }, { quoted: msg });
                    return;
                }
                if (text === '!status' || text === '.status') {
                    const up = Math.floor((Date.now() - startTime) / 1000);
                    await sock.sendMessage(from, { text: `📊 *حالة البوت*\n\n✅ متصل\n⏱️ المدة: ${Math.floor(up/60)} دقيقة\n💬 الرسائل: ${totalMessages}` }, { quoted: msg });
                    return;
                }

                if (msg.message.audioMessage) {
                    await sock.sendMessage(from, { text: '🎧 جاري التحليل...' }, { quoted: msg });
                    const t = await transcribeAudio(msg);
                    if (t) text = t;
                    else { await sock.sendMessage(from, { text: '❌ لم أفهم الصوت' }, { quoted: msg }); return; }
                }

                if (!text || !text.trim()) return;
                log('📨 ' + text.substring(0, 50));

                await sock.sendPresenceUpdate('composing', from);
                const reply = await askAI(text);
                if (reply) {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                    await sendVoiceReply(reply, from, msg);
                }
            } catch (err) { log('Msg: ' + err.message); }
        });

    } catch (err) {
        lastError = 'Boot: ' + err.message;
        log('❌ ' + err.message);
        setTimeout(startBot, 10000);
    }
}

// ===== START EVERYTHING =====
log('🚀 Zain Cyber Bot v4.0 PRO starting...');
log('📡 Self-URL: ' + SELF_URL);
startSelfPing();
startLocalPing();
startBot();
