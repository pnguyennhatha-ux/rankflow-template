/**
 * Local replacement for @lark-opdev/block-bitable-webpack-utils' BitableAppWebpackPlugin + opdevMiddleware.
 *
 * Why: that plugin resolves `process.cwd()/../app.json` (template layout `<root>/app.json` +
 * `<root>/extension/block.json`), so in this flat layout the build crashed with ENOENT, and the old
 * workaround copied a hand-written project.config.json over the plugin's output — which is how the
 * uploaded app id drifted to another app. Here everything is read from THIS folder, relative to
 * __dirname (not cwd):
 *   app.json   → appId (single source of truth for the app)
 *   block.json → blockTypeID / blockRenderType / projectName / dev Base url
 * and dist/ gets the layout `opdev upload -t block` reads:
 *   dist/project.config.json  { appid, projectname, blocks: ["block"] }
 *   dist/block.json           { blockTypeID, blockRenderType, ... }   (resolved from blocks[] + ".json")
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { loadEnv } = require('./env');
loadEnv();
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

function readManifests() {
  const app = readJson('app.json');
  const block = readJson('block.json');
  // env wins over the placeholder values committed in app.json / block.json
  if (process.env.LARK_APP_ID) app.appId = process.env.LARK_APP_ID;
  if (process.env.BLOCK_TYPE_ID) block.blockTypeID = process.env.BLOCK_TYPE_ID;
  if (process.env.RANKFLOW_BASE_URL) block.url = process.env.RANKFLOW_BASE_URL;
  if (!app.appId) throw new Error('app.json: appId missing');
  if (!block.blockTypeID) throw new Error('block.json: blockTypeID missing');
  const blockInfo = {
    manifestVersion: block.manifestVersion || 1,
    blockTypeID: block.blockTypeID,
    blockRenderType: block.blockRenderType || 'offlineWeb',
    projectName: block.projectName,
  };
  if (block.offlineWebConfig) blockInfo.offlineWebConfig = block.offlineWebConfig;
  return {
    projectConfig: { appid: app.appId, projectname: block.projectName, blocks: ['block'] },
    blockInfo,
    bitableUrl: block.url,
  };
}

class OpdevManifestPlugin {
  apply(compiler) {
    const { RawSource } = compiler.webpack.sources;
    const { Compilation } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('OpdevManifestPlugin', (compilation) => {
      for (const name of ['app.json', 'block.json']) compilation.fileDependencies.add(path.join(ROOT, name));
      compilation.hooks.processAssets.tap(
        { name: 'OpdevManifestPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          const { projectConfig, blockInfo } = readManifests();
          compilation.emitAsset('project.config.json', new RawSource(JSON.stringify(projectConfig, null, 2) + '\n'));
          compilation.emitAsset('block.json', new RawSource(JSON.stringify(blockInfo, null, 2) + '\n'));
        },
      );
    });
  }
}

/**
 * Dev-server middleware equivalent of opdevMiddleware (CSP from the app's console settings + the
 * Blockit dev bridge used when the Base loads the block from localhost), fed from local manifests.
 * Needs `opdev login`; if it fails the dev server still serves the bundle (with a warning).
 */
function opdevDevMiddleware(devServer, port) {
  let handler = null;
  (async () => {
    const api = require('@lark-opdev/cli/libs/api').default;
    const { dev } = await api.init();
    const { projectConfig, blockInfo } = readManifests();
    const csp = await dev.getAppCSPConfig(projectConfig.appid).catch(() => null);
    const blockit = await dev.getBlockitDevMiddleware({
      projectConfig,
      blockConfigMap: { [blockInfo.blockTypeID]: blockInfo },
      devServerHost: `http://localhost:${port}`,
      basePath: devServer.compiler.options.output.publicPath || './',
    });
    handler = (req, res, next) => {
      if (csp) res.setHeader('Content-Security-Policy', csp);
      blockit(req, res, next);
    };
  })().catch((err) => console.warn(`[opdev] dev middleware disabled: ${err && err.message}`));
  return (req, res, next) => (handler ? handler(req, res, next) : next());
}

module.exports = { OpdevManifestPlugin, opdevDevMiddleware, readManifests };
