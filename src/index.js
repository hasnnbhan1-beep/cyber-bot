/* ============================================================
 *  ZAIN CYBER BOT v3.1 - FIXED PAIRING
 * ============================================================ */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';
const PORT = process.env.PORT || 10000;

if (!GROQ_API_KEY) { console.error('GROQ_API_KEY missing!'); process.exit(1); }

const groq = new Groq({ apiKey: GROQ_API_KEY });

let currentQR = null;
let currentPairCode = null;
let sock = null;
let isConnected = false;
let lastError = '';
let pairingRequested = false;

function escapeXml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

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
        }
    } catch (err) { console.log('TTS:', err.message); }
    finally { if (audioFilePath && fs.existsSync(audioFilePath)) { try { fs.unlinkSync(audioFilePath); } catch (e) {} } }
}

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
    } catch (err) { console.log('STT:', err.message); return null; }
    finally { if (audioPath && fs.existsSync(audioPath)) { try { fs.unlinkSync(audioPath); } catch (e) {} } }
}

async function askAI(userText) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'أنت "زين" - مساعد ذكي متطور. تجيب بالعربية الفصحى مع رموز تعبيرية.' },
                { role: 'user', content: userText }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7,
            max_tokens: 2048
        });
        return completion.choices?.[0]?.message?.content || null;
    } catch (err) { console.log('AI:', err.message); return null; }
}

// ===== سيرفر الويب =====
http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const qrImg = currentQR ? await qrcode.toDataURL(currentQR, {margin:2, scale:6}) : '';
            res.end(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zain Cyber Bot</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',sans-serif; background:linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%); color:#fff; min-height:100vh; padding:20px; display:flex; flex-direction:column; align-items:center; }
  .header { text-align:center; margin-bottom:30px; }
  .header h1 { font-size:28px; margin-bottom:10px; }
  .badge { display:inline-block; padding:8px 20px; border-radius:20px; font-weight:bold; font-size:14px; }
  .online { background:#10b981; }
  .offline { background:#ef4444; }
  .card { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:16px; padding:25px; margin:15px 0; width:100%; max-width:500px; }
  .card h2 { font-size:20px; margin-bottom:15px; color:#a78bfa; }
  .code { background:#000; color:#10b981; padding:20px; border-radius:10px; font-size:32px; font-weight:bold; text-align:center; letter-spacing:8px; font-family:monospace; margin:10px 0; user-select:all; }
  .hint { font-size:13px; color:#9ca3af; margin-top:10px; line-height:1.8; }
  .btn { display:inline-block; background:#7c3aed; color:#fff; padding:12px 24px; border-radius:10px; text-decoration:none; font-weight:bold; margin:8px 5px; border:none; cursor:pointer; font-size:15px; }
  .btn-green { background:#10b981; }
  img.qr { background:#fff; padding:15px; border-radius:12px; display:block; margin:10px auto; max-width:100%; }
  .error { background:#7f1d1d; padding:12px; border-radius:8px; font-size:14px; margin-top:10px; }
</style>
</head>
<body>
  <div class="header">
    <h1>🛡️ Zain Cyber Bot v3.1</h1>
    <span class="badge ${isConnected?'online':'offline'}">${isConnected?'✅ متصل':'⏳ غير متصل'}</span>
  </div>

  ${currentPairCode ? `
  <div class="card">
    <h2>🔑 رمز الربط</h2>
    <div class="code" id="code">${currentPairCode}</div>
    <button class="btn btn-green" onclick="navigator.clipboard.writeText('${currentPairCode}');alert('تم النسخ!')">📋 نسخ</button>
    <div class="hint">
      ⚠️ الرمز صالح 60 ثانية فقط!<br>
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
    <p class="hint">انتظر 15-30 ثانية ثم حدّث الصفحة</p>
    <button class="btn" onclick="location.reload()">🔄 تحديث</button>
  </div>` : ''}

  ${lastError ? `<div class="error">⚠️ ${lastError}</div>` : ''}

  <div class="card">
    <h2>ℹ️ معلومات</h2>
    <p class="hint">
      <b>الرقم:</b> ${PHONE_NUMBER || '❌ غير محدد'}<br>
      <b>الحالة:</b> ${isConnected?'متصل':'غير متصل'}<br>
      <b>Uptime:</b> ${Math.floor(process.uptime())}s
    </p>
  </div>

  <script>
    ${!currentQR && !currentPairCode ? 'setTimeout(()=>location.reload(),15000);' : ''}
  </script>
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
                uptime: process.uptime(),
                error: lastError
            }));
        }
        else if (url === '/health') { res.writeHead(200); res.end('OK'); }
        else { res.writeHead(404); res.end('Not Found'); }
    } catch (e) { res.writeHead(500); res.end('Error'); }
}).listen(PORT, () => console.log('Dashboard on port ' + PORT));

setInterval(() => { http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {}); }, 240000);

// ===== تشغيل البوت =====
async function startBot() {
    try {
        const sessionPath = path.join(__dirname, '..', 'session');
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        sock = makeWASocket({
            auth: state,
            browser: ['Zain-Bot', 'Chrome', '120.0.0.0'],
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // ✅ الطريقة الصحيحة: ننتظر إشارة QR ثم نطلب الرمز
            if (qr) {
                currentQR = qr;
                console.log('📱 QR جديد');

                if (!state.creds.registered && PHONE_NUMBER && !pairingRequested) {
                    pairingRequested = true;
                    setTimeout(async () => {
                        try {
                            console.log('📱 طلب رمز الربط للرقم:', PHONE_NUMBER);
                            const code = await sock.requestPairingCode(PHONE_NUMBER);
                            currentPairCode = code;
                            lastError = '';
                            console.log('\n🔑 PAIRING CODE: ' + code + '\n');
                        } catch (err) {
                            lastError = 'فشل الرمز: ' + err.message;
                            pairingRequested = false;
                            console.log('❌', lastError);
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
                console.log('❌ انقطع، كود:', code);
                if (code !== DisconnectReason.loggedOut) {
                    setTimeout(startBot, 5000);
                }
            } else if (connection === 'open') {
                currentQR = null;
                currentPairCode = null;
                isConnected = true;
                lastError = '';
                console.log('✅ البوت متصل!');
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

                if (msg.message.audioMessage) {
                    await sock.sendMessage(from, { text: '🎧 جاري التحليل...' }, { quoted: msg });
                    const t = await transcribeAudio(msg);
                    if (t) text = t;
                    else { await sock.sendMessage(from, { text: '❌ لم أفهم الصوت' }, { quoted: msg }); return; }
                }

                if (!text || !text.trim()) return;
                console.log('📨', text.substring(0, 50));

                await sock.sendPresenceUpdate('composing', from);
                const reply = await askAI(text);
                if (reply) {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                    await sendVoiceReply(reply, from, msg);
                }
            } catch (err) { console.log('Msg:', err.message); }
        });

    } catch (err) {
        lastError = 'Boot: ' + err.message;
        console.error('❌', err.message);
        setTimeout(startBot, 10000);
    }
}

console.log('🚀 Zain Cyber Bot v3.1');
startBot();
