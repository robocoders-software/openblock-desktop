const path = require('path');

const makeConfig = require('./webpack.makeConfig.js');

module.exports = defaultConfig => {
    const config = makeConfig(
        defaultConfig,
        {
            name: 'main',
            useReact: false,
            disableDefaultRulesForExtensions: ['js'],
            babelPaths: [
                path.resolve(__dirname, 'src', 'main')
            ]
        }
    );

    // openblock-resource and openblock-link use require-all with runtime filesystem paths.
    // Webpack can't resolve these dynamic paths at compile time, so keep them as Node externals.
    const existing = Array.isArray(config.externals) ? config.externals : [];
    config.externals = [...existing, 'openblock-resource', 'openblock-link'];

    return config;
};
