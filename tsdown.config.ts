import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      image: 'src/image.ts',
      'rpc-contract': 'src/rpc-contract.ts',
      'project-context': 'src/project-context.ts',
      'wire-identity': 'src/wire-identity.ts',
      invariant: 'src/invariant.ts',
      'llm-adapter': 'src/llm-adapter.ts',
      'private-transport': 'src/private-transport.ts',
      replay: 'src/replay.ts',
      quota: 'src/quota.ts',
      'media-admission': 'src/media-admission.ts',
    },
    format: ['esm'],
    outDir: 'lib',
    clean: false,
    dts: true,
  },
  {
    entry: {
      client: 'src/client/index.ts',
    },
    format: ['cjs'],
    outDir: 'lib',
    clean: false,
    banner: 'var __defLoader__ = (typeof window !== "undefined" && window.__ModuleLoader__) ? window.__ModuleLoader__.load.bind(window.__ModuleLoader__) : function(m) { Object.assign(module.exports, m.factory(require)); };\n__defLoader__({ id: "dsh-tool-antigravity", factory: function(require) {\nvar module = { exports: {} };\nvar exports = module.exports;\n',
    footer: '\nreturn module.exports;\n}});\n',
  },
]);
