const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({ apiKey: "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" });

const readline = require("readline");
const PhoneNumber = require("awesome-phonenumber");

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
        console.log(JSON.stringify(m, undefined, 2));
        if (m.messages[0].key.fromMe) return; // Ignore messages sent by the bot itself
        if (m.type === "notify") {
            const message = m.messages[0];
            const text = message.message?.conversation || message.message?.extendedTextMessage?.text;

            if (text) {
                const lowerCaseText = text.toLowerCase().trim();

                if (lowerCaseText === "off") {
                    botEnabled = false;
                    await sock.sendMessage(message.key.remoteJid, { text: "D'accord, je me mets en pause. Dis 'on' quand tu auras besoin de moi !" });
                    return;
                } else if (lowerCaseText === "on") {
                    botEnabled = true;
                    await sock.sendMessage(message.key.remoteJid, { text: "Je suis de retour ! Comment puis-je t'aider ?" });
                    return;
                }

                if (!botEnabled) {
                    return; // If bot is off, do not process further
                }
                try {
                    const chatCompletion = await groq.chat.completions.create({
                        messages: [
                            {
                                role: "system",
                                content: "Tu es une intelligence artificielle conçue pour discuter avec les humains de manière naturelle, fluide et conviviale. Tu réponds toujours comme un humain : tu es amical(e), chaleureux(se) et engagé(e) dans la conversation. Tu fais des phrases simples et naturelles, sans jamais dire que tu es une IA. Tu peux utiliser des expressions courantes, un peu d’humour léger ou de familiarité selon le ton de ton interlocuteur. Tu es toujours serviable, à l’écoute, et tu proposes ton aide spontanément. Si la question est sérieuse, tu restes respectueux(se) et clair(e). Tu ne fais jamais de réponses robotiques ou trop formelles. Tu réponds toujours en français, sauf si l’utilisateur parle une autre langue. Ton objectif est que l’utilisateur ait l’impression de parler à une vraie personne gentille et intelligente. Ton nom est Moussa.",
                            },
                            {
                                role: "user",
                                content: text,
                            },
                        ],
                        model: "llama-3.3-70b-versatile",
                    });
                    const groqResponse = chatCompletion.choices[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse.";
                    await sock.sendMessage(message.key.remoteJid, { text: groqResponse });
                } catch (error) {
                    console.error("Erreur lors de l'appel à l'API Groq:", error);
                    await sock.sendMessage(message.key.remoteJid, { text: "Désolé, une erreur est survenue lors de la communication avec l'API Groq." });
                }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();


