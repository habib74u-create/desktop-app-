// webpack.config.js
'use strict';

const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { ESBuildMinifyPlugin } = require('esbuild-loader');

const isDev = process.env.NODE_ENV === 'development';
const isProd = !isDev;

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

/** Shared resolve config */
const resolve = {
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs'],
  alias: {
    '@': path.join(SRC),
    '@core': path.join(SRC, 'core'),
    '@services': path.join(SRC, 'services'),
    '@ipc': path.join(SRC, 'ipc'),
    '@audio': path.join(SRC, 'audio'),
    '@input': path.join(SRC, 'input'),
    '@utils': path.join(SRC, 'utils'),
    '@renderer': path.join(SRC, 'renderer'),
  },
};

/** Shared module rules */
const rules = [
  {
    test: /\.tsx?$/,
    exclude: /node_modules/,
    use: [
      {
        loader: 'ts-loader',
        options: {
          transpileOnly: isDev, // fast dev builds; type-check separately via `tsc --noEmit`
          compilerOptions: isDev ? { sourceMap: true } : {},
        },
      },
    ],
  },
  {
    test: /\.node$/,
    use: 'node-loader',
  },
  {
    test: /\.(png|jpe?g|gif|svg|webp|ico)$/i,
    type: 'asset/resource',
    generator: { filename: 'assets/[name][ext]' },
  },
  {
    test: /\.(mp3|wav|ogg|flac)$/i,
    type: 'asset/resource',
    generator: { filename: 'assets/sounds/[name][ext]' },
  },
  {
    test: /\.(woff2?|eot|ttf|otf)$/i,
    type: 'asset/resource',
    generator: { filename: 'assets/fonts/[name][ext]' },
  },
];

/** Plugins shared by main + preload */
const sharedPlugins = [
  new webpack.DefinePlugin({
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
    __DEV__: JSON.stringify(isDev),
  }),
];

/* -------------------------------------------------------------------------- */
/* 1. Main process                                                            */
/* -------------------------------------------------------------------------- */
const mainConfig = {
  name: 'main',
  target: 'electron-main',
  mode: isDev ? 'development' : 'production',
  entry: { main: path.join(SRC, 'main.ts') },
  output: {
    path: DIST,
    filename: '[name].js',
    library: { type: 'commonjs2' },
    clean: false,
  },
  resolve,
  module: { rules },
  plugins: sharedPlugins,
  node: {
    __dirname: false,
    __filename: false,
  },
  externals: {
    // Keep native modules external — they're resolved at runtime from node_modules
    'better-sqlite3': 'commonjs better-sqlite3',
    'node-pty': 'commonjs node-pty',
    fsevents: 'commonjs fsevents',
  },
  optimization: {
    minimize: isProd,
    minimizer: isProd ? [new ESBuildMinifyPlugin({ target: 'node18' })] : [],
  },
  devtool: isDev ? 'source-map' : false,
  stats: 'minimal',
  infrastructureLogging: { level: 'warn' },
};

/* -------------------------------------------------------------------------- */
/* 2. Preload script                                                          */
/* -------------------------------------------------------------------------- */
const preloadConfig = {
  name: 'preload',
  target: 'electron-preload',
  mode: isDev ? 'development' : 'production',
  entry: { preload: path.join(SRC, 'preload.ts') },
  output: {
    path: DIST,
    filename: '[name].js',
    library: { type: 'commonjs2' },
    clean: false,
  },
  resolve,
  module: { rules },
  plugins: sharedPlugins,
  node: { __dirname: false, __filename: false },
  optimization: {
    minimize: isProd,
    minimizer: isProd ? [new ESBuildMinifyPlugin({ target: 'node18' })] : [],
  },
  devtool: isDev ? 'source-map' : false,
  stats: 'minimal',
};

/* -------------------------------------------------------------------------- */
/* 3. Renderer (React)                                                        */
/* -------------------------------------------------------------------------- */
const rendererConfig = {
  name: 'renderer',
  target: 'electron-renderer',
  mode: isDev ? 'development' : 'production',
  entry: { renderer: path.join(SRC, 'renderer', 'index.tsx') },
  output: {
    path: path.join(DIST, 'renderer'),
    filename: '[name].js',
    chunkFilename: '[name].[contenthash:8].chunk.js',
    assetModuleFilename: 'assets/[name].[contenthash:8][ext]',
    publicPath: './',
    clean: true,
  },
  resolve,
  module: {
    rules: [
      ...rules,
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader', 'postcss-loader'],
      },
      {
        test: /\.s[ac]ss$/i,
        use: ['style-loader', 'css-loader', 'postcss-loader', 'sass-loader'],
      },
    ],
  },
  plugins: [
    ...sharedPlugins,
    new HtmlWebpackPlugin({
      template: path.join(SRC, 'renderer', 'index.html'),
      filename: 'index.html',
      inject: 'body',
      minify: isProd && {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        useShortDoctype: true,
        minifyCSS: true,
        minifyJS: true,
      },
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.join(ROOT, 'assets', 'sounds'),
          to: path.join(DIST, 'renderer', 'sounds'),
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
  optimization: {
    minimize: isProd,
    minimizer: isProd ? [new ESBuildMinifyPlugin({ target: 'chrome120' })] : [],
    splitChunks: isProd
      ? {
          chunks: 'all',
          cacheGroups: {
            vendors: {
              test: /[\\/]node_modules[\\/]/,
              name: 'vendors',
              priority: -10,
            },
          },
        }
      : false,
    runtimeChunk: false,
  },
  devtool: isDev ? 'source-map' : false,
  stats: 'minimal',
  performance: { hints: false },
};

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */
module.exports = [mainConfig, preloadConfig, rendererConfig];