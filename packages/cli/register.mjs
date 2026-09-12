import * as module from 'node:module';
import { resolve } from './alias-loader.mjs';

// Only register the @/ alias resolver here.
// tsx is loaded separately via --import tsx in the node command.
if (typeof module.registerHooks === 'function') {
  module.registerHooks({ resolve });
} else {
  module.register('./alias-loader.mjs', import.meta.url);
}
