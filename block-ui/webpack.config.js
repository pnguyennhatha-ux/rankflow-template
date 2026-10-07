const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
const { OpdevManifestPlugin, opdevDevMiddleware } = require('./build/opdev-manifest');
const { loadEnv, PUBLIC_KEYS } = require('./build/env');
loadEnv();

const DEV_PORT = 8080;

/** @type {import('webpack').Configuration} */
module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: path.resolve(__dirname, 'src/index.tsx'),
    output: {
      path: path.resolve(__dirname, process.env.BLOCK_OUT_DIR || 'dist'),
      filename: isProd ? 'js/[name].[contenthash:8].js' : 'js/[name].js',
      clean: true,
      publicPath: '',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.json'],
      // bitable-api ships as ESM ("type":"module"); let webpack resolve it
      fullySpecified: false,
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: { transpileOnly: true },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        // Allow importing JSON demo data
        {
          test: /\.json$/,
          type: 'json',
        },
        // Transpile ESM bitable-api if needed
        {
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        inject: 'body',
      }),
      // Emits dist/project.config.json + dist/block.json from ./app.json + ./block.json (see build/opdev-manifest.js)
      new OpdevManifestPlugin(),
      new webpack.DefinePlugin(Object.fromEntries(PUBLIC_KEYS.map((k) => [`process.env.${k}`, JSON.stringify(process.env[k] || '')]))),
    ],
    devServer: {
      port: DEV_PORT,
      hot: true,
      historyApiFallback: true,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      setupMiddlewares: (middlewares, devServer) => {
        if (devServer) {
          middlewares.unshift(opdevDevMiddleware(devServer, DEV_PORT));
        }
        return middlewares;
      },
    },
    // No source maps in the uploaded package (keeps the opdev bundle small).
    devtool: isProd ? false : 'eval-cheap-module-source-map',
    performance: { hints: false },
  };
};
