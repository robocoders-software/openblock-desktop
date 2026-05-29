const path = require('path');
const fs   = require('fs');
const {execSync} = require('child_process');

const CopyWebpackPlugin = require('copy-webpack-plugin');

const makeConfig = require('./webpack.makeConfig.js');

/* Ensure ML assets exist before webpack starts.
   If missing, run the download scripts automatically so every build path
   (build:dev / build:dir / build:dist / dist) includes the required files. */
const mlAssets = [
    {
        check: path.resolve(__dirname, 'external-resources', 'libs', 'speech-commands.min.js'),
        script: 'scripts/download-speech-commands.js',
        label: 'speech-commands'
    },
    {
        check: path.resolve(__dirname, 'external-resources', 'models', 'mobilenet_v1_0.25_224', 'model.json'),
        script: 'scripts/download-mobilenet.js',
        label: 'mobilenet'
    }
];
for (const asset of mlAssets) {
    if (!fs.existsSync(asset.check)) {
        console.log(`[webpack] ${asset.label} assets missing — running ${asset.script}…`);
        try {
            execSync(`node ${asset.script}`, {cwd: __dirname, stdio: 'inherit'});
        } catch (e) {
            console.error(`[webpack] WARNING: ${asset.script} failed:`, e.message);
            console.error(`[webpack] ${asset.label} will not work until assets are downloaded.`);
        }
    }
}

// Fixed the issue that when using link to local gui package in node16, an error message appears saying that the
// blocks vm package in gui cannot be found.
const getModulePath = moduleName => {
    try {
        return path.dirname(require.resolve(`${moduleName}/package.json`));
    } catch (e) {
        try {
            const openblockGuiPath = path.dirname(require.resolve('openblock-gui/package.json'));
            return path.resolve(openblockGuiPath, 'node_modules', moduleName);
        } catch (err) {
            throw new Error(`Module ${moduleName} could not be resolved. Ensure it is installed or linked properly.`);
        }
    }
};

module.exports = defaultConfig =>
    makeConfig(
        defaultConfig,
        {
            name: 'renderer',
            useReact: true,
            disableDefaultRulesForExtensions: ['js', 'jsx', 'css', 'svg', 'png', 'wav', 'gif', 'jpg', 'ttf'],
            babelPaths: [
                path.resolve(__dirname, 'src', 'renderer'),
                /node_modules[\\/]+scratch-[^\\/]+[\\/]+src/,
                /node_modules[\\/]+openblock-[^\\/]+[\\/]+src/,
                /node_modules[\\/]+pify/,
                /node_modules[\\/]+@vernier[\\/]+godirect/,
                path.resolve(__dirname, '../openblock-vm/src'),
                // Windows junctions resolve to real paths; include those too so babel transpiles them
                path.resolve(__dirname, '../openblock-gui/src'),
                path.resolve(__dirname, '../openblock-ml-studio/src')
            ],
            plugins: [
                new CopyWebpackPlugin([{
                    from: path.join(getModulePath('openblock-blocks'), 'media'),
                    to: 'static/blocks-media'
                }]),
                new CopyWebpackPlugin([{
                    from: 'extension-worker.{js,js.map}',
                    context: path.join(getModulePath('openblock-vm'), 'dist', 'web')
                }]),
                new CopyWebpackPlugin([{
                    from: path.join(getModulePath('openblock-gui'), 'src', 'lib', 'libraries', '*.json'),
                    to: 'static/libraries',
                    flatten: true
                }])
            ]
        }
    );
