FROM node:20-slim

RUN apt-get update && apt-get install -y tmux curl asciinema && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/project/src/components /app/project/src/utils /app/project/src/styles /app/project/public

# ── package.json with webpack dependencies ────────────────
COPY <<'EOF' /app/project/package.json
{
  "name": "dashboard-app",
  "version": "2.1.0",
  "private": true,
  "scripts": {
    "build": "webpack --mode production --config webpack.config.js",
    "dev": "webpack serve --mode development --config webpack.config.js"
  },
  "dependencies": {
    "chart.js": "^4.4.0",
    "date-fns": "^3.0.0"
  },
  "devDependencies": {
    "@babel/core": "^7.23.0",
    "@babel/preset-env": "^7.23.0",
    "babel-loader": "^9.1.3",
    "css-loader": "^6.8.1",
    "css-minimizer-webpack-plugin": "^5.0.1",
    "dotenv-webpack": "^8.0.1",
    "html-webpack-plugin": "^5.5.3",
    "mini-css-extract-plugin": "^2.7.6",
    "style-loader": "^3.3.3",
    "webpack": "^5.89.0",
    "webpack-cli": "^5.1.4",
    "webpack-dev-server": "^4.15.1"
  }
}
EOF

# ── webpack.config.js (complex, accumulated) ─────────────
COPY <<'JSEOF' /app/project/webpack.config.js
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const Dotenv = require('dotenv-webpack');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: './src/index.js',

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProd ? '[name].[contenthash:8].js' : '[name].js',
      chunkFilename: isProd ? '[name].[contenthash:8].chunk.js' : '[name].chunk.js',
      clean: true,
      publicPath: '/',
    },

    resolve: {
      alias: {
        '@components': path.resolve(__dirname, 'src/components'),
        '@utils': path.resolve(__dirname, 'src/utils'),
        '@styles': path.resolve(__dirname, 'src/styles'),
      },
      extensions: ['.js', '.json'],
    },

    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              cacheDirectory: true,
            },
          },
        },
        {
          test: /\.css$/,
          use: [
            isProd ? MiniCssExtractPlugin.loader : 'style-loader',
            {
              loader: 'css-loader',
              options: {
                modules: {
                  auto: true,
                  localIdentName: isProd
                    ? '[hash:base64:8]'
                    : '[name]__[local]--[hash:base64:5]',
                },
              },
            },
          ],
        },
      ],
    },

    plugins: [
      new HtmlWebpackPlugin({
        template: './public/index.html',
        minify: isProd ? {
          collapseWhitespace: true,
          removeComments: true,
        } : false,
      }),
      ...(isProd ? [
        new MiniCssExtractPlugin({
          filename: '[name].[contenthash:8].css',
        }),
      ] : []),
      new Dotenv({
        systemvars: true,
        defaults: true,
      }),
    ],

    optimization: {
      minimizer: ['...', new CssMinimizerPlugin()],
      splitChunks: {
        chunks: 'all',
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            priority: 10,
          },
          common: {
            minChunks: 2,
            name: 'common',
            priority: 5,
            reuseExistingChunk: true,
          },
        },
      },
    },

    devServer: {
      port: 3000,
      hot: true,
      historyApiFallback: true,
    },
  };
};
JSEOF

# ── babel.config.js ───────────────────────────────────────
COPY <<'JSEOF' /app/project/babel.config.js
module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: '> 0.25%, not dead',
      useBuiltIns: 'usage',
      corejs: 3,
    }],
  ],
};
JSEOF

# ── .env (environment variables) ──────────────────────────
COPY <<'EOF' /app/project/.env
API_BASE_URL=https://api.dashboard.example.com/v2
APP_TITLE=Dashboard Pro
ANALYTICS_ENABLED=true
EOF

# ── public/index.html ────────────────────────────────────
COPY <<'EOF' /app/project/public/index.html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard App</title>
</head>
<body>
  <div id="app"></div>
</body>
</html>
EOF

# ── Source files ──────────────────────────────────────────
COPY <<'JSEOF' /app/project/src/index.js
import { Dashboard } from '@components/dashboard';
import { formatDate } from '@utils/helpers';
import '@styles/main.css';

const app = document.getElementById('app');

const dashboard = new Dashboard({
  title: process.env.APP_TITLE || 'Dashboard',
  apiUrl: process.env.API_BASE_URL,
});

app.innerHTML = dashboard.render();
console.log('App initialized at', formatDate(new Date()));
JSEOF

COPY <<'JSEOF' /app/project/src/components/dashboard.js
import { formatNumber } from '@utils/helpers';

export class Dashboard {
  constructor(config) {
    this.title = config.title;
    this.apiUrl = config.apiUrl;
  }

  render() {
    return `
      <div class="dashboard">
        <h1>${this.title}</h1>
        <div class="stats">
          <div class="stat-card">
            <span class="label">Users</span>
            <span class="value">${formatNumber(15420)}</span>
          </div>
          <div class="stat-card">
            <span class="label">Revenue</span>
            <span class="value">$${formatNumber(284930)}</span>
          </div>
        </div>
        <p class="api-info">API: ${this.apiUrl}</p>
      </div>
    `;
  }
}
JSEOF

COPY <<'JSEOF' /app/project/src/components/chart.js
export class Chart {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.data = data;
  }

  draw() {
    return {
      type: 'bar',
      labels: this.data.map(d => d.label),
      values: this.data.map(d => d.value),
    };
  }
}
JSEOF

COPY <<'JSEOF' /app/project/src/utils/helpers.js
import { format } from 'date-fns';

export function formatDate(date) {
  return format(date, 'yyyy-MM-dd');
}

export function formatNumber(num) {
  return num.toLocaleString('en-US');
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
JSEOF

COPY <<'JSEOF' /app/project/src/utils/api.js
const BASE_URL = process.env.API_BASE_URL || '';

export async function fetchData(endpoint) {
  const resp = await fetch(`${BASE_URL}${endpoint}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export function buildUrl(path, params = {}) {
  const url = new URL(path, BASE_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}
JSEOF

COPY <<'EOF' /app/project/src/styles/main.css
.dashboard {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.dashboard h1 {
  color: #1a1a2e;
  font-size: 2rem;
  margin-bottom: 1.5rem;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: #f8f9fa;
  border-radius: 8px;
  padding: 1.5rem;
  border: 1px solid #e9ecef;
}

.stat-card .label {
  display: block;
  color: #6c757d;
  font-size: 0.875rem;
  text-transform: uppercase;
}

.stat-card .value {
  display: block;
  font-size: 1.75rem;
  font-weight: 700;
  color: #1a1a2e;
  margin-top: 0.25rem;
}

.api-info {
  color: #adb5bd;
  font-size: 0.75rem;
}
EOF

# ── Install dependencies (webpack build must work) ────────
RUN cd /app/project && npm install 2>&1

# ── Verify webpack build works ────────────────────────────
RUN cd /app/project && npm run build 2>&1 || true  # build-verify non-fatal

WORKDIR /app/project
