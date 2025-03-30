// Import Modul
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const qrcode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

// Promisify FS
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

// Konfigurasi
const SESSION_DIR = './auth_info_baileys';
const TEMP_DIR = './temp';
const STICKER_TEMP_DIR = "./temp_stickers";
const FONT_DIR = path.join(__dirname, 'fonts');
const MAX_VIDEO_SIZE_GROUP = 10 * 1024 * 1024; // 10MB
const GROUP_COOLDOWN = 5000; // 5 detik

let stickerConfig = {
    author: 'MICSY-xyz',
    packname: 'WhatsApp Sticker',
};
let isConnected = false;
const rateLimitMap = new Map();

// Fungsi Wajib
async function ensureDirectoryExists(directory) {
    try {
        await mkdirAsync(directory, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

async function createExif() {
    const jsonData = JSON.stringify({
        'sticker-pack-id': `com.whatsapp.sticker.${Date.now()}`,
        'sticker-pack-name': stickerConfig.packname,
        'sticker-pack-publisher': stickerConfig.author,
    });
    const buffer = Buffer.concat([
        Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]),
        Buffer.from(jsonData)
    ]);
    await writeFileAsync('./temp/exif.exif', buffer);
    console.log('✓ EXIF metadata updated');
}

// Rate Limiter
async function checkRateLimit(sender) {
    const now = Date.now();
    const lastExecuted = rateLimitMap.get(sender) || 0;
    
    if (now - lastExecuted < GROUP_COOLDOWN) {
        return false;
    }
    rateLimitMap.set(sender, now);
    return true;
}

// Cleanup Temp Files
async function cleanupTempFiles() {
    try {
        const files = await fs.promises.readdir('./temp');
        const now = Date.now();
        await Promise.all(files.map(async file => {
            const filePath = path.join('./temp', file);
            const stats = await fs.promises.stat(filePath);
            if (now - stats.mtimeMs > 3600000) { // 1 jam
                await unlinkAsync(filePath).catch(console.error);
            }
        }));
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Download Media
async function downloadMedia(message, mimetype) {
    let buffer = Buffer.from([]);
    const stream = await downloadContentFromMessage(message, mimetype);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

// Fungsi untuk membuat stiker dari file gambar atau video (improved version)
async function createSticker(inputPath, outputPath, isAnimated = false) {
    return new Promise((resolve, reject) => {
        let ffmpegCommand;

      if (isAnimated) {
            ffmpegCommand = `ffmpeg -i "${inputPath}" -vf "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,fps=15" -c:v libwebp -lossless 1 -q:v 80 -loop 0 -preset default -an -vsync 0 -s 512x512 "${outputPath}"`;
        } else {
            ffmpegCommand = `ffmpeg -i "${inputPath}" -vf "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,format=rgba" -c:v libwebp -frames:v 1 "${outputPath}"`;
        }

        exec(ffmpegCommand, (error) => {
            if (error) {
                console.error('FFmpeg error:', error);
                reject(error);
                return;
            }
            resolve();
        });
    });
}

// Fungsi untuk membuat stiker teks dengan ukuran besar
async function createLargeTextSticker(text, outputPath) {
    const scriptPath = `./temp/text_sticker_${Date.now()}.py`;
    
    const pythonScript = `
import sys
import os
from PIL import Image, ImageDraw, ImageFont

def get_font_path(filename):
    possible_paths = [
        os.path.join(os.getcwd(), 'fonts', filename),
        os.path.join(os.path.dirname(sys.argv[0]), 'fonts', filename),
        '/usr/share/fonts/truetype/msttcorefonts/' + filename,
        'C:/Windows/Fonts/' + filename
    ]
    for path in possible_paths:
        if os.path.exists(path):
            return path
    return None

def create_text_sticker(text, output_path):
    try:
        img_size = 512
        img = Image.new('RGBA', (img_size, img_size), (255, 255, 255))
        draw = ImageDraw.Draw(img)

        # Use a large fixed font size for better readability
        font_size = 80
        line_spacing = 5
        
        # Load font (use a bold font for better visibility)
        font_path = get_font_path('Boogaloo.ttf') or get_font_path('Boogaloo_Bold.ttf')
        try:
            font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
        except:
            font = ImageFont.load_default()

        # Split text into lines
        lines = text.split('\\n')
        if not lines:
            lines = [text]

        # Calculate total text height
        total_height = (font_size * len(lines)) + (line_spacing * (len(lines) - 1))
        
        # Draw each line centered
        y_pos = (img_size - total_height) // 2
        
        for line in lines:
            if not line.strip():
                y_pos += font_size + line_spacing
                continue
                
            text_width = font.getlength(line)
            x_pos = (img_size - text_width) // 2

            # Draw main text (white)
            draw.text((x_pos, y_pos), line, font=font, fill=(0, 0, 0))
            
            y_pos += font_size + line_spacing

        # Save as WebP with high quality
        img.save(output_path, "WEBP", quality=100)
        print(output_path)

    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    create_text_sticker(sys.argv[1], sys.argv[2])
`;

    await writeFileAsync(scriptPath, pythonScript);

    return new Promise((resolve, reject) => {
        exec(`python "${scriptPath}" "${text}" "${outputPath}"`, async (error, stdout, stderr) => {
            try {
                await unlinkAsync(scriptPath);
                if (error) {
                    console.error('Python Error:', stderr);
                    reject(`Sticker generation failed: ${stderr || error.message}`);
                    return;
                }
                
                const outputFile = stdout.trim();
                if (!fs.existsSync(outputFile)) {
                    reject('Output file not created');
                    return;
                }
                
                resolve(outputFile);
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Konversi Teks ke Voice Note
async function textToSpeech(text) {
    return new Promise((resolve, reject) => {
        const safeText = text.replace(/"/g, '\\"');
        const outputPath = `./temp/voice_${Date.now()}.mp3`;
        exec(`gtts-cli "${safeText}" --output "${outputPath}" --lang id`, (error) => {
            if (error) reject(error);
            else resolve(outputPath);
        });
    });
}

// Fungsi AI Chat
const packageData = require('./package.json');
let currentApiIndex = 0;

function getApiKeys() {
    return packageData.config.api_keys || [];
}

async function askAIMLAPI(question) {
    try {
        const apiKey = getApiKeys()[currentApiIndex];
        currentApiIndex = (currentApiIndex + 1) % getApiKeys().length;

        const response = await axios.post(
            packageData.config.api_url || 'https://api.openai.com/v1/chat/completions',
            {
                model: packageData.config.model || 'gpt-3.5-turbo',
                messages: [{ role: "user", content: question }],
                max_tokens: 512
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                }
            }
        );

        return response.data?.choices?.[0]?.message?.content || "Tidak mendapatkan jawaban";
    } catch (error) {
        console.error("AI Error:", error.message);
        throw new Error("Gagal memproses pertanyaan");
    }
}

// Fungsi untuk membuat stiker dengan teks overlay (support animated)
async function createStickerWithText(inputPath, outputPath, isAnimated = false, topText = '', bottomText = '') {
    const scriptPath = `./temp/sticker_script_${Date.now()}.py`;
    
    try {
        // Convert JavaScript boolean to Python boolean string
        const pyIsAnimated = isAnimated ? 'True' : 'False';

        const pythonScript = `
import sys
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageSequence

def get_font_path(filename='Boogaloo.ttf'):
    possible_paths = [
        os.path.join(os.getcwd(), 'fonts', filename),
        os.path.join(os.path.dirname(sys.argv[0]), 'fonts', filename),
        '/usr/share/fonts/truetype/msttcorefonts/' + filename,
        'C:/Windows/Fonts/' + filename
    ]
    for path in possible_paths:
        if os.path.exists(path):
            return path
    return None

def add_text_to_image(img, top_text, bottom_text):
    draw = ImageDraw.Draw(img)
    font_size = 70
    stroke_width = 2
    
    try:
        font_path = get_font_path()
        font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default()
    except:
        font = ImageFont.load_default()

    def draw_text(text, y_pos):
        text_width = font.getlength(text)
        x_pos = (img.width - text_width) // 2
        
        # Better outline approach - draw text with a stroke
        # Use PIL's built-in stroke feature if available (newer PIL versions)
        try:
            # Try the newer stroke parameter method (PIL 9.2.0+)
            draw.text((x_pos, y_pos), text, font=font, fill=(255,255,255,255), 
                      stroke_width=stroke_width, stroke_fill=(0,0,0,255))
        except TypeError:
            # Fallback to manual outline for older PIL versions
            # Use a more precise outline approach
            directions = [
                (-1, -1), (0, -1), (1, -1),
                (-1, 0),           (1, 0),
                (-1, 1),  (0, 1),  (1, 1)
            ]
            # Draw outline (black)
            for dx, dy in directions:
                draw.text((x_pos + dx, y_pos + dy), text, font=font, fill=(0,0,0,255))
            # Draw main text (white)
            draw.text((x_pos, y_pos), text, font=font, fill=(255,255,255,255))
    
    if top_text:
        draw_text(top_text, 30)
    if bottom_text:
        draw_text(bottom_text, img.height - 100)
    
    return img

try:
    is_animated = ${pyIsAnimated}
    
    if is_animated:
        # Step 1: Convert video to temporary WebP using FFmpeg (without text)
        temp_path = os.path.join(os.path.dirname(r"${outputPath.replace(/\\/g, '\\\\')}"), f"temp_{os.path.basename(r"${outputPath.replace(/\\/g, '\\\\')}")}")
        
        ffmpeg_cmd = [
            'ffmpeg',
            '-i', r"${inputPath.replace(/\\/g, '\\\\')}",
            '-vf', "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,fps=10",
            '-c:v', 'libwebp',
            '-q:v', '90',
            '-loop', '0',
            '-preset', 'default',
            '-an',
            '-vsync', '0',
            temp_path
        ]
        subprocess.run(ffmpeg_cmd, check=True)
        
        # Step 2: Add text using Pillow (frame by frame)
        frames = []
        with Image.open(temp_path) as img:
            for frame in ImageSequence.Iterator(img):
                frame = frame.convert("RGBA")
                frame = add_text_to_image(frame, "${topText.replace(/"/g, '\\"')}", "${bottomText.replace(/"/g, '\\"')}")
                frames.append(frame)
            
            # Save as animated WebP
            frames[0].save(
                r"${outputPath.replace(/\\/g, '\\\\')}",
                save_all=True,
                append_images=frames[1:],
                duration=img.info.get('duration', 100),
                loop=0,
                quality=80
            )
        
        # Cleanup temp file
        os.remove(temp_path)
        
    else:
        # Process static image with Pillow
        img = Image.open(r"${inputPath.replace(/\\/g, '\\\\')}").convert("RGBA")
        img = ImageOps.fit(img, (512, 512), method=Image.LANCZOS)
        img = add_text_to_image(img, "${topText.replace(/"/g, '\\"')}", "${bottomText.replace(/"/g, '\\"')}")
        img.save(r"${outputPath.replace(/\\/g, '\\\\')}", format="WEBP", quality=95)
    
    print(r"${outputPath.replace(/\\/g, '\\\\')}")

except Exception as e:
    print(f"Error: {str(e)}", file=sys.stderr)
    sys.exit(1)
`;

        await writeFileAsync(scriptPath, pythonScript);

        const { stdout, stderr } = await new Promise((resolve, reject) => {
            exec(`python "${scriptPath}"`, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Python Error: ${stderr || error.message}`));
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });

        const outputFile = stdout.trim();
        if (!fs.existsSync(outputFile)) {
            throw new Error('Output sticker file was not created');
        }

        return outputFile;

    } catch (error) {
        console.error('Error in createStickerWithText:', error);
        throw new Error(`Failed to create sticker: ${error.message}`);
    } finally {
        if (fs.existsSync(scriptPath)) {
            await unlinkAsync(scriptPath).catch(console.error);
        }
    }
}

// Handler Command
async function handleIncomingMessage(sock, msg) {
    if (!msg.message) return;
    
    const sender = msg.key.remoteJid;
    const isGroup = sender.endsWith('@g.us');
    const messageType = Object.keys(msg.message)[0];
    const content = msg.message[messageType];
    let text = messageType === 'conversation' ? content : 
              (messageType === 'extendedTextMessage' ? content.text : '');

    try {
        // Rate Limit Check
        if (isGroup && !(await checkRateLimit(sender))) {
            await sock.sendMessage(sender, {
                text: '⏳ Terlalu banyak request! Tunggu 5 detik.'
            });
            return;
        }

        // HANDLER COMMAND .ask
        if (text.startsWith('.ask ')) {
            const question = text.substring(5).trim();
            
            if (!question) {
                await sock.sendMessage(sender, { text: "Contoh penggunaan: .ask Apa itu JavaScript?" }, { quoted: msg });
                return;
            }

            try {
                await sock.sendMessage(sender, { text: "🔍 Mencari jawaban..." }, { quoted: msg });
                const answer = await askAIMLAPI(question);
                await sock.sendMessage(sender, { text: answer }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(sender, { text: `❌ Error: ${error.message}` }, { quoted: msg });
            }
            return;
        }

        // HANDLER COMMAND .stk
        if (text.startsWith('.stk')) {
            try {
                let mediaToConvert = null;
                let textToConvert = null;
                let topText = '';
                let bottomText = '';
                let isAnimated = false;
                let isQuoted = false;
                let isDirectText = false;

                // Check if it's direct text command (.stk text)
                if (text.startsWith('.stk ') && text.length > 5 && !msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    isDirectText = true;
                    textToConvert = text.substring(4).trim();
                } else {
                    // Parse command for text positioning
                    const commandText = text.substring(4).trim();
                    const textParts = commandText.split('|').map(part => part.trim());
                    
                    if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        isQuoted = true;
                        const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
                        const quotedType = Object.keys(quotedMsg)[0];
                        
                        if (quotedType === 'imageMessage' || quotedType === 'videoMessage') {
                            mediaToConvert = quotedMsg[quotedType];
                            isAnimated = quotedType === 'videoMessage';
                            
                            // Handle text positioning
                            if (textParts.length === 1 && textParts[0]) {
                                topText = textParts[0];
                            } else if (textParts.length === 2) {
                                if (textParts[0]) topText = textParts[0];
                                if (textParts[1]) bottomText = textParts[1];
                            }
                        } 
                        else if (quotedType === 'conversation' || quotedType === 'extendedTextMessage') {
                            textToConvert = quotedMsg[quotedType]?.text || quotedMsg[quotedType];
                        }
                    } else if (msg.message.imageMessage || msg.message.videoMessage) {
                        mediaToConvert = msg.message.imageMessage || msg.message.videoMessage;
                        isAnimated = !!msg.message.videoMessage;
                        
                        // Handle text positioning
                        if (textParts.length === 1 && textParts[0]) {
                            topText = textParts[0];
                        } else if (textParts.length === 2) {
                            if (textParts[0]) topText = textParts[0];
                            if (textParts[1]) bottomText = textParts[1];
                        }
                    }
                }

                // Handle media conversion (with optional text overlay)
                if (mediaToConvert) {
                    await sock.sendMessage(sender, { 
                        text: isAnimated ? '⏳ Membuat stiker animasi...' : '⏳ Membuat stiker...' 
                    }, { quoted: msg });
                    
                    const buffer = await downloadMedia(mediaToConvert, mediaToConvert.mimetype.split('/')[0]);
                    const inputPath = `./temp/input_${Date.now()}.${mediaToConvert.mimetype.split('/')[1]}`;
                    const outputPath = `./temp/sticker_${Date.now()}.webp`;
                    
                    await writeFileAsync(inputPath, buffer);
                    
                    if (topText || bottomText) {
                        await createStickerWithText(inputPath, outputPath, isAnimated, topText, bottomText);
                    } else {
                        await createSticker(inputPath, outputPath, isAnimated);
                    }
                    
                    const stickerData = await readFileAsync(outputPath);
                    
                    await sock.sendMessage(sender, 
                        { 
                            sticker: isAnimated ? 
                                { url: outputPath, animated: true } : 
                                stickerData 
                        }, 
                        { quoted: msg }
                    );
                    
                    await Promise.all([
                        unlinkAsync(inputPath).catch(console.error),
                        unlinkAsync(outputPath).catch(console.error)
                    ]);
                } 
                // Handle text conversion (both quoted and direct text)
                else if (textToConvert) {
                    if (!textToConvert.trim()) {
                        await sock.sendMessage(sender, { text: '⚠️ Mohon berikan teks yang valid!' }, { quoted: msg });
                        return;
                    }
                    
                    await sock.sendMessage(sender, { 
                        text: '⏳ Membuat stiker teks...' 
                    }, { quoted: msg });
                    
                    const outputPath = `./temp/text_sticker_${Date.now()}.webp`;
                    await createLargeTextSticker(textToConvert, outputPath);
                    
                    const stickerData = await readFileAsync(outputPath);
                    await sock.sendMessage(sender, { sticker: stickerData }, { quoted: msg });
                    await unlinkAsync(outputPath).catch(console.error);
                } else {
                    // Show help if no valid input
                    await sock.sendMessage(sender, { 
                        text: '💡 Cara menggunakan:\n' +
                              '• `.stk` teks - Buat stiker dari teks\n' +
                              '• `.stk` - Balas gambar/video untuk membuat stiker\n' +
                              '• `.stk` teks| - Tambahkan teks atas\n' +
                              '• `.stk` |teks - Tambahkan teks bawah\n' +
                              '• `.stk` atas|bawah - Tambahkan teks atas dan bawah'
                    }, { quoted: msg });
                }
            } catch (error) {
                console.error('Error membuat stiker:', error);
                await sock.sendMessage(sender, { 
                    text: '❌ Gagal membuat stiker: ' + (error.message || 'Internal error') + 
                         '\n\nPastikan:\n1. Python & Pillow terinstall\n2. Font Boogaloo.ttf ada di folder fonts'
                }, { quoted: msg });
            }
            return;
        }

        // HANDLER COMMAND .menu
        if (text === '.menu') {
            await sock.sendMessage(sender, { 
                text: `
🤖 *SmartBOT Menu* 🤖  

🛠 *Fitur BOT:*  
• *\`.stk\`* + reply gambar/video → Buat stiker  
• *\`.stk\`* + reply teks → Stiker teks (kualitas tinggi)  
• *\`.vn halo dunia\`* → Voice note  
• *\`.ask pertanyaan\`* → Tanya ke AI  
• *\`.qr teks\`* → Buat QR code  

📌 *Contoh:*  
1. Balas gambar, ketik \`.stk\`  
2. Ketik \`.vn selamat pagi\`
3. Ketik \`.ask Apa itu Korupsi?\`

🚀 MICSY-xyz | *Innovating the Future*
                `.trim(),
                footer: 'Gunakan command tanpa tanda petik (`)'
            }, { quoted: msg });
            return;
        }

        // HANDLER COMMAND .qr
        if (text.startsWith('.qr ')) {
            const content = text.slice(4).trim();
            
            if (!content) {
                await sock.sendMessage(sender, { 
                    text: '⚠️ Contoh penggunaan: *.qr Hello World*' 
                }, { quoted: msg });
                return;
            }

            if (content.length > 500) {
                await sock.sendMessage(sender, { 
                    text: '❌ Teks terlalu panjang (max 500 karakter)' 
                }, { quoted: msg });
                return;
            }

            try {
                await sock.sendMessage(sender, { 
                    text: '🔄 Membuat QR code...' 
                }, { quoted: msg });

                const qrPath = `./temp/qr_${Date.now()}.png`;
                
                await qrcode.toFile(qrPath, content, {
                    width: 500,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#ffffff'
                    }
                });

                const qrBuffer = await readFileAsync(qrPath);
                await sock.sendMessage(sender, { 
                    image: qrBuffer,
                    caption: `QR Code untuk:\n"${content}"`,
                    footer: 'Bot by MICSY-xyz'
                }, { quoted: msg });

                await unlinkAsync(qrPath);

            } catch (error) {
                console.error('QR Error:', error);
                await sock.sendMessage(sender, { 
                    text: '❌ Gagal membuat QR code' 
                }, { quoted: msg });
            }
            return;
        }

        // HANDLER COMMAND .vn
        if (text.startsWith('.vn ')) {
            const inputText = text.slice(4).trim();
            
            // Validasi input
            if (!inputText) {
                await sock.sendMessage(sender, {
                    text: '⚠️ Contoh: .vn halo dunia'
                }, { quoted: msg });
                return;
            }

            // Batasi panjang teks di grup
            if (isGroup && inputText.length > 100) {
                await sock.sendMessage(sender, {
                    text: '❌ Maksimal 100 karakter di grup'
                }, { quoted: msg });
                return;
            }

            try {
                await sock.sendMessage(sender, {
                    text: '🔊 Memproses voice note...'
                }, { quoted: msg });

                // Konversi teks ke suara
                const voicePath = await textToSpeech(inputText);
                const voiceData = await readFileAsync(voicePath);

                // Kirim voice note
                await sock.sendMessage(sender, { 
                    audio: voiceData,
                    mimetype: 'audio/mpeg',
                    ptt: true,
                    waveform: [0,99,0,99,0,99,0,99]
                }, { quoted: msg });

                // Bersihkan file
                await unlinkAsync(voicePath).catch(console.error);

            } catch (error) {
                console.error('VN Error:', error);
                let errorMsg = '❌ Gagal membuat voice note';
                if (error.message.includes('ENOENT')) {
                    errorMsg += '\n⚠️ Pastikan gTTS terinstall: \n`pkg install python && pip install gTTS`';
                }
                await sock.sendMessage(sender, {
                    text: errorMsg
                }, { quoted: msg });
            }
            return;
        }

    } catch (error) {
        // Global Error Handler
        console.error('⚠️ Global Error:', error);
        await sock.sendMessage(sender, {
            text: '❌ Terjadi kesalahan sistem. Silakan coba beberapa saat lagi.'
        }).catch(e => console.error('Gagal mengirim notifikasi error:', e));
    }
}

// Fungsi Koneksi WhatsApp
async function connectWhatsApp() {
    try {
        // Persiapan direktori
        await ensureDirectoryExists(TEMP_DIR);
        await ensureDirectoryExists(SESSION_DIR);
        await ensureDirectoryExists(STICKER_TEMP_DIR);
        await ensureDirectoryExists(FONT_DIR);
        await createExif();

        // Inisialisasi koneksi
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ["Chrome", "Linux", "4.0.0"],
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 30000,
            getMessage: async (key) => {
                return {
                    conversation: "Hello, I'm your WhatsApp bot!"
                }
            }
        });

        // Event Handlers
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (connection === 'open') {
                console.log('✓ Connected to WhatsApp');
                isConnected = true;
                // Jadwal cleanup setiap 1 jam
                setInterval(cleanupTempFiles, 3600000);
                
                // Periksa dependensi yang diperlukan
                checkDependencies().catch(console.error);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(shouldReconnect ? '⌛ Reconnecting...' : '❌ Session expired');
                if (shouldReconnect) {
                    setTimeout(connectWhatsApp, 5000);
                }
            }
            
            if (qr) {
                console.log('Scan QR code above to connect');
            }
        });

        // Handler pesan masuk
        sock.ev.on('messages.upsert', ({ messages }) => {
            const message = messages[0];
            if (!message.key.fromMe) {
                handleIncomingMessage(sock, message).catch(e => {
                    console.error('Message handling error:', e);
                });
            }
        });

        // Handler untuk update status koneksi
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'connecting') {
                console.log('⌛ Connecting to WhatsApp...');
            }
        });

    } catch (error) {
        console.error('⚠️ Connection Error:', error);
        setTimeout(connectWhatsApp, 10000); // Reconnect after 10 seconds
    }
}

// Fungsi untuk memeriksa dependensi yang diperlukan
async function checkDependencies() {
    try {
        // Periksa apakah Python terinstall
        await new Promise((resolve, reject) => {
            exec('python --version', (error) => {
                if (error) {
                    console.warn('⚠️ Python tidak terinstall. Stiker teks mungkin tidak berfungsi.');
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        // Periksa apakah Pillow terinstall
        await new Promise((resolve, reject) => {
            exec('python -c "import PIL"', (error) => {
                if (error) {
                    console.warn('⚠️ Python Pillow library tidak terinstall. Stiker teks mungkin tidak berfungsi.');
                    console.info('💡 Install dengan: pip install pillow');
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        // Periksa font yang diperlukan
        const requiredFonts = ['Boogaloo.ttf', 'NotoEmoji.ttf'];
        for (const font of requiredFonts) {
            const fontPath = path.join(FONT_DIR, font);
            if (!fs.existsSync(fontPath)) {
                console.warn(`⚠️ Font ${font} tidak ditemukan di direktori fonts.`);
                console.info(`💡 Letakkan file font ${font} di folder fonts/`);
            }
        }

    } catch (error) {
        // Error sudah ditangani dalam promise
    }
}

// Banner & Startup
console.log(`
\x1b[36m
╔══╗╔═══╦════╗──╔╗╔╗╔╦╗─╔╦═══╦════╦═══╦═══╦═══╦═══╗
║╔╗║║╔═╗║╔╗╔╗║──║║║║║║║─║║╔═╗║╔╗╔╗║╔═╗║╔═╗║╔═╗║╔═╗║
║╚╝╚╣║─║╠╝║║╚╝──║║║║║║╚═╝║║─║╠╝║║╚╣╚══╣║─║║╚═╝║╚═╝║
║╔═╗║║─║║─║║────║╚╝╚╝║╔═╗║╚═╝║─║║─╚══╗║╚═╝║╔══╣╔══╝
║╚═╝║╚═╝║─║║────╚╗╔╗╔╣║─║║╔═╗║─║║─║╚═╝║╔═╗║║──║║   
╚═══╩═══╝─╚╝─────╚╝╚╝╚╝─╚╩╝─╚╝─╚╝─╚═══╩╝─╚╩╝──╚╝   
       || AUTHOR : MICSY-xyz || 
\x1b[0m`);

// Mulai bot dengan error handling
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled Rejection:', err);
});

// Jalankan bot
connectWhatsApp().catch(err => {
    console.error('❌ Failed to initialize:', err);
    process.exit(1);
});
