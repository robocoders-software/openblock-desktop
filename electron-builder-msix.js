// TEST-ONLY MSIX (Microsoft Store package) build. Reuses electron-builder.yaml and changes only
// what an MSIX needs; the normal NSIS installer build doesn't touch this file. See build-msix.yml.
const fs = require('fs');
const yaml = require('js-yaml');

const config = yaml.load(fs.readFileSync(`${__dirname}/electron-builder.yaml`, 'utf8'));

config.win.target = ['appx'];

// An MSIX install folder is read-only, so board packs can't be extracted at runtime. For this test,
// ship the Arduino AVR toolchain (+ arduino-cli's builtin tools) pre-extracted and leave the rest out.
config.extraFiles = config.extraFiles
    .filter(f => f.from !== 'board-packs')
    .map(f => (f.from === 'tools' ?
        {...f, filter: ['**', '!Arduino/packages/{esp32,esp8266,rp2040,Maixduino,SparkFun}/**']} :
        f));

// Real Store values come from Partner Center when the app is reserved there. The identity name is
// kept short on purpose: it's part of the install path, and Windows' 260-char path limit applies.
config.appx = {
    applicationId: 'RoboCodersStudio',
    identityName: 'RoboCoders.MSIXTest',
    displayName: 'RoboCoders Studio (MSIX test)',
    publisher: 'CN=RoboCodersTest', // must equal the signing certificate's subject
    publisherDisplayName: 'RoboCoders'
};

module.exports = config;
