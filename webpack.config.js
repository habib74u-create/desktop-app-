const path = require('path');
const webpack = require('webpack');

const isDev = process.env.NODE_ENV === 'development';

/** @type {import('webpack').Configuration} */
module.exports = {
  mode: isDev ? 'development' : 'production',
  target: 'electron-main',
  entry: {
    main: './src/main.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              configFile: false,
              compilerOptions: {
                module: 'commonjs',
                target: 'es2020',
                moduleResolution: 'node',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                skipLibCheck: true,
                resolveJsonModule: true,
                jsx: 'react',
                lib: ['ES2020', 'DOM'],
                types: ['node'],
                sourceMap: false
              }
            }
          }
        ]
      },
      {
        test: /\.node$/,
        use: 'node-loader'
      }
    ]
  },
  externals: {
    'uiohook-napi': 'commonjs uiohook-napi',
    'typing_monitor': 'commonjs typing_monitor',
    'audio_capture': 'commonjs audio_capture',
    'fn_key_monitor': 'commonjs fn_key_monitor',
    'universal_key_monitor': 'commonjs universal_key_monitor',
    'nsevent_monitor': 'commonjs nsevent_monitor',
    'sherpa-onnx-node': 'commonjs sherpa-onnx-node',
    'whisper-node-addon': 'commonjs whisper-node-addon',
    'bufferutil': 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate',
    'electron': 'commonjs electron',
    'fluent-ffmpeg': 'commonjs fluent-ffmpeg'
  },
  node: {
    __dirname: false,
    __filename: false
  },
  devtool: isDev ? 'source-map' : false,
  optimization: {
    minimize: false
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
    })
  ],
  stats: {
    errorDetails: true
  }
};
