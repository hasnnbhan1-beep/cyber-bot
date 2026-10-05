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
const groq = new Groq({ apiKey: GROQ_API_KEY });

let currentQR = null;
let sock = null;

http.createServer(async (req, res) => {
    if (req.url === '/qrcode' && currentQR) {
        const img = await qrcode.toDataURL(currentQR);
        res.writeHead(200, {'Content-Type':'text/html'});
        res.end('<html><body style="background:#111;text-align:center;padding:40px"><img src="'+img+'" style="background:#fff;padding:20px"/></body></html>');
    } else {
        res.writeHead(200); res.end('Bot Online');
    }
}).listen(PORT, () => console.log('Port ' + PORT));

setInterval(() => { http.get('http://localhost:'+PORT, () => {}).on('error', () => {}); }, 240000);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    sock = makeWASocket({ auth: state, browser: ['Bot','Chrome','120'], printQRInTerminal: false, logger: pino({level:'silent'}) });
    sock.ev.on('creds.update', saveCreds);

    if (!state.creds.registered && PHONE_NUMBER) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n╔══════════════════════════╗');
                console.log('║ PAIRING CODE: ' + code);
                console.log('╚══════════════════════════╝\n');
            } catch (e) { console.log('Error:', e.message); }
        }, 3000);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) currentQR = qr;
        if (connection === 'close') {
            const c = lastDisconnect?.error?.output?.statusCode;
            if (c !== DisconnectReason.loggedOut) setTimeout(startBot, 5000);
        } else if (connection === 'open') {
            currentQR = null;
            console.log('=== Bot Connected! ===');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        if (from.endsWith('@g.us')) return;
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        const r = await groq.chat.completions.create({
            messages: [{ role: 'system', content: 'أنت زين، مساعد ذكي. رد بالعربية.' }, { role: 'user', content: text }],
            model: 'llama-3.3-70b-versatile'
        });
        const reply = r.choices[0].message.content;
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
    });
}

startBot();
