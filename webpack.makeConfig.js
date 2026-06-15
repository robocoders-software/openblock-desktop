const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const electronPath = require('electron');
const webpack = require('webpack');
const merge = require('webpack-merge');

const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const MONACO_DIR = path.resolve(__dirname, './node_modules/monaco-editor');

// PostCss
const autoprefixer = require('autoprefixer');
const postcssVars = require('postcss-simple-vars');
const postcssImport = require('postcss-import');

const isProduction = (process.env.NODE_ENV === 'production');

const electronVersion = childProcess.execFileSync(electronPath, ['--version'], {encoding: 'utf8'}).trim();
console.log(`Targeting Electron ${electronVersion}`); // eslint-disable-line no-console

const makeConfig = function (defaultConfig, options) {
    const babelOptions = {
        // Explicitly disable babelrc so we don't catch various config in much lower dependencies.
        babelrc: false,
        plugins: [
            '@babel/plugin-syntax-dynamic-import',
            '@babel/plugin-transform-async-to-generator',
            '@babel/plugin-proposal-object-rest-spread'
        ],
        presets: [
            ['@babel/preset-env', {targets: {electron: electronVersion}}]
        ]
    };

    const sourceFileTest = options.useReact ? /\.jsx?$/ : /\.js$/;
    if (options.useReact) {
        babelOptions.presets = babelOptions.presets.concat('@babel/preset-react');
        babelOptions.plugins.push('react-intl');
    }

    // TODO: consider adjusting these rules instead of discarding them in at least some cases
    if (options.disableDefaultRulesForExtensions) {
        defaultConfig.module.rules = defaultConfig.module.rules.filter(rule => {
            if (!(rule.test instanceof RegExp)) {
                // currently we don't support overriding other kinds of rules
                return true;
            }
            // disable default rules for any file extension listed here
            // we will handle these files in some other way (see below)
            // OR we want to avoid any processing at all (such as with fonts)
            const shouldDisable = options.disableDefaultRulesForExtensions.some(
                ext => rule.test.test(`test.${ext}`)
            );
            const statusWord = shouldDisable ? 'Discarding' : 'Keeping';
            console.log(`${options.name}: ${statusWord} electron-webpack default rule for ${rule.test}`);
            return !shouldDisable;
        });
    }

    // Local file:-linked packages are externalized by electron-webpack because they appear in
    // package.json dependencies, but they contain ES module source that must be bundled and
    // transpiled by babel. Remove them from the externals list so webpack processes them.
    if (Array.isArray(defaultConfig.externals)) {
        defaultConfig.externals = defaultConfig.externals.filter(
            ext => typeof ext !== 'string' || !/^openblock-/.test(ext)
        );
    }

    const config = merge.smart(defaultConfig, {
        devtool: 'cheap-module-eval-source-map',
        mode: isProduction ? 'production' : 'development',
        module: {
            rules: [
                {
                    test: sourceFileTest,
                    include: options.babelPaths,
                    loader: 'babel-loader',
                    options: babelOptions
                },
                { // coped from scratch-gui
                    test: /\.css$/,
                    exclude: MONACO_DIR,
                    use: [{
                        loader: 'style-loader'
                    }, {
                        loader: 'css-loader',
                        options: {
                            modules: true,
                            importLoaders: 1,
                            localIdentName: '[name]_[local]_[hash:base64:5]',
                            camelCase: true
                        }
                    }, {
                        loader: 'postcss-loader',
                        options: {
                            ident: 'postcss',
                            plugins: function () {
                                return [
                                    postcssImport,
                                    postcssVars,
                                    autoprefixer
                                ];
                            }
                        }
                    }]
                },
                {
                    test: /\.(svg|png|wav|gif|jpg|ttf)$/,
                    loader: 'file-loader',
                    options: {
                        outputPath: 'static/assets/'
                    }
                },
                {
                    test: /\.css$/,
                    include: MONACO_DIR,
                    use: ['style-loader', 'css-loader']
                },
                {
                    test: /node_modules[/\\](iconv-lite)[/\\].+/,
                    resolve: {
                        aliasFields: ['main']
                    }
                }
            ]
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.GA_ID': `"${process.env.GA_ID || 'UA-000000-01'}"`
            }),
            new webpack.SourceMapDevToolPlugin({
                filename: '[file].map'
            }),
            new MonacoWebpackPlugin({
                languages: ['c', 'cpp', 'python', 'lua', 'javascript'],
                features: ['!gotoSymbol']
            })
        ].concat(options.plugins || []),
        resolve: {
            cacheWithContext: false,
            symlinks: false,
            // Local packages are aliased to sibling-repo source paths (outside node_modules).
            // Ensure their imports still resolve against openblock-desktop's dependencies.
            modules: [
                path.resolve(__dirname, 'node_modules'),
                path.resolve(__dirname, '../openblock-gui/node_modules'),
                path.resolve(__dirname, '../openblock-blocks/node_modules'),
                'node_modules'
            ],
            alias: {
                // Use real (non-junction) paths so Windows junctions don't hide files from
                // babel-loader include checks. Each local package needs its own alias pair.
                'openblock-gui$': path.resolve(__dirname, '../openblock-gui/src/index.js'),
                'openblock-gui/src': path.resolve(__dirname, '../openblock-gui/src'),
                'openblock-ml-studio$': path.resolve(__dirname, '../openblock-ml-studio/src/index.js'),
                'openblock-ml-studio/src': path.resolve(__dirname, '../openblock-ml-studio/src'),
                // Use local VM source so teachableMachine extension and all VM changes are live
                'openblock-vm$': path.resolve(__dirname, '../openblock-vm/src/index.js'),
                'openblock-vm/src': path.resolve(__dirname, '../openblock-vm/src'),
                // Force all packages (including openblock-gui which has its own node_modules/react)
                // to use the same single React copy so hooks work correctly.
                'react': path.resolve(__dirname, 'node_modules/react'),
                'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
                // Force a single immutable copy so OrderedMap instanceof checks don't fail.
                // openblock-gui and openblock-vm each have their own node_modules/immutable;
                // without this alias webpack bundles all three copies and Redux's OrderedMap
                // fails the MonitorList prop-type check, breaking blocks rendering.
                'immutable': path.resolve(__dirname, 'node_modules/immutable')
            }
        }
    });

    // If we're not on CI, enable Webpack progress output
    // Note that electron-webpack enables this by default, so use '--no-progress' to avoid double-adding this plugin
    if (!process.env.CI) {
        config.plugins.push(new webpack.ProgressPlugin());
    }

    fs.writeFileSync(
        `dist/webpack.${options.name}.js`,
        `module.exports = ${util.inspect(config, {depth: null})};\n`
    );

    return config;
};

module.exports = makeConfig;
