const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode');
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const xmlEscape = require("xml-escape");
const fs = require('fs');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';

if (!GROQ_API_KEY) console.error("GROQ_API_KEY is missing!");

const groq = new Groq({ apiKey: GROQ_API_KEY });
const PORT = process.env.PORT || 10000;
let currentQR = null;
let sock = null;

async function sendVoiceReply(text, jid, quotedMsg) {
    let audioFilePath = null;
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata("ar-EG-SalmaNeural", OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
        const escapedText = xmlEscape(text.substring(0, 500));
        const tmpDir = path.join(__dirname, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const result = await tts.toFile(tmpDir, escapedText);
        audioFilePath = result.audioFilePath;
        if (audioFilePath && fs.existsSync(audioFilePath) && sock) {
            await sock.sendMessage(jid, { audio: { url: audioFilePath }, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: quotedMsg });
        }
    } catch (err) { console.log('TTS:', err.message); }
    finally { if (audioFilePath && fs.existsSync(audioFilePath)) { try { fs.unlinkSync(audioFilePath); } catch (e) {} } }
}

http.createServer(async (req, res) => {
    try {
        if (req.url === '/qrcode') {
            if (!currentQR) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body style="background:#111;color:#fff;text-align:center;padding:50px"><h1>QR not ready</h1></body></html>'); return; }
            const dataUrl = await qrcode.toDataURL(currentQR, { margin: 2, scale: 8 });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="background:#111;color:#fff;text-align:center;padding:40px"><h1>Scan QR</h1><img src="' + dataUrl + '" style="background:#fff;padding:20px;border-radius:10px;margin-top:20px"/></body></html>');
        } else if (req.url === '/health') { res.writeHead(200); res.end('OK'); }
        else { res.writeHead(200); res.end('Zain Cyber Bot Online'); }
    } catch (e) { res.writeHead(500); res.end('Error'); }
}).listen(PORT, () => console.log('Server on port: ' + PORT));

setInterval(() => { http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {}); }, 4 * 60 * 1000);

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('session');
        sock = makeWASocket({ auth: state, browser: ["Linux", "Chrome", "120.0.0.0"], printQRInTerminal: false });
        sock.ev.on('creds.update', saveCreds);

        if (!state.creds.registered && PHONE_NUMBER) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log('\n========================================');
                    console.log('PAIRING CODE: ' + code);
                    console.log('========================================\n');
                } catch (err) { console.log('Pairing error:', err.message); }
            }, 3000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) currentQR = qr;
            if (connection === 'close') { currentQR = null; const code = lastDisconnect?.error?.output?.statusCode; if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 5000); }
            else if (connection === 'open') { currentQR = null; console.log('=== Bot is working! ==='); }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            try {
                if (type !== 'notify') return;
                const msg = messages[0];
                if (!msg?.message || msg.key.fromMe) return;
                const from = msg.key.remoteJid;
                if (from.endsWith('@g.us')) return;
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                if (msg.message.audioMessage) {
                    let audioPath = null;
                    try {
                        await sock.sendMessage(from, { text: 'Analyzing audio...' }, { quoted: msg });
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        audioPath = path.join(__dirname, `temp_${Date.now()}.ogg`);
                        fs.writeFileSync(audioPath, buffer);
                        const FormData = require('form-data');
                        const formData = new FormData();
                        formData.append('file', fs.createReadStream(audioPath));
                        formData.append('model', 'whisper-large-v3-turbo');
                        formData.append('language', 'ar');
                        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }, body: formData });
                        const result = await response.json();
                        if (result && result.text) text = result.text;
                    } catch (sttErr) { console.log('STT:', sttErr.message); }
                    finally { if (audioPath && fs.existsSync(audioPath)) { try { fs.unlinkSync(audioPath); } catch (e) {} } }
                }

                if (!text || text.trim().length === 0) return;
                await sock.sendPresenceUpdate('composing', from);
                const completion = await groq.chat.completions.create({
                    messages: [
                        { role: 'system', content: 'You are "Zain Cyber Engine". Reply in Arabic.' },
                        { role: 'user', content: text }
                    ],
                    model: 'llama-3.3-70b-versatile'
                });
                const reply = completion.choices?.[0]?.message?.content;
                if (reply) { await sock.sendMessage(from, { text: reply }, { quoted: msg }); await sendVoiceReply(reply, from, msg); }
            } catch (msgErr) { console.log('Message error:', msgErr.message); }
        });
    } catch (bootErr) { console.error('Boot failed:', bootErr.message); setTimeout(startBot, 10000); }
}

startBot();
