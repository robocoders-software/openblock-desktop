#!/usr/bin/env node
/**
 * Downloads MobileNetV1 (alpha=0.25, input=224) TF.js model files
 * from the public GCS bucket into external-resources/models/mobilenet_v1_0.25_224/
 * so the resource server (port 20112) can serve them locally.
 *
 * Usage:  node scripts/download-mobilenet.js
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL = 'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/';
const DEST_DIR = path.resolve(__dirname, '..', 'external-resources', 'models', 'mobilenet_v1_0.25_224');

const files = ['model.json'];
for (let i = 1; i <= 55; i++) files.push(`group${i}-shard1of1`);

if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, {recursive: true});

function download(filename) {
    return new Promise((resolve, reject) => {
        const dest = path.join(DEST_DIR, filename);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            process.stdout.write(`  [skip] ${filename}\n`);
            return resolve();
        }
        const url = BASE_URL + filename;
        process.stdout.write(`  [dl]   ${filename} … `);
        const file = fs.createWriteStream(dest);
        https.get(url, res => {
            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    process.stdout.write(`done (${fs.statSync(dest).size} bytes)\n`);
                    resolve();
                });
            });
        }).on('error', err => {
            file.close();
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            reject(err);
        });
    });
}

(async () => {
    console.log(`Downloading ${files.length} files to:\n  ${DEST_DIR}\n`);
    for (const f of files) {
        await download(f);   // sequential — avoids hammering GCS
    }
    console.log('\nDone. MobileNetV1 model is ready for local serving.');
})().catch(err => {
    console.error('\nDownload failed:', err.message);
    process.exit(1);
});
