#!/usr/bin/env node
/**
 * Downloads all files needed for offline audio (sound) classification:
 *
 *   1. speech-commands@0.5.4 UMD bundle  → external-resources/libs/speech-commands.min.js
 *   2. BROWSER_FFT base model files      → external-resources/models/speech-commands-browser-fft/
 *
 * Run once before building the installer:
 *   node scripts/download-speech-commands.js
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const EXT = path.resolve(__dirname, '..', 'external-resources');

/* ── 1. speech-commands UMD library ── */
const LIB_URL  = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.5.4/dist/speech-commands.min.js';
const LIB_DEST = path.join(EXT, 'libs', 'speech-commands.min.js');

/* ── 2. BROWSER_FFT model files ── */
const MODEL_BASE = 'https://storage.googleapis.com/tfjs-models/tfjs/speech-commands/v0.5/browser_fft/18w/';
const MODEL_DEST = path.join(EXT, 'models', 'speech-commands-browser-fft');
const MODEL_FILES = ['metadata.json', 'model.json', 'group1-shard1of2', 'group1-shard2of2'];

function download (url, dest) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            process.stdout.write(`  [skip] ${path.basename(dest)}\n`);
            return resolve();
        }
        process.stdout.write(`  [dl]   ${path.basename(dest)} … `);
        fs.mkdirSync(path.dirname(dest), {recursive: true});
        const file = fs.createWriteStream(dest);
        https.get(url, res => {
            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => {
                process.stdout.write(`done (${fs.statSync(dest).size} bytes)\n`);
                resolve();
            }));
        }).on('error', err => {
            file.close();
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            reject(err);
        });
    });
}

(async () => {
    console.log('=== Downloading speech-commands library ===');
    await download(LIB_URL, LIB_DEST);

    console.log('\n=== Downloading BROWSER_FFT base model ===');
    for (const f of MODEL_FILES) {
        await download(MODEL_BASE + f, path.join(MODEL_DEST, f));
    }

    console.log('\nDone. Audio classification assets are ready for bundling.');
})().catch(err => {
    console.error('\nDownload failed:', err.message);
    process.exit(1);
});
