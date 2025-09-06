const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const Groq = require("groq-sdk");
const fs = require("fs");
const OpenAI = require("openai"); // Importation du module OpenAI
const { exec } = require("child_process"); // Importation pour FFmpeg

const groq = new Groq({ apiKey: "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" });
const openai = new OpenAI({ apiKey: "YOUR_OPENAI_API_KEY" }); // REMPLACEZ PAR VOTRE CLÉ API OPENAI

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

// Créer le dossier 'media' si il n'existe pas
if (!fs.existsSync('./media')) {
    fs.mkdirSync('./media', { recursive: true });
}

// Fonction utilitaire pour encoder une image en base64
function encodeImageToBase64(imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
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
        console.log(JSON.stringify(m, undefined, 2));
        if (m.messages[0].key.fromMe) return; // Ignore messages sent by the bot itself

        const message = m.messages[0];
        const remoteJid = message.key.remoteJid;

        // Vérifier si le bot est activé/désactivé
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
            return; // Si le bot est désactivé, ne pas traiter davantage
        }

        // --- Nouvelle logique pour gérer les messages multimédias ---
        if (message.message?.imageMessage) {
            const imageMessage = message.message.imageMessage;
            const caption = imageMessage.caption; // Légende de l'image, si présente
            const mimetype = imageMessage.mimetype;

            console.log(`Image reçue avec légende : ${caption || 'Aucune'}`);
            await sock.sendMessage(remoteJid, { text: "J'ai bien reçu votre image ! Laissez-moi l'analyser..." });

            try {
                const buffer = await downloadMediaMessage(message, 'buffer');
                const filePath = `./media/${message.key.id}.${mimetype.split('/')[1]}`;
                fs.writeFileSync(filePath, buffer);
                console.log(`Image téléchargée et sauvegardée : ${filePath}`);

                // --- Appeler l'API de Vision par Ordinateur (Exemple avec OpenAI GPT-4o) ---
                const base64Image = encodeImageToBase64(filePath);
                const response = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Décris cette image en détail." },
                                { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64Image}` } },
                            ],
                        },
                    ],
                });
                const imageDescription = response.choices[0].message.content;

                console.log(`Description de l'image : ${imageDescription}`);

                // --- Envoyer la description à Groq et obtenir la réponse ---
                const promptForGroq = `L'utilisateur a envoyé une image. Voici sa description : "${imageDescription}". Réponds de manière amicale à cette image.`;
                const chatCompletion = await groq.chat.completions.create({
                    messages: [
                        {
                            role: "system",
                            content: "Tu es Moussa, un assistant amical. Tu réponds aux utilisateurs en te basant sur le contenu des images qu'ils partagent.",
                        },
                        {
                            role: "user",
                            content: promptForGroq,
                        },
                    ],
                    model: "llama-3.3-70b-versatile",
                });
                const groqResponse = chatCompletion.choices[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse concernant cette image.";
                await sock.sendMessage(remoteJid, { text: groqResponse });

            } catch (error) {
                console.error("Erreur lors du traitement de l'image :", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors du traitement de votre image." });
            }

        } else if (message.message?.videoMessage) {
            const videoMessage = message.message.videoMessage;
            const caption = videoMessage.caption;
            const mimetype = videoMessage.mimetype;

            console.log(`Vidéo reçue avec légende : ${caption || 'Aucune'}`);
            await sock.sendMessage(remoteJid, { text: "J'ai bien reçu votre vidéo ! Laissez-moi la regarder..." });

            try {
                const buffer = await downloadMediaMessage(message, 'buffer');
                const videoPath = `./media/${message.key.id}.${mimetype.split('/')[1]}`;
                fs.writeFileSync(videoPath, buffer);
                console.log(`Vidéo téléchargée et sauvegardée : ${videoPath}`);

                // --- Extraire les images clés avec FFmpeg ---
                const outputDir = `./media/video_frames/${message.key.id}`;
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }
                const command = `ffmpeg -i ${videoPath} -vf "fps=1/10" ${outputDir}/${message.key.id}-frame-%03d.png`;
                
                await new Promise((resolve, reject) => {
                    exec(command, async (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Erreur lors de l'extraction des images : ${error.message}`);
                            reject(error);
                            return;
                        }
                        console.log(`Images extraites pour la vidéo : ${videoPath}`);

                        // --- Analyser les images clés et synthétiser ---
                        const frameFiles = fs.readdirSync(outputDir).filter(file => file.startsWith(`${message.key.id}-frame-`));
                        let videoDescriptions = [];

                        for (const frameFile of frameFiles) {
                            const framePath = `${outputDir}/${frameFile}`;
                            const base64Frame = encodeImageToBase64(framePath);
                            const frameResponse = await openai.chat.completions.create({
                                model: "gpt-4o",
                                messages: [
                                    {
                                        role: "user",
                                        content: [
                                            { type: "text", text: "Décris cette image en détail." },
                                            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Frame}` } },
                                        ],
                                    },
                                ],
                            });
                            videoDescriptions.push(frameResponse.choices[0].message.content);
                        }

                        const videoSummary = `La vidéo contient les éléments suivants : ${videoDescriptions.join(" ")}`;
                        console.log(`Résumé de la vidéo : ${videoSummary}`);

                        // --- Envoyer le résumé à Groq et obtenir la réponse ---
                        const promptForGroq = `L'utilisateur a envoyé une vidéo. Voici un résumé de son contenu : "${videoSummary}". Réponds de manière amicale à cette vidéo.`;
                        const chatCompletion = await groq.chat.completions.create({
                            messages: [
                                {
                                    role: "system",
                                    content: "Tu es Moussa, un assistant amical. Tu réponds aux utilisateurs en te basant sur le contenu des vidéos qu'ils partagent.",
                                },
                                {
                                    role: "user",
                                    content: promptForGroq,
                                },
                            ],
                            model: "llama-3.3-70b-versatile",
                        });
                        const groqResponse = chatCompletion.choices[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse concernant cette vidéo.";
                        await sock.sendMessage(remoteJid, { text: groqResponse });
                        resolve();
                    });
                });

            } catch (error) {
                console.error("Erreur lors du traitement de la vidéo :", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors du traitement de votre vidéo." });
            }

        } else if (message.message?.documentMessage) {
            const documentMessage = message.message.documentMessage;
            const filename = documentMessage.fileName;
            const mimetype = documentMessage.mimetype;

            console.log(`Document reçu : ${filename} (${mimetype})`);
            await sock.sendMessage(remoteJid, { text: `J'ai bien reçu le document '${filename}' !` });

            try {
                const buffer = await downloadMediaMessage(message, 'buffer');
                const filePath = `./media/${message.key.id}.${filename.split('.').pop()}`;
                fs.writeFileSync(filePath, buffer);
                console.log(`Document téléchargé et sauvegardé : ${filePath}`);
            } catch (error) {
                console.error("Erreur lors du téléchargement du document :", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors du téléchargement du document." });
            }

        } else if (message.message?.audioMessage) {
            const audioMessage = message.message.audioMessage;
            const mimetype = audioMessage.mimetype;

            console.log(`Audio reçu (${mimetype})`);
            await sock.sendMessage(remoteJid, { text: "J'ai bien reçu votre message audio. Laissez-moi l'écouter..." });

            try {
                const buffer = await downloadMediaMessage(message, 'buffer');
                const filePath = `./media/${message.key.id}.${mimetype.split('/')[1]}`;
                fs.writeFileSync(filePath, buffer);
                console.log(`Audio téléchargé et sauvegardé : ${filePath}`);

                // --- Appeler l'API Speech-to-Text (Exemple avec OpenAI Whisper) ---
                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(filePath),
                    model: "whisper-1",
                });
                const transcribedText = transcription.text;

                console.log(`Transcription audio : ${transcribedText}`);

                // --- Envoyer la transcription à Groq et obtenir la réponse ---
                const chatCompletion = await groq.chat.completions.create({
                    messages: [
                        {
                            role: "system",
                            content: "Tu es Moussa, un assistant amical. Tu as transcrit un message vocal et tu dois y répondre intelligemment. Ne mentionne pas que c'était un message vocal, réponds comme si c'était du texte.",
                        },
                        {
                            role: "user",
                            content: transcribedText,
                        },
                    ],
                    model: "llama-3.3-70b-versatile",
                });
                const groqResponse = chatCompletion.choices[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse à votre message vocal.";
                await sock.sendMessage(remoteJid, { text: groqResponse });

            } catch (error) {
                console.error("Erreur lors du traitement de l'audio :", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors du traitement de votre message audio." });
            }

        } else if (text) {
            // --- Logique existante pour les messages texte ---
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
                await sock.sendMessage(remoteJid, { text: groqResponse });
            } catch (error) {
                console.error("Erreur lors de l'appel à l'API Groq:", error);
                await sock.sendMessage(remoteJid, { text: "Désolé, une erreur est survenue lors de la communication avec l'API Groq." });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();


