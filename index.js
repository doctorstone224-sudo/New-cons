const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const readline = require("readline");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ✅ Clé API remplacée
const genAI = new GoogleGenerativeAI("AIzaSyDE8lQo7xMlDS70achQANr3Yj-AlpxFNmM"); 

const usePairingCode = true;

const question = (text) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(text, resolve);
    });
};

let botEnabled = true;

// Créer le dossier 'media' si il n'existe pas
if (!fs.existsSync('./media')) {
    fs.mkdirSync('./media', { recursive: true });
}

// Fonction utilitaire pour encoder une image en base64 pour l'API Gemini
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType
        },
    };
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: !usePairingCode,
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question("Veuillez saisir votre numéro WhatsApp (Exemple : 221xxxxxxxxx) : ");
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log("Voici votre code d'appairage. Connectez-le dans WhatsApp : ");
        console.log(`${code}`);
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log("connection closed due to ", lastDisconnect.error, ", reconnecting ", shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === "open") {
            console.log("opened connection");
        }
    });

    sock.ev.on("messages.upsert", async m => {
        if (m.messages[0].key.fromMe) return;

        const message = m.messages[0];
        const remoteJid = message.key.remoteJid;

        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;

        if (text) {
            const lowerCaseText = text.toLowerCase().trim();
            if (lowerCaseText === "off") {
                botEnabled = false;
                await sock.sendMessage(remoteJid, { text: "D'accord, je me mets en pause. Dis 'on' quand tu auras besoin de moi !" });
                return;
            } else if (lowerCaseText === "on") {
                botEnabled = true;
                await sock.sendMessage(remoteJid, { text: "Je suis de retour ! Comment puis-je t'aider ?" });
                return;
            }
        }

        if (!botEnabled) {
            return;
        }

        if (message.message?.imageMessage) {
            const imageMessage = message.message.imageMessage;
            const caption = imageMessage.caption;
            const mimetype = imageMessage.mimetype;

            await sock.sendMessage(remoteJid, { text: "J'ai bien reçu votre image ! Laissez-moi l'analyser..." });

            try {
                const buffer = await downloadMediaMessage(message, 'buffer');
                const filePath = `./media/${message.key.id}.${mimetype.split('/')[1]}`;
                fs.writeFileSync(filePath, buffer);

                const imagePart = fileToGenerativePart(filePath, mimetype);
                const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });

                const parts = [imagePart];
                if (caption) {
                    parts.unshift(caption);
                } else {
                    parts.unshift("Décris le contenu de cette image de manière détaillée.");
                }

                const result = await model.generateContent(parts);
                const geminiResponse = result.response.text();
                await sock.sendMessage(remoteJid, { text: geminiResponse });
            } catch (error) {
                console.error("Erreur lors du traitement de l'image :", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors du traitement de votre image." });
            }
        } else if (message.message?.videoMessage) {
            await sock.sendMessage(remoteJid, { text: "Désolé, l'API Gemini ne prend pas encore en charge l'analyse de vidéos. Je ne peux pas traiter ce message pour le moment." });
        } else if (message.message?.documentMessage) {
            const documentMessage = message.message.documentMessage;
            const filename = documentMessage.fileName;
            const mimetype = documentMessage.mimetype;

            await sock.sendMessage(remoteJid, { text: `J'ai bien reçu le document '${filename}' !` });
            try {
                const buffer = await downloadMediaMessage(message, 'buffer');
                const filePath = `./media/${message.key.id}.${filename.split('.').pop()}`;
                fs.writeFileSync(filePath, buffer);
            } catch (error) {
                console.error("Erreur lors du téléchargement du document :", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors du téléchargement du document." });
            }
        } else if (message.message?.audioMessage) {
            await sock.sendMessage(remoteJid, { text: "Désolé, l'API Gemini ne prend pas encore en charge la transcription de messages audio. Je ne peux pas traiter ce message pour le moment." });
        } else if (text) {
            try {
                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const prompt = `Tu es une intelligence artificielle conçue pour discuter avec les humains de manière naturelle, fluide et conviviale. Tu réponds toujours comme un humain : tu es amical(e), chaleureux(se) et engagé(e) dans la conversation. Tu fais des phrases simples et naturelles, sans jamais dire que tu es une IA. Tu peux utiliser des expressions courantes, un peu d’humour léger ou de familiarité selon le ton de ton interlocuteur. Tu es toujours serviable, à l’écoute, et tu proposes ton aide spontanément. Si la question est sérieuse, tu restes respectueux(se) et clair(e). Tu ne fais jamais de réponses robotiques ou trop formelles. Tu réponds toujours en français, sauf si l’utilisateur parle une autre langue. Ton objectif est que l’utilisateur ait l’impression de parler à une vraie personne gentille et intelligente. Ton nom est Moussa. L'utilisateur a dit : ${text}`;
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const geminiResponse = response.text();
                await sock.sendMessage(remoteJid, { text: geminiResponse });
            } catch (error) {
                console.error("Erreur lors de l'appel à l'API Gemini:", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors de la communication avec l'API Gemini." });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();