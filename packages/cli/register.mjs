import { register } from 'node:module';

// Only register the @/ alias resolver here.
// tsx is loaded separately via --import tsx in the node command.
register('./alias-loader.mjs', import.meta.url);
