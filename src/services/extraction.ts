
import { createWorker } from 'tesseract.js';
import axios from 'axios';
import mammoth from 'mammoth';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Audio Transcription Service
export async function transcribeAudio(fileUrl: string): Promise<string> {
    console.log(`[Transcription] Processing audio: ${fileUrl}`);
    try {
        // 1. Download Audio File
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        // 2. Save to temp file (OpenAI SDK requires file path or ReadStream)
        const tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.mp3`);
        fs.writeFileSync(tempFilePath, buffer);

        // 3. Transcribe using Whisper
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: "whisper-1",
        });

        // 4. Cleanup
        fs.unlinkSync(tempFilePath);

        console.log(`[Transcription] Success: ${transcription.text.length} chars`);
        return transcription.text;

    } catch (error) {
        console.error("[Transcription] Failed:", error);
        return `Error transcribing audio: ${(error as any).message}`;
    }
}


// Text Extraction Service
export async function extractTextFromDocument(fileUrlOrPath: string, mimeType: string): Promise<string> {
    console.log(`[Extraction] Processing ${fileUrlOrPath} (${mimeType})...`);

    try {
        // 1. Fetch File Buffer (if URL) - no timeout, let it complete
        let buffer: Buffer;
        if (fileUrlOrPath.startsWith('http')) {
            const res = await axios.get(fileUrlOrPath, {
                responseType: 'arraybuffer',
                maxContentLength: 20 * 1024 * 1024, // 20MB max
                timeout: 15000 // 15 second timeout for download
            });
            buffer = Buffer.from(res.data);
            console.log(`[Extraction] Downloaded ${buffer.length} bytes`);
        } else {
            return "Local file path extraction not supported.";
        }

        // 2. Select Strategy
        if (mimeType.includes('pdf')) {
            console.log('[Extraction] Parsing PDF...');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pdf = require('pdf-parse');
            const data = await pdf(buffer);
            console.log(`[Extraction] PDF parsed: ${data.text.length} chars`);
            // Limit text to 30K and sanitize for Telegram
            const text = data.text.substring(0, 30000).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            return text;

        } else if (mimeType.includes('word') || mimeType.includes('officedocument')) {
            console.log('[Extraction] Using Mammoth (Docx)...');
            const result = await mammoth.extractRawText({ buffer });
            return result.value;

        } else if (mimeType.startsWith('image')) {
            console.log('[Extraction] Using Tesseract OCR...');
            const worker = await createWorker('eng');
            const ret = await worker.recognize(fileUrlOrPath); // Tesseract accepts URLs/Buffers
            await worker.terminate();
            return ret.data.text;

        } else {
            return `[System] Unsupported file type: ${mimeType}. Please upload PDF, Word, or Image.`;
        }

    } catch (error) {
        console.error("Extraction Failed:", error);
        return `Error extracting text: ${(error as any).message}`;
    }
}
