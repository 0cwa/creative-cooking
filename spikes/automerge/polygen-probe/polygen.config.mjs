import { localModule, polygenConfig } from '@callstack/polygen-config';

export default polygenConfig({
  output: {
    directory: 'generated'
  },
  scan: {
    paths: ['src/**/*.wasm']
  },
  modules: [
    localModule('src/automerge.wasm')
  ]
});
