const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Groq } = require('groq-sdk');
const { GROQ_API_KEY } = require('./config');
const http = require('http');
const qrcode = require('qrcode');

const groq = new Groq({ apiKey: GROQ_API_KEY });

const PORT = process.env.PORT || 10000;
let currentQR = null;
let sock = null;

http.createServer(async (req, res) => {
    if (req.url === '/qrcode') {
        if (!currentQR) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="background:#111;color:#fff;text-align:center;padding:50px;font-family:sans-serif"><h1>⏳ الباركود لسه ما جاهز</h1><p>حدث الصفحة بعد 5 ثواني</p></body></html>');
            return;
        }
        try {
            const dataUrl = await qrcode.toDataURL(currentQR, { margin: 2, scale: 8 });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="background:#111;color:#fff;text-align:center;padding:40px;font-family:sans-serif"><h1>🔳 امسح الباركود من واتساب</h1><p>واتساب → الإعدادات → الأجهزة المرتبطة → ربط جهاز</p><img src="' + dataUrl + '" style="background:#fff;padding:20px;border-radius:10px;margin-top:20px"/><p style="margin-top:20px;color:#888">إذا انتهت صلاحيته، حدث الصفحة</p></body></html>');
        } catch (e) {
            res.end('خطأ: ' + e.message);
        }
    } else if (req.url === '/health') {
        res.writeHead(200);
        res.end('OK');
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('🤖 Zain Cyber Bot Online');
    }
}).listen(PORT, () => console.log('🌐 Web server on port ' + PORT));

setInterval(() => {
    http.get('http://localhost:' + PORT + '/health', () => {}).on('error', () => {});
}, 4 * 60 * 1000);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    sock = makeWASocket({
        auth: state,
        browser: ["Mac OS", "Chrome", "2.3000.1043180520"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            await qrcode.toFile('./qrcode.png', qr, { margin: 2, scale: 8 }).catch(() => {});
            console.log('\n🔳 الباركود جاهز! افتح /qrcode من المتصفح\n');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ الاتصال انقطع، الكود:', code);
            currentQR = null;
            if (code !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            currentQR = null;
            console.log('=== ✨ زين يعمل الآن بنجاح! ===');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg?.message) return;

        const from = msg.key.remoteJid;
        if (from.endsWith('@g.us')) return;

        const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || '';
        if (!text) return;

        if (text.startsWith('زين ') || text.startsWith('يا زين ') || text.startsWith('مرحبا زين ')) {
            const prompt = text.replace(/^(يا زين|مرحبا زين|زين)\s+/, '');
            try {
                await sock.sendPresenceUpdate('composing', from);
                const completion = await groq.chat.completions.create({
                    messages: [
                        {
                            role: 'system',
                            content: "أنت مساعد ذكي اسمك 'زين'، تجيب بالعربية بأسلوب منظم مع إيموجي."
                        },
                        { role: 'user', content: prompt }
                    ],
                    model: 'openai/gpt-oss-20b'
                });
                const reply = completion.choices[0].message.content;
                await sock.sendMessage(from, { text: reply }, { quoted: msg });
            } catch (err) {
                console.log('Groq error:', err.message);
                await sock.sendMessage(from, { text: '⚠️ صار خطأ، حاول مرة ثانية.' });
            }
        }
    });
}

startBot();
