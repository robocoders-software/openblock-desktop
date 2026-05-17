#!/usr/bin/env node
/**
 * Downloads the Universal Sentence Encoder TF.js model into:
 *   external-resources/models/universal-sentence-encoder/
 *
 * Run once before first use:  node scripts/download-use-model.js
 * After this the text classifier works fully offline.
 *
 * Files are served at runtime via robocoders-resource://models/universal-sentence-encoder/
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const DEST_DIR = path.resolve(
    __dirname, '..', 'external-resources', 'models', 'universal-sentence-encoder'
);

/* Public GCS bucket — same base the @tensorflow-models/universal-sentence-encoder
   package already uses for its vocab; no auth required */
const GCS_BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/universal_sentence_encoder';

if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, {recursive: true});

/* ── HTTP(S) GET with redirect following ── */
function get (rawUrl) {
    return new Promise((resolve, reject) => {
        const parsed  = new url.URL(rawUrl);
        const client  = parsed.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsed.hostname,
            path:     parsed.pathname + parsed.search,
            headers:  {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept':     '*/*'
            }
        };
        client.get(options, res => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                return resolve(get(res.headers.location));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/* ── Download one file (skip if already present and non-empty) ── */
async function download (srcUrl, destPath, label) {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        process.stdout.write(`  [skip] ${label}\n`);
        return;
    }
    process.stdout.write(`  [dl]   ${label} … `);
    const buf = await get(srcUrl);
    fs.writeFileSync(destPath, buf);
    process.stdout.write(`done (${(buf.length / 1024).toFixed(0)} KB)\n`);
}

(async () => {
    console.log('Universal Sentence Encoder — model download');
    console.log(`Source : ${GCS_BASE}`);
    console.log(`Dest   : ${DEST_DIR}\n`);

    /* 1. Fetch model.json */
    const modelJsonPath = path.join(DEST_DIR, 'model.json');
    let modelJson;
    if (fs.existsSync(modelJsonPath) && fs.statSync(modelJsonPath).size > 0) {
        process.stdout.write(`  [skip] model.json\n`);
        modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
    } else {
        process.stdout.write(`  [dl]   model.json … `);
        const buf = await get(`${GCS_BASE}/model.json`);
        fs.writeFileSync(modelJsonPath, buf);
        process.stdout.write(`done (${buf.length} bytes)\n`);
        modelJson = JSON.parse(buf.toString('utf8'));
    }

    /* 2. Extract shard paths from weightsManifest */
    const shardPaths = (modelJson.weightsManifest || []).flatMap(g => g.paths || []);
    if (shardPaths.length === 0) {
        console.warn('  [warn] No weight shards found in model.json.');
    }

    /* 3. Download each shard */
    for (const shardFile of shardPaths) {
        await download(
            `${GCS_BASE}/${shardFile}`,
            path.join(DEST_DIR, shardFile),
            shardFile
        );
    }

    /* 4. Download vocabulary */
    await download(
        `${GCS_BASE}/vocab.json`,
        path.join(DEST_DIR, 'vocab.json'),
        'vocab.json'
    );

    const totalBytes = fs.readdirSync(DEST_DIR).reduce((s, f) => {
        try { return s + fs.statSync(path.join(DEST_DIR, f)).size; } catch (_) { return s; }
    }, 0);

    console.log(`\nDone. ~${(totalBytes / 1024 / 1024).toFixed(1)} MB total.`);
    console.log('The text classifier will now work fully offline.');
})().catch(err => {
    console.error('\nDownload failed:', err.message);
    process.exit(1);
});
