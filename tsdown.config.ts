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
    dts: true,
  },
]);
